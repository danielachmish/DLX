// מכירה בקופה (WF-01, POS-01..POS-09, PAY-01..PAY-07, PRI-01..PRI-05).
// השרת הוא מקור האמת למחיר, להנחה המותרת ולמע"מ. הקופה שולחת מוצר + כמות; המחיר נלקח מהקטלוג (T08).
// זרימה: יצירה (payment_pending) → חיוב אשראי (אם יש) → סגירה: תשלומים, מלאי, מסמך — בטרנזקציה אחת.
import {
  can, cashLimitError, computeCart, type Counterparty, type CartLineInput, discountAllowed, israelDate, lineAmount, needsAgeCheck,
  parseScaleBarcode, posSaleDocType, saleBlockReason, tenderState, type Permission, type Tender, withDeposits,
} from '@dlx/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { branchScope, requireAuth, tx, verifySecret } from '../auth.js';
import { type Db, many, one, withTenant } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { idemKey, idempotent } from '../idempotency.js';
import { issueDocument, loadTenant } from '../services/documents.js';
import { takeStock } from '../services/stock.js';
import { branchPrice, publicProduct } from './catalog.js';
import { activeSession } from './cash.js';
import { customerBalance } from './customers.js';

const LineIn = z.object({
  productId: z.string().uuid(),
  qtyMilli: z.number().int().positive(),
  barcode: z.string().optional(),
  unitPriceAgorot: z.number().int().min(0).optional(), // שינוי מחיר — רק עם pos:price_override
  discountBp: z.number().int().min(0).max(10000).optional(),
  discountAgorot: z.number().int().min(0).optional(),
});

const SaleIn = z.object({
  registerId: z.string().uuid(),
  customerId: z.string().uuid().nullable().optional(),
  lines: z.array(LineIn).min(1).max(500),
  cartDiscountBp: z.number().int().min(0).max(10000).optional(),
  cartDiscountAgorot: z.number().int().min(0).optional(),
  ageVerified: z.boolean().default(false),
  approverPin: z.string().regex(/^\d{4,8}$/).optional(), // IAM-03: אישור מנהל במקום
});

const TenderIn = z.object({
  method: z.enum(['cash', 'check', 'transfer', 'bit', 'credit_note', 'customer_account']),
  amountAgorot: z.number().int().positive(),
  voucherCode: z.string().optional(),
  checkNumber: z.string().optional(), checkBank: z.string().optional(), checkDate: z.string().optional(),
  reference: z.string().max(60).optional(),
});

// מנהל שמאשר בקופה עם ה-PIN שלו — מחזיר את המשתמש אם יש לו את ההרשאה
async function approverByPin(c: Db, pin: string | undefined, perm: Permission): Promise<string | null> {
  if (!pin) return null;
  const rows = await many(c, 'SELECT id, role, pin_hash FROM users WHERE active AND pin_hash IS NOT NULL');
  for (const r of rows) if (can(r.role, perm) && (await verifySecret(pin, r.pin_hash))) return r.id;
  return null;
}

export async function loadSale(c: Db, id: string) {
  const s = await one(c,
    `SELECT s.*, u.name AS cashier_name, r.name AS register_name, cu.name AS customer_name, d.serial AS document_serial, d.doc_type AS document_type
     FROM sales s LEFT JOIN users u ON u.id = s.cashier_id LEFT JOIN registers r ON r.id = s.register_id LEFT JOIN customers cu ON cu.id = s.customer_id
     LEFT JOIN documents d ON d.id = s.document_id WHERE s.id = $1`, [id]);
  if (!s) throw notFound('המכירה');
  s.lines = await many(c,
    `SELECT l.*, COALESCE((SELECT SUM(rl.qty_milli) FROM return_lines rl WHERE rl.sale_line_id = l.id),0) AS returned_qty_milli,
       COALESCE((SELECT SUM(rl.total_agorot) FROM return_lines rl WHERE rl.sale_line_id = l.id),0) AS returned_total_agorot
     FROM sale_lines l WHERE l.sale_id = $1 ORDER BY l.line_no`, [id]);
  s.payments = await many(c,
    `SELECT id, method, direction, amount_agorot, status, provider, approval_code, card_last4, card_brand, installments, failure_reason, created_at
     FROM payments WHERE sale_id = $1 ORDER BY created_at`, [id]);
  return s;
}

