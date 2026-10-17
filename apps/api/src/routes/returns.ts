// החזרות וזיכויים (WF-03, RET-01..RET-06, DOC-03, T15..T18): מתוך המכירה המקורית, לא יותר ממה שנמכר,
// מסמך זיכוי מקושר, מלאי לפי גורל הפריט, והחזר כספי באמצעי המקורי או כשובר זיכוי.
import { can, israelDate, posReturnDocType, refundForLine, splitGross, withinReturnWindow } from '@dlx/core';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth, tx, verifySecret } from '../auth.js';
import { many, nextNumber, one } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { idemKey, idempotent } from '../idempotency.js';
import { issueDocument, loadTenant } from '../services/documents.js';
import { addMovement } from '../services/stock.js';
import { activeSession } from './cash.js';
import { loadSale } from './sales.js';

export const VOUCHER_VALID_YEARS = 2;

const ReturnIn = z.object({
  saleId: z.string().uuid(),
  registerId: z.string().uuid(),
  reason: z.string().min(2, 'צריך סיבה'),
  refundMethod: z.enum(['original', 'cash', 'credit_note']).default('original'),
  lines: z.array(z.object({ saleLineId: z.string().uuid(), qtyMilli: z.number().int().positive(), disposition: z.enum(['restock', 'damaged', 'supplier']).default('restock') })).min(1),
  approverPin: z.string().regex(/^\d{4,8}$/).optional(),
});