function paidByCard(sale: any) {
  return sale.payments.filter((p: any) => p.method === 'card' && p.direction === 'in' && p.status === 'captured').reduce((a: number, p: any) => a + p.amount_agorot, 0);
}

const stripCosts = (req: FastifyRequest, s: any) => (can(req.auth.role, 'costs:read') ? s : { ...s, lines: s.lines.map(({ unit_cost_agorot: _c, ...l }: any) => l) });

export async function salesRoutes(app: FastifyInstance) {
  // תצוגה מקדימה של עגלה (בדיקת מחיר בלי ליצור מכירה)
  app.post('/sales/quote', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const b = SaleIn.partial({ registerId: true }).parse(req.body);
    return tx(req, async (c) => {
      const t = await loadTenant(c, req.auth.tenantId);
      const branchId = branchScope(req, b.registerId ? (await one(c, 'SELECT branch_id FROM registers WHERE id = $1', [b.registerId]))?.branch_id : null);
      const zone = branchId ? (await one(c, 'SELECT tax_zone FROM branches WHERE id = $1', [branchId]))?.tax_zone ?? 'regular' : 'regular';
      const lines: CartLineInput[] = [];
      for (const [i, l] of (b.lines ?? []).entries()) {
        const p = await one(c, 'SELECT * FROM products WHERE id = $1', [l.productId]);
        if (!p) throw notFound('המוצר');
        lines.push({ key: String(i), productId: p.id, name: p.name, unitPrice: (await branchPrice(c, p.id, branchId)) ?? p.price_agorot, qtyMilli: l.qtyMilli, taxCategory: p.tax_category, discountBp: l.discountBp, discountAgorot: l.discountAgorot, depositPerUnit: p.deposit_agorot });
      }
      return computeCart({ lines: withDeposits(lines), cartDiscountBp: b.cartDiscountBp, cartDiscountAgorot: b.cartDiscountAgorot }, { date: israelDate(new Date()), status: t.tax_status, zone });
    });
  });

  app.post('/sales', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const key = idemKey(req);
    const b = SaleIn.parse(req.body);
    return tx(req, async (c) => (await idempotent(c, req.auth.tenantId, key, 'sale.create', b, async () => {
      const reg = await one(c, 'SELECT r.*, b.tax_zone FROM registers r JOIN branches b ON b.id = r.branch_id WHERE r.id = $1 AND r.active', [b.registerId]);
      if (!reg) throw notFound('הקופה');
      branchScope(req, reg.branch_id);
      const session = await activeSession(c, reg.id);
      if (!session) throw new AppError(409, 'no_session', 'אין משמרת פתוחה בקופה. צריך לפתוח משמרת לפני מכירה.');
      const tenant = await loadTenant(c, req.auth.tenantId);
      const now = new Date();
      const taxDate = israelDate(now);
      let approver: string | null | undefined;
      const needApproval = async (perm: Permission, msg: string) => {
        if (can(req.auth.role, perm)) return req.auth.userId;
        if (approver === undefined) approver = await approverByPin(c, b.approverPin, perm);
        if (!approver) throw new AppError(403, 'approval_required', msg, { data: { perm } });
        return approver;
      };

      const inputs: (CartLineInput & { _p: any })[] = [];
      let ageNeeded = false;
      let discountApprovedBy: string | null = null;
      for (const [i, l] of b.lines.entries()) {
        const p = await one(c, 'SELECT * FROM products WHERE id = $1', [l.productId]);
        if (!p || p.status !== 'active') throw new AppError(422, 'rule', 'מוצר לא פעיל בעגלה');
        const block = saleBlockReason(p.restriction, now);
        if (block) throw new AppError(422, 'restricted', `${p.name}: ${block}`);
        if (needsAgeCheck(p.restriction)) ageNeeded = true;
        const catalog = (await branchPrice(c, p.id, reg.branch_id, now)) ?? p.price_agorot;
        let unitPrice = catalog;
        let qtyMilli = l.qtyMilli;
        // G-17: ברקוד מחיר מהמאזניים — המחיר של השורה כפי שהודפס על המדבקה
        const scale = l.barcode ? parseScaleBarcode(l.barcode) : null;
        if (scale && scale.price !== undefined && p.scale_code === scale.itemCode) {
          unitPrice = scale.price;
          qtyMilli = 1000;
        } else if (l.unitPriceAgorot !== undefined && l.unitPriceAgorot !== catalog) {
          await needApproval('pos:price_override', `שינוי מחיר של "${p.name}" דורש אישור מנהל`);
          unitPrice = l.unitPriceAgorot;
        }
        const gross = lineAmount(unitPrice, qtyMilli);
        const discBp = l.discountBp ?? (l.discountAgorot && gross ? Math.ceil((l.discountAgorot * 10000) / gross) : 0);
        if (discBp > 0 && !discountAllowed(req.auth.role, discBp)) {
          discountApprovedBy = await needApproval('pos:discount_override', `הנחה של ${(discBp / 100).toFixed(0)}% על "${p.name}" דורשת אישור מנהל`);
        }
        inputs.push({
          key: String(i), productId: p.id, sku: p.sku, name: p.name, unitPrice, qtyMilli, taxCategory: p.tax_category,
          discountBp: l.discountBp, discountAgorot: l.discountAgorot, depositPerUnit: p.deposit_agorot, _p: { ...p, catalog, barcode: l.barcode ?? null },
        });
      }
      if (ageNeeded && !b.ageVerified) throw new AppError(422, 'age_check', 'בעגלה מוצר מגיל 18. צריך לבדוק תעודה ולאשר.');

      const itemsBase = inputs.reduce((a, l) => a + lineAmount(l.unitPrice, l.qtyMilli) - (l.discountAgorot ?? 0), 0);
      const cartBp = b.cartDiscountBp ?? (b.cartDiscountAgorot && itemsBase ? Math.ceil((b.cartDiscountAgorot * 10000) / itemsBase) : 0);
      if (cartBp > 0 && !discountAllowed(req.auth.role, cartBp)) {
        discountApprovedBy = await needApproval('pos:discount_override', `הנחת עגלה של ${(cartBp / 100).toFixed(0)}% דורשת אישור מנהל`);
      }

      const { lines, totals } = computeCart(
        { lines: withDeposits(inputs), cartDiscountBp: b.cartDiscountBp, cartDiscountAgorot: b.cartDiscountAgorot },
        { date: taxDate, status: tenant.tax_status, zone: reg.tax_zone },
      );
      if (b.customerId && !(await one(c, 'SELECT 1 FROM customers WHERE id = $1 AND active', [b.customerId]))) throw notFound('הלקוח');

      const sale = await one(c,
        `INSERT INTO sales (tenant_id, branch_id, register_id, session_id, cashier_id, customer_id, status, tax_date, gross_agorot, discount_agorot, total_agorot,
           net_agorot, vat_agorot, cart_discount_agorot, age_verified_by, discount_approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,'payment_pending',$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [req.auth.tenantId, reg.branch_id, reg.id, session.id, req.auth.userId, b.customerId ?? null, taxDate, totals.gross, totals.discount, totals.total,
          totals.net, totals.vat, lines.reduce((a, l) => a + l.cartDiscount, 0), ageNeeded ? req.auth.userId : null, discountApprovedBy]);
      for (const [n, l] of lines.entries()) {
        const src = inputs.find((x) => x.key === l.key.split(':')[0]);
        const p = l.kind === 'item' ? src!._p : null;
        await c.query(
          `INSERT INTO sale_lines (tenant_id, sale_id, line_no, kind, product_id, sku, name, barcode, qty_milli, unit_price_agorot, list_price_agorot, unit_cost_agorot,
             line_discount_agorot, cart_discount_agorot, total_agorot, rate_bp, net_agorot, vat_agorot, tax_category)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [req.auth.tenantId, sale.id, n + 1, l.kind, p?.id ?? null, p?.sku ?? null, l.name, p?.barcode ?? null, l.qtyMilli, l.unitPrice, p?.catalog ?? l.unitPrice,
            p?.cost_agorot ?? 0, l.lineDiscount, l.cartDiscount, l.total, l.rateBp, l.net, l.vat, l.taxCategory]);
      }
      if (discountApprovedBy && discountApprovedBy !== req.auth.userId) {
        await audit(c, { tenantId: req.auth.tenantId, actorId: discountApprovedBy, action: 'pos.approval', targetType: 'sale', targetId: sale.id, details: { cashier: req.auth.userId, discount: totals.discount } });
      }
      return stripCosts(req, await loadSale(c, sale.id));
    })).value);
  });

  app.get('/sales', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const q = z.object({
      from: z.string().optional(), to: z.string().optional(), registerId: z.string().uuid().optional(), status: z.string().optional(),
      q: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query);
    return tx(req, (c) => many(c,
      `SELECT s.id, s.status, s.created_at, s.finalized_at, s.total_agorot, s.register_id, r.name AS register_name, u.name AS cashier_name,
         cu.name AS customer_name, d.serial AS document_serial, d.doc_type AS document_type
       FROM sales s JOIN registers r ON r.id = s.register_id LEFT JOIN users u ON u.id = s.cashier_id LEFT JOIN customers cu ON cu.id = s.customer_id
       LEFT JOIN documents d ON d.id = s.document_id
       WHERE ($1::timestamptz IS NULL OR s.created_at >= $1) AND ($2::timestamptz IS NULL OR s.created_at < $2) AND ($3::uuid IS NULL OR s.register_id = $3)
         AND ($4::text IS NULL OR s.status = $4) AND ($5::text IS NULL OR d.serial::text = $5 OR cu.name ILIKE '%' || $5 || '%')
       ORDER BY s.created_at DESC LIMIT $6`, [q.from ?? null, q.to ?? null, q.registerId ?? null, q.status ?? null, q.q?.trim() || null, q.limit]));
  });

  app.get('/sales/:id', { preHandler: requireAuth('pos:sell') }, async (req) => tx(req, async (c) => stripCosts(req, await loadSale(c, (req.params as any).id))));

  // PAY-01..PAY-03, T12, T13: חיוב אשראי. רשומת התשלום נשמרת לפני הפנייה לספק, עם אותו מפתח —
  // ניסיון חוזר (timeout, רענון) לא יוצר חיוב שני; תשובה חסרה נפתרת בשאילתת סטטוס.
  app.post('/sales/:id/payments', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const { id } = req.params as { id: string };
    const key = idemKey(req);
    const b = z.object({
      method: z.literal('card'), amountAgorot: z.number().int().positive(), installments: z.number().int().min(1).max(36).default(1),
      terminal: z.enum(['integrated', 'external']).default('integrated'),
      approvalCode: z.string().max(20).optional(), last4: z.string().regex(/^\d{4}$/).optional(),
    }).parse(req.body);
    if (b.terminal === 'external' && !b.approvalCode) throw new AppError(422, 'invalid', 'מסוף חיצוני: צריך להזין מספר אישור', { fieldErrors: { approvalCode: 'חובה' } });

    const pay = await tx(req, async (c) => {
      const existing = await one(c, 'SELECT * FROM payments WHERE idempotency_key = $1', [key]);
      if (existing) {
        if (existing.sale_id !== id || existing.amount_agorot !== b.amountAgorot) throw new AppError(422, 'idempotency_mismatch', 'אותו מפתח נשלח לתשלום אחר');
        return existing;
      }
      const sale = await one(c, 'SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id]);
      if (!sale) throw notFound('המכירה');
      if (sale.status !== 'payment_pending') throw new AppError(409, 'invalid_state', 'המכירה לא ממתינה לתשלום');
      const busy = await one(c, "SELECT 1 FROM payments WHERE sale_id = $1 AND status IN ('initiated','pending')", [id]);
      if (busy) throw new AppError(409, 'payment_in_progress', 'יש תשלום אשראי שעדיין לא נסגר. צריך לבדוק את הסטטוס שלו קודם.');
      const card = await one(c, "SELECT COALESCE(SUM(amount_agorot),0) AS s FROM payments WHERE sale_id = $1 AND method = 'card' AND status = 'captured'", [id]);
      if (card.s + b.amountAgorot > sale.total_agorot) throw new AppError(422, 'rule', 'סכום האשראי גדול מיתרת העסקה');
      const external = b.terminal === 'external';
      return one(c,
        `INSERT INTO payments (tenant_id, sale_id, session_id, method, amount_agorot, status, provider, approval_code, card_last4, installments, idempotency_key)
         VALUES ($1,$2,$3,'card',$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.auth.tenantId, id, sale.session_id, b.amountAgorot, external ? 'captured' : 'initiated', external ? 'manual_terminal' : app.providers.payments.name,
          b.approvalCode ?? null, b.last4 ?? null, b.installments, key]);
    });

    let final = pay;
    if (pay.status === 'initiated' || pay.status === 'pending') {
      let result;
      try {
        result = pay.status === 'pending'
          ? await app.providers.payments.status(key)
          : await app.providers.payments.charge({ idempotencyKey: key, amount: pay.amount_agorot, installments: b.installments, reference: id });
      } catch (e: any) {
        result = { status: 'pending' as const, providerRef: null, failureReason: String(e?.message ?? e) };
      }
      final = await withTenant(app.pool, req.auth.tenantId, async (c) => {
        const status = result?.status ?? 'pending';
        const r = await one(c,
          `UPDATE payments SET status = $2, provider_ref = COALESCE($3, provider_ref), approval_code = COALESCE($4, approval_code), card_last4 = COALESCE($5, card_last4),
             card_brand = COALESCE($6, card_brand), failure_reason = $7 WHERE id = $1 AND status IN ('initiated','pending') RETURNING *`,
          [pay.id, status, result?.providerRef ?? null, (result as any)?.approvalCode ?? null, (result as any)?.last4 ?? null, (result as any)?.brand ?? null, (result as any)?.failureReason ?? null]);
        await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: `payment.${status}`, targetType: 'payment', targetId: pay.id, details: { sale: id, amount: pay.amount_agorot } });
        return r ?? (await one(c, 'SELECT * FROM payments WHERE id = $1', [pay.id]));
      });
    }
    const sale = await tx(req, (c) => loadSale(c, id));
    return { payment: final, sale: stripCosts(req, sale), tender: tenderState(sale.total_agorot, sale.payments.filter((p: any) => p.status === 'captured' && p.method === 'card').map((p: any) => ({ method: 'card', amount: p.amount_agorot }))) };
  });

  // PAY-04: בדיקת תשלום שנתקע (אין תשובה מהספק)
  app.post('/payments/:id/reconcile', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const { id } = req.params as { id: string };
    const pay = await tx(req, (c) => one(c, 'SELECT * FROM payments WHERE id = $1', [id]));
    if (!pay) throw notFound('התשלום');
    if (!['initiated', 'pending'].includes(pay.status)) return pay;
    const r = await app.providers.payments.status(pay.idempotency_key);
    return tx(req, async (c) => {
      const status = r ? r.status : 'failed';
      const out = await one(c,
        `UPDATE payments SET status = $2, provider_ref = COALESCE($3, provider_ref), approval_code = COALESCE($4, approval_code), card_last4 = COALESCE($5, card_last4), failure_reason = $6
         WHERE id = $1 AND status IN ('initiated','pending') RETURNING *`,
        [id, status, r?.providerRef ?? null, r?.approvalCode ?? null, r?.last4 ?? null, r ? r.failureReason ?? null : 'הספק לא מכיר את העסקה — לא חויב']);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'payment.reconcile', targetType: 'payment', targetId: id, details: { status } });
      return out ?? pay;
    });
  });

  // סגירת מכירה: תשלומים שאינם אשראי + מלאי + מסמך + יומן — הכל או כלום (פרק 13, "עקרון טרנזקציוני")
  app.post('/sales/:id/finalize', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const { id } = req.params as { id: string };
    const key = idemKey(req);
    const b = z.object({
      tenders: z.array(TenderIn).max(10).default([]),
      party: z.enum(['consumer', 'business', 'tourist']).default('consumer'),
      customer: z.object({ name: z.string().min(1), taxId: z.string().optional(), address: z.string().optional() }).optional(), // חשבונית ללקוח מזדמן
    }).parse(req.body);
    return tx(req, async (c) => (await idempotent(c, req.auth.tenantId, key, 'sale.finalize', { id, ...b }, async () => {
      const sale = await one(c, 'SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id]);
      if (!sale) throw notFound('המכירה');
      if (sale.status === 'finalized') return { sale: stripCosts(req, await loadSale(c, id)), replay: true };
      if (sale.status !== 'payment_pending') throw new AppError(409, 'invalid_state', 'המכירה לא ממתינה לתשלום');
      const tenant = await loadTenant(c, req.auth.tenantId);
      const pays = await many(c, 'SELECT * FROM payments WHERE sale_id = $1', [id]);
      if (pays.some((p) => ['initiated', 'pending'].includes(p.status))) {
        throw new AppError(409, 'payment_in_progress', 'יש תשלום אשראי שעדיין לא אושר. צריך לבדוק את הסטטוס שלו.');
      }
      const cards = pays.filter((p) => p.method === 'card' && p.status === 'captured');
      const tenders: Tender[] = [...cards.map((p) => ({ method: 'card' as const, amount: p.amount_agorot })), ...b.tenders.map((t) => ({ method: t.method, amount: t.amountAgorot }))];
      const st = tenderState(sale.total_agorot, tenders);
      if (!st.settled) throw new AppError(422, 'not_settled', `חסר לתשלום ${(st.remaining / 100).toFixed(2)} ₪`, { data: st });
      const cashTendered = b.tenders.filter((t) => t.method === 'cash').reduce((a, t) => a + t.amountAgorot, 0);
      const cashKept = cashTendered - st.change;
      const limitErr = cashLimitError(sale.total_agorot, cashKept, sale.tax_date, b.party as Counterparty);
      if (limitErr) throw new AppError(422, 'cash_limit', limitErr);

      let customer = sale.customer_id ? await one(c, 'SELECT * FROM customers WHERE id = $1', [sale.customer_id]) : null;
      const docPayments: any[] = cards.map((p) => ({ method: 'card', amount: p.amount_agorot, last4: p.card_last4, brand: p.card_brand, approvalCode: p.approval_code, installments: p.installments }));
      for (const [i, t] of b.tenders.entries()) {
        const amount = t.method === 'cash' ? cashKept : t.amountAgorot;
        if (amount <= 0) continue;
        let voucherId: string | null = null;
        if (t.method === 'customer_account') {
          if (!customer) throw new AppError(422, 'rule', 'הקפה דורשת לקוח רשום במכירה');
          const bal = await customerBalance(c, customer.id);
          if (bal + amount > customer.credit_limit_agorot) {
            throw new AppError(422, 'credit_limit', `חריגה ממסגרת האשראי של הלקוח (יתרה ${(bal / 100).toFixed(2)} ₪, מסגרת ${(customer.credit_limit_agorot / 100).toFixed(2)} ₪)`);
          }
        }
        if (t.method === 'credit_note') {
          // נעילה לשובר — שתי קופות לא מממשות את אותה יתרה במקביל
          await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 13))', [`voucher:${req.auth.tenantId}:${(t.voucherCode ?? '').toUpperCase()}`]);
          const v = await one(c,
            `SELECT v.*, COALESCE((SELECT SUM(amount_agorot) FROM voucher_ledger l WHERE l.voucher_id = v.id),0) AS balance FROM vouchers v WHERE v.code = $1`,
            [(t.voucherCode ?? '').toUpperCase()]);
          if (!v) throw new AppError(422, 'voucher', 'שובר לא נמצא');
          if (v.expires_at < sale.tax_date) throw new AppError(422, 'voucher', 'תוקף השובר פג');
          if (v.balance < amount) throw new AppError(422, 'voucher', `יתרת השובר ${(v.balance / 100).toFixed(2)} ₪ בלבד`);
          voucherId = v.id;
        }
        const pay = await one(c,
          `INSERT INTO payments (tenant_id, sale_id, customer_id, session_id, method, amount_agorot, status, check_number, check_bank, check_date, provider_ref, voucher_id, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,'captured',$7,$8,$9,$10,$11,$12) RETURNING id`,
          [req.auth.tenantId, id, customer?.id ?? null, sale.session_id, t.method, amount, t.checkNumber ?? null, t.checkBank ?? null, t.checkDate || null,
            t.reference ?? null, voucherId, `${key}:t${i}`]);
        if (voucherId) await c.query('INSERT INTO voucher_ledger (tenant_id, voucher_id, amount_agorot, payment_id) VALUES ($1,$2,$3,$4)', [req.auth.tenantId, voucherId, -amount, pay.id]);
        if (t.method === 'customer_account') {
          await c.query("INSERT INTO customer_ledger (tenant_id, customer_id, amount_agorot, source_type, source_id) VALUES ($1,$2,$3,'sale',$4)", [req.auth.tenantId, customer!.id, amount, id]);
        }
        docPayments.push({ method: t.method, amount, checkNumber: t.checkNumber, checkBank: t.checkBank, checkDate: t.checkDate });
      }

      // מלאי: נעילה לכל מוצר-סניף ובדיקת מלאי שלילי (D07, T02)
      const lines = await many(c, 'SELECT l.*, p.track_stock FROM sale_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.sale_id = $1 ORDER BY l.product_id', [id]);
      for (const l of lines) {
        if (l.kind !== 'item' || !l.product_id || !l.track_stock) continue;
        await takeStock(c, {
          tenantId: req.auth.tenantId, branchId: sale.branch_id, productId: l.product_id, qtyDeltaMilli: -l.qty_milli, unitCost: l.unit_cost_agorot,
          sourceType: 'sale', sourceId: id, actorId: req.auth.userId, allowNegative: tenant.allow_negative_stock, productName: l.name,
        });
      }

      if (!customer && b.customer) customer = { id: null, name: b.customer.name, tax_id: b.customer.taxId ?? null, kind: b.customer.taxId ? 'business' : 'private', address: b.customer.address ?? null };
      const ordered = [...lines].sort((a, z2) => a.line_no - z2.line_no);
      const byRate = new Map<number, { rateBp: number; net: number; vat: number; total: number }>();
      for (const l of ordered) {
        const r = byRate.get(l.rate_bp) ?? { rateBp: l.rate_bp, net: 0, vat: 0, total: 0 };
        r.net += l.net_agorot; r.vat += l.vat_agorot; r.total += l.total_agorot; byRate.set(l.rate_bp, r);
      }
      const doc = await issueDocument(c, app.providers, {
        tenantId: req.auth.tenantId, actorId: req.auth.userId, type: posSaleDocType(tenant.tax_status), taxDate: sale.tax_date,
        branchId: sale.branch_id, registerId: sale.register_id,
        customer: customer ? { id: customer.id, name: customer.name, taxId: customer.tax_id, kind: customer.kind, address: customer.address, phone: customer.phone } : null,
        lines: ordered.map((l) => ({
          name: l.name, sku: l.sku, barcode: l.barcode, qtyMilli: l.qty_milli, unitPrice: l.unit_price_agorot, discount: l.line_discount_agorot + l.cart_discount_agorot,
          total: l.total_agorot, rateBp: l.rate_bp, net: l.net_agorot, vat: l.vat_agorot, kind: l.kind,
        })),
        payments: docPayments,
        totals: { gross: sale.gross_agorot, discount: sale.discount_agorot, net: sale.net_agorot, vat: sale.vat_agorot, total: sale.total_agorot, rounding: st.rounding, change: st.change, byRate: [...byRate.values()].sort((a, z2) => z2.rateBp - a.rateBp) },
        sourceType: 'sale', sourceId: id,
      });
      await c.query(
        `UPDATE sales SET status = 'finalized', document_id = $2, rounding_agorot = $3, change_agorot = $4, finalized_at = now() WHERE id = $1`,
        [id, doc.id, st.rounding, st.change]);
      await c.query(`INSERT INTO outbox_events (tenant_id, event_type, payload, correlation_id) VALUES ($1,'SaleFinalized',$2,$3)`,
        [req.auth.tenantId, JSON.stringify({ saleId: id, documentId: doc.id, total: sale.total_agorot }), sale.correlation_id]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'sale.finalize', targetType: 'sale', targetId: id, details: { total: sale.total_agorot, document: doc.serial, change: st.change } });
      return { sale: stripCosts(req, await loadSale(c, id)), document: { id: doc.id, doc_type: doc.doc_type, serial: doc.serial, allocation_number: doc.allocation_number }, change_agorot: st.change, rounding_agorot: st.rounding };
    })).value);
  });

  // POS-06: ביטול לפני סגירה — בלי מסמך ובלי מלאי. אשראי שכבר חויב מוחזר אצל הספק
  app.post('/sales/:id/cancel', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(2, 'צריך סיבה') }).parse(req.body);
    const sale = await tx(req, (c) => loadSale(c, id));
    if (!['payment_pending', 'exception'].includes(sale.status)) throw new AppError(409, 'invalid_state', 'אפשר לבטל רק מכירה שלא נסגרה. אחרי סגירה — החזרה.');
    if (sale.payments.some((p: any) => ['initiated', 'pending'].includes(p.status))) throw new AppError(409, 'payment_in_progress', 'יש תשלום אשראי פתוח. צריך לבדוק את הסטטוס שלו לפני ביטול.');
    const refunds: any[] = [];
    for (const p of sale.payments.filter((x: any) => x.method === 'card' && x.status === 'captured')) {
      if (p.provider === 'manual_terminal') { refunds.push({ id: p.id, manual: true }); continue; }
      const full = await tx(req, (c) => one(c, 'SELECT provider_ref FROM payments WHERE id = $1', [p.id]));
      const r = await app.providers.payments.refund(full.provider_ref, p.amount_agorot, `void:${p.id}`);
      if (!r.ok) throw new AppError(502, 'refund_failed', `ביטול החיוב נכשל: ${r.failureReason ?? ''}`, { retryable: true });
      refunds.push({ id: p.id, manual: false });
    }
    return tx(req, async (c) => {
      for (const r of refunds) await c.query("UPDATE payments SET status = 'voided' WHERE id = $1", [r.id]);
      await c.query("UPDATE sales SET status = 'cancelled' WHERE id = $1 AND status IN ('payment_pending','exception')", [id]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'sale.cancel', targetType: 'sale', targetId: id, details: { reason, voided: refunds } });
      return { sale: stripCosts(req, await loadSale(c, id)), manualVoids: refunds.filter((r) => r.manual).length };
    });
  });

  // חיפוש מוצרים מהיר לקופה (שם / מק"ט / ברקוד) עם מחיר הסניף
  app.get('/pos/products', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const q = z.object({ q: z.string().min(1), branchId: z.string().uuid().optional() }).parse(req.query);
    return tx(req, async (c) => {
      const rows = await many(c,
        `SELECT p.*, (SELECT barcode FROM barcodes b WHERE b.product_id = p.id ORDER BY (b.kind='unit') DESC LIMIT 1) AS barcode
         FROM products p WHERE p.status = 'active' AND (p.name ILIKE '%' || $1 || '%' OR p.sku ILIKE $1 || '%' OR EXISTS (SELECT 1 FROM barcodes b WHERE b.product_id = p.id AND b.barcode = $1))
         ORDER BY (p.sku = $1) DESC, p.name LIMIT 30`, [q.q.trim()]);
      const branchId = q.branchId ?? req.auth.branchId;
      const out = [];
      for (const p of rows) out.push({ ...publicProduct(req, p), unit_price: (await branchPrice(c, p.id, branchId)) ?? p.price_agorot });
      return out;
    });
  });
}