export async function returnRoutes(app: FastifyInstance) {
  app.get('/returns', { preHandler: requireAuth('pos:sell') }, async (req) => tx(req, (c) => many(c,
    `SELECT r.id, r.number, r.created_at, r.total_agorot, r.reason, r.refund_method, d.serial AS document_serial, d.doc_type AS document_type,
       sd.serial AS sale_document_serial, u.name AS cashier_name
     FROM returns r LEFT JOIN documents d ON d.id = r.document_id LEFT JOIN sales s ON s.id = r.sale_id LEFT JOIN documents sd ON sd.id = s.document_id
     LEFT JOIN users u ON u.id = r.cashier_id ORDER BY r.number DESC LIMIT 200`)));

  // איתור מכירה להחזרה לפי מספר מסמך / ברקוד קבלה (RET-01)
  app.get('/returns/lookup', { preHandler: requireAuth('pos:refund') }, async (req) => {
    const { q } = z.object({ q: z.string().min(1) }).parse(req.query);
    return tx(req, async (c) => {
      const s = await one(c,
        `SELECT s.id FROM sales s JOIN documents d ON d.id = s.document_id WHERE s.status = 'finalized' AND (d.serial::text = $1 OR s.id::text = $1) ORDER BY s.created_at DESC LIMIT 1`, [q.trim()]);
      if (!s) throw new AppError(404, 'not_found', 'לא נמצאה מכירה למספר הזה');
      const sale = await loadSale(c, s.id);
      return { ...sale, lines: sale.lines.map(({ unit_cost_agorot: _c, ...l }: any) => l) };
    });
  });

  app.post('/returns', { preHandler: requireAuth('pos:refund') }, async (req) => {
    const key = idemKey(req);
    const b = ReturnIn.parse(req.body);
    return tx(req, async (c) => (await idempotent(c, req.auth.tenantId, key, 'return.create', b, async () => {
      const sale = await one(c, 'SELECT * FROM sales WHERE id = $1 FOR UPDATE', [b.saleId]); // נעילה — שתי החזרות במקביל לא עוברות את הכמות
      if (!sale || sale.status !== 'finalized') throw new AppError(422, 'rule', 'אפשר להחזיר רק ממכירה שנסגרה');
      const tenant = await loadTenant(c, req.auth.tenantId);
      const reg = await one(c, 'SELECT * FROM registers WHERE id = $1', [b.registerId]);
      if (!reg) throw notFound('הקופה');
      const session = await activeSession(c, reg.id);
      if (!session) throw new AppError(409, 'no_session', 'אין משמרת פתוחה בקופה');

      // RET-06: מחוץ למדיניות (חלון ימים) — אישור מנהל
      let approvedBy: string | null = null;
      if (!withinReturnWindow(new Date(sale.finalized_at), new Date(), tenant.return_days)) {
        if (can(req.auth.role, 'pos:discount_override')) approvedBy = req.auth.userId;
        else if (b.approverPin) {
          for (const u of await many(c, 'SELECT id, role, pin_hash FROM users WHERE active AND pin_hash IS NOT NULL')) {
            if (can(u.role, 'pos:discount_override') && (await verifySecret(b.approverPin, u.pin_hash))) { approvedBy = u.id; break; }
          }
        }
        if (!approvedBy) throw new AppError(403, 'approval_required', `עברו יותר מ-${tenant.return_days} ימים מהקנייה. צריך אישור מנהל.`);
      }

      const saleObj = await loadSale(c, b.saleId);
      const doc = await one(c, 'SELECT * FROM documents WHERE id = $1', [sale.document_id]);
      const rLines: any[] = [];
      for (const l of b.lines) {
        const sl = saleObj.lines.find((x: any) => x.id === l.saleLineId);
        if (!sl) throw new AppError(422, 'rule', 'השורה לא שייכת למכירה');
        const total = refundForLine({ lineId: sl.id, qtyMilli: sl.qty_milli, total: sl.total_agorot, returnedQtyMilli: sl.returned_qty_milli, returnedTotal: sl.returned_total_agorot }, l.qtyMilli);
        const { net, vat } = splitGross(total, sl.rate_bp);
        rLines.push({ sl, qtyMilli: l.qtyMilli, total, net, vat, disposition: l.disposition });
        // פיקדון חוזר יחד עם המוצר
        const dep = saleObj.lines.find((x: any) => x.kind === 'deposit' && x.line_no === sl.line_no + 1);
        if (dep && sl.kind === 'item' && dep.returned_qty_milli + l.qtyMilli <= dep.qty_milli) {
          const dt = refundForLine({ lineId: dep.id, qtyMilli: dep.qty_milli, total: dep.total_agorot, returnedQtyMilli: dep.returned_qty_milli, returnedTotal: dep.returned_total_agorot }, l.qtyMilli);
          const s2 = splitGross(dt, dep.rate_bp);
          rLines.push({ sl: dep, qtyMilli: l.qtyMilli, total: dt, net: s2.net, vat: s2.vat, disposition: 'none' });
        }
      }
      const total = rLines.reduce((a, l) => a + l.total, 0);
      const net = rLines.reduce((a, l) => a + l.net, 0);
      const vat = rLines.reduce((a, l) => a + l.vat, 0);

      // RET-03, DOC-03: ההחזר הכספי — באמצעי המקורי (אשראי חוזר לאשראי), במזומן, או שובר זיכוי
      const salePays = saleObj.payments.filter((p: any) => p.direction === 'in' && p.status !== 'failed' && p.status !== 'voided');
      const cardPaid = salePays.filter((p: any) => p.method === 'card').reduce((a: number, p: any) => a + p.amount_agorot, 0);
      const refunds: { method: string; amount: number; pay?: any }[] = [];
      if (b.refundMethod === 'credit_note') refunds.push({ method: 'credit_note', amount: total });
      else if (b.refundMethod === 'cash') refunds.push({ method: 'cash', amount: total });
      else {
        let left = total;
        const prevCardRefunds = (await one(c, "SELECT COALESCE(SUM(p.amount_agorot),0) AS s FROM payments p JOIN returns r ON r.id = p.return_id WHERE r.sale_id = $1 AND p.method = 'card'", [b.saleId])).s;
        const cardLeft = Math.max(0, cardPaid - prevCardRefunds);
        const toCard = Math.min(left, cardLeft);
        if (toCard > 0) { refunds.push({ method: 'card', amount: toCard, pay: salePays.find((p: any) => p.method === 'card') }); left -= toCard; }
        if (left > 0) {
          const account = salePays.find((p: any) => p.method === 'customer_account');
          refunds.push({ method: account ? 'customer_account' : 'cash', amount: left });
        }
      }

      const number = await nextNumber(c, req.auth.tenantId, 'return');
      const ret = await one(c,
        `INSERT INTO returns (tenant_id, number, sale_id, branch_id, session_id, cashier_id, approved_by, reason, total_agorot, net_agorot, vat_agorot, refund_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [req.auth.tenantId, number, b.saleId, reg.branch_id, session.id, req.auth.userId, approvedBy, b.reason, total, net, vat, b.refundMethod]);
      for (const l of rLines) {
        await c.query(
          `INSERT INTO return_lines (tenant_id, return_id, sale_line_id, product_id, name, qty_milli, unit_price_agorot, total_agorot, rate_bp, net_agorot, vat_agorot, disposition)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [req.auth.tenantId, ret.id, l.sl.id, l.sl.product_id, l.sl.name, l.qtyMilli, l.sl.unit_price_agorot, l.total, l.sl.rate_bp, l.net, l.vat, l.disposition]);
        // RET-04, T17: תקין חוזר למלאי למכירה; פגום — למלאי פגום; לספק — לפגום עד שיוחזר
        if (l.sl.kind === 'item' && l.sl.product_id) {
          const p = await one(c, 'SELECT track_stock FROM products WHERE id = $1', [l.sl.product_id]);
          if (p?.track_stock) {
            await addMovement(c, {
              tenantId: req.auth.tenantId, branchId: reg.branch_id, productId: l.sl.product_id, qtyDeltaMilli: l.qtyMilli,
              location: l.disposition === 'restock' ? 'sale' : 'damaged', unitCost: l.sl.unit_cost_agorot, sourceType: 'return', sourceId: ret.id, reason: b.reason, actorId: req.auth.userId,
            });
          }
        }
      }

      const docPayments: any[] = [];
      let voucher: any = null;
      for (const [i, r] of refunds.entries()) {
        let voucherId: string | null = null;
        let providerRef: string | null = null;
        let manual = false;
        if (r.method === 'card' && r.pay) {
          const full = await one(c, 'SELECT * FROM payments WHERE id = $1', [r.pay.id]);
          if (full.provider === 'manual_terminal') manual = true;
          else {
            const res = await app.providers.payments.refund(full.provider_ref, r.amount, `${key}:refund:${i}`);
            if (!res.ok) throw new AppError(502, 'refund_failed', `ההחזר לכרטיס נכשל: ${res.failureReason ?? ''}`, { retryable: true });
            providerRef = res.providerRef;
          }
        }
        if (r.method === 'credit_note') {
          const code = `V${randomBytes(5).toString('hex').toUpperCase()}`;
          const exp = new Date(); exp.setFullYear(exp.getFullYear() + VOUCHER_VALID_YEARS);
          voucher = await one(c,
            `INSERT INTO vouchers (tenant_id, code, initial_agorot, customer_id, source_type, source_id, expires_at, created_by) VALUES ($1,$2,$3,$4,'return',$5,$6,$7) RETURNING *`,
            [req.auth.tenantId, code, r.amount, sale.customer_id, ret.id, exp.toISOString().slice(0, 10), req.auth.userId]);
          voucherId = voucher.id;
          await c.query('INSERT INTO voucher_ledger (tenant_id, voucher_id, amount_agorot) VALUES ($1,$2,$3)', [req.auth.tenantId, voucherId, r.amount]);
        }
        if (r.method === 'customer_account' && sale.customer_id) {
          await c.query("INSERT INTO customer_ledger (tenant_id, customer_id, amount_agorot, source_type, source_id) VALUES ($1,$2,$3,'return',$4)", [req.auth.tenantId, sale.customer_id, -r.amount, ret.id]);
        }
        await c.query(
          `INSERT INTO payments (tenant_id, return_id, customer_id, session_id, direction, method, amount_agorot, status, provider, provider_ref, voucher_id, idempotency_key)
           VALUES ($1,$2,$3,$4,'out',$5,$6,'captured',$7,$8,$9,$10)`,
          [req.auth.tenantId, ret.id, sale.customer_id, session.id, r.method, r.amount, r.method === 'card' ? (manual ? 'manual_terminal' : app.providers.payments.name) : 'none', providerRef, voucherId, `${key}:out:${i}`]);
        if (r.method === 'card' && r.pay) {
          const refunded = (await one(c, "SELECT COALESCE(SUM(p.amount_agorot),0) AS s FROM payments p JOIN returns rr ON rr.id = p.return_id WHERE rr.sale_id = $1 AND p.method = 'card' AND p.direction = 'out'", [b.saleId])).s;
          await c.query('UPDATE payments SET status = $2 WHERE id = $1', [r.pay.id, refunded >= cardPaid ? 'refunded_full' : 'refunded_partial']);
        }
        docPayments.push({ method: r.method, amount: r.amount, manualTerminal: manual || undefined, voucherCode: voucher && voucherId ? voucher.code : undefined });
      }

      const byRate = new Map<number, any>();
      for (const l of rLines) {
        const x = byRate.get(l.sl.rate_bp) ?? { rateBp: l.sl.rate_bp, net: 0, vat: 0, total: 0 };
        x.net += l.net; x.vat += l.vat; x.total += l.total; byRate.set(l.sl.rate_bp, x);
      }
      const credit = await issueDocument(c, app.providers, {
        tenantId: req.auth.tenantId, actorId: req.auth.userId, type: posReturnDocType(tenant.tax_status), taxDate: israelDate(new Date()),
        branchId: reg.branch_id, registerId: reg.id, customer: doc.customer,
        lines: rLines.map((l) => ({ name: l.sl.name, sku: l.sl.sku, qtyMilli: l.qtyMilli, unitPrice: l.sl.unit_price_agorot, discount: 0, total: l.total, rateBp: l.sl.rate_bp, net: l.net, vat: l.vat, kind: l.sl.kind })),
        payments: docPayments,
        totals: { gross: total, discount: 0, net, vat, total, byRate: [...byRate.values()] },
        sourceType: 'return', sourceId: ret.id, originalDocumentId: doc.id, notes: `סיבה: ${b.reason}`,
      });
      await c.query('UPDATE returns SET document_id = $2 WHERE id = $1', [ret.id, credit.id]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'return.create', targetType: 'return', targetId: ret.id, details: { sale: b.saleId, total, refunds, approvedBy } });
      return {
        returnId: ret.id, number, total_agorot: total, refunds: docPayments,
        document: { id: credit.id, doc_type: credit.doc_type, serial: credit.serial },
        voucher: voucher ? { code: voucher.code, amount_agorot: voucher.initial_agorot, expires_at: voucher.expires_at } : null,
        manualCardRefund: docPayments.some((p) => p.manualTerminal),
      };
    })).value);
  });

  app.get('/vouchers/:code', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const { code } = req.params as { code: string };
    return tx(req, async (c) => {
      const v = await one(c, 'SELECT v.*, COALESCE((SELECT SUM(amount_agorot) FROM voucher_ledger l WHERE l.voucher_id = v.id),0) AS balance_agorot FROM vouchers v WHERE code = $1', [code.toUpperCase()]);
      if (!v) throw notFound('השובר');
      return v;
    });
  });
}
