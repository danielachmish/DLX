// ספקים, הזמנות רכש וקליטת סחורה (PUR-01..PUR-07, RCV-01..RCV-08, WF-02)
import { assertTransition, isValidIsraeliId } from '@dlx/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { assertPerm, branchScope, requireAuth, tx } from '../auth.js';
import { type Db, many, nextNumber, one } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { addMovement, takeStock, updateAverageCost } from '../services/stock.js';

const Supplier = z.object({
  name: z.string().min(1), taxId: z.string().refine((v) => !v || isValidIsraeliId(v), 'מספר עוסק לא תקין').nullable().optional(),
  contactName: z.string().nullable().optional(), phone: z.string().nullable().optional(), email: z.string().email().nullable().optional().or(z.literal('')),
  address: z.string().nullable().optional(), paymentTerms: z.string().nullable().optional(),
  withholdingCertUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), withholdingRateBp: z.number().int().min(0).max(10000).nullable().optional(),
  active: z.boolean().default(true),
});

const PoLine = z.object({ productId: z.string().uuid(), qtyMilli: z.number().int().positive(), unitCostAgorot: z.number().int().min(0) });
const Po = z.object({ supplierId: z.string().uuid(), branchId: z.string().uuid(), expectedAt: z.string().nullable().optional(), notes: z.string().nullable().optional(), lines: z.array(PoLine).min(1) });

const GrLine = z.object({
  productId: z.string().uuid(), poLineId: z.string().uuid().nullable().optional(), qtyMilli: z.number().int().positive(),
  unitCostAgorot: z.number().int().min(0), condition: z.enum(['ok', 'damaged']).default('ok'),
});
const Gr = z.object({
  poId: z.string().uuid().nullable().optional(), supplierId: z.string().uuid(), branchId: z.string().uuid(),
  supplierDocRef: z.string().nullable().optional(), supplierInvoiceTotalAgorot: z.number().int().nullable().optional(),
  reason: z.string().nullable().optional(), lines: z.array(GrLine).default([]),
});

async function loadPo(c: Db, id: string) {
  const po = await one(c, 'SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = $1', [id]);
  if (!po) throw notFound('ההזמנה');
  po.lines = await many(c,
    `SELECT l.*, p.name, p.sku, (l.qty_milli - l.received_qty_milli) AS open_qty_milli FROM purchase_order_lines l JOIN products p ON p.id = l.product_id WHERE l.po_id = $1 ORDER BY p.name`, [id]);
  po.total_agorot = po.lines.reduce((a: number, l: any) => a + Math.round((l.qty_milli * l.unit_cost_agorot) / 1000), 0);
  return po;
}

async function loadGr(c: Db, id: string) {
  const gr = await one(c, 'SELECT g.*, s.name AS supplier_name, po.number AS po_number FROM goods_receipts g JOIN suppliers s ON s.id = g.supplier_id LEFT JOIN purchase_orders po ON po.id = g.po_id WHERE g.id = $1', [id]);
  if (!gr) throw notFound('הקליטה');
  gr.lines = await many(c, 'SELECT l.*, p.name, p.sku FROM goods_receipt_lines l JOIN products p ON p.id = l.product_id WHERE l.receipt_id = $1 ORDER BY p.name', [id]);
  gr.total_agorot = gr.lines.reduce((a: number, l: any) => a + Math.round((l.qty_milli * l.unit_cost_agorot) / 1000), 0);
  return gr;
}

export async function purchasingRoutes(app: FastifyInstance) {
  // ===== ספקים =====
  app.get('/suppliers', { preHandler: requireAuth('catalog:read') }, async (req) => tx(req, (c) => many(c,
    `SELECT s.*, (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ('approved','ordered','partial'))::int AS open_orders
     FROM suppliers s ORDER BY s.active DESC, s.name`)));
  app.post('/suppliers', { preHandler: requireAuth('purchase:write') }, async (req) => {
    const b = Supplier.parse(req.body);
    return tx(req, async (c) => {
      const r = await one(c,
        `INSERT INTO suppliers (tenant_id, name, tax_id, contact_name, phone, email, address, payment_terms, withholding_cert_until, withholding_rate_bp, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [req.auth.tenantId, b.name, b.taxId || null, b.contactName ?? null, b.phone ?? null, b.email || null, b.address ?? null, b.paymentTerms ?? null,
          b.withholdingCertUntil ?? null, b.withholdingRateBp ?? null, b.active]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'supplier.create', targetType: 'supplier', targetId: r.id });
      return r;
    });
  });
  app.put('/suppliers/:id', { preHandler: requireAuth('purchase:write') }, async (req) => {
    const b = Supplier.parse(req.body);
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const r = await one(c,
        `UPDATE suppliers SET name=$2, tax_id=$3, contact_name=$4, phone=$5, email=$6, address=$7, payment_terms=$8, withholding_cert_until=$9, withholding_rate_bp=$10, active=$11
         WHERE id=$1 RETURNING *`,
        [id, b.name, b.taxId || null, b.contactName ?? null, b.phone ?? null, b.email || null, b.address ?? null, b.paymentTerms ?? null,
          b.withholdingCertUntil ?? null, b.withholdingRateBp ?? null, b.active]);
      if (!r) throw notFound('הספק');
      return r;
    });
  });
  app.get('/suppliers/:id', { preHandler: requireAuth('catalog:read') }, async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const s = await one(c, 'SELECT * FROM suppliers WHERE id = $1', [id]);
      if (!s) throw notFound('הספק');
      s.orders = await many(c, 'SELECT id, number, status, created_at, expected_at FROM purchase_orders WHERE supplier_id = $1 ORDER BY number DESC LIMIT 50', [id]);
      s.receipts = await many(c, 'SELECT id, number, status, supplier_doc_ref, posted_at, created_at FROM goods_receipts WHERE supplier_id = $1 ORDER BY number DESC LIMIT 50', [id]);
      return s;
    });
  });

  // ===== הזמנות רכש =====
  app.get('/purchase-orders', { preHandler: requireAuth('stock:read') }, async (req) => {
    const q = z.object({ status: z.string().optional(), supplierId: z.string().uuid().optional() }).parse(req.query);
    return tx(req, (c) => many(c,
      `SELECT po.id, po.number, po.status, po.created_at, po.expected_at, s.name AS supplier_name, b.name AS branch_name,
         (SELECT COALESCE(SUM(ROUND(qty_milli * unit_cost_agorot / 1000.0)),0) FROM purchase_order_lines l WHERE l.po_id = po.id) AS total_agorot,
         (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.po_id = po.id AND l.received_qty_milli < l.qty_milli)::int AS open_lines
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN branches b ON b.id = po.branch_id
       WHERE ($1::text IS NULL OR po.status = $1) AND ($2::uuid IS NULL OR po.supplier_id = $2) ORDER BY po.number DESC LIMIT 200`,
      [q.status ?? null, q.supplierId ?? null]));
  });

  app.get('/purchase-orders/:id', { preHandler: requireAuth('stock:read') }, async (req) => tx(req, (c) => loadPo(c, (req.params as any).id)));

  app.post('/purchase-orders', { preHandler: requireAuth('purchase:write') }, async (req) => {
    const b = Po.parse(req.body);
    branchScope(req, b.branchId);
    return tx(req, async (c) => {
      const number = await nextNumber(c, req.auth.tenantId, 'po');
      const po = await one(c, 'INSERT INTO purchase_orders (tenant_id, number, supplier_id, branch_id, expected_at, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [req.auth.tenantId, number, b.supplierId, b.branchId, b.expectedAt || null, b.notes ?? null, req.auth.userId]);
      for (const l of b.lines) {
        await c.query('INSERT INTO purchase_order_lines (tenant_id, po_id, product_id, qty_milli, unit_cost_agorot) VALUES ($1,$2,$3,$4,$5)',
          [req.auth.tenantId, po.id, l.productId, l.qtyMilli, l.unitCostAgorot]);
      }
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'po.create', targetType: 'purchase_order', targetId: po.id, details: { number } });
      return loadPo(c, po.id);
    });
  });

  app.put('/purchase-orders/:id', { preHandler: requireAuth('purchase:write') }, async (req) => {
    const b = Po.parse(req.body);
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const po = await one(c, 'SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
      if (!po) throw notFound('ההזמנה');
      if (po.status !== 'draft') throw new AppError(409, 'invalid_state', 'רק טיוטה ניתנת לעריכה. אחרי אישור — שינוי דרך הזמנה חדשה או ביטול.');
      await c.query('UPDATE purchase_orders SET supplier_id=$2, branch_id=$3, expected_at=$4, notes=$5 WHERE id=$1', [id, b.supplierId, b.branchId, b.expectedAt || null, b.notes ?? null]);
      await c.query('DELETE FROM purchase_order_lines WHERE po_id = $1', [id]);
      for (const l of b.lines) {
        await c.query('INSERT INTO purchase_order_lines (tenant_id, po_id, product_id, qty_milli, unit_cost_agorot) VALUES ($1,$2,$3,$4,$5)',
          [req.auth.tenantId, id, l.productId, l.qtyMilli, l.unitCostAgorot]);
      }
      return loadPo(c, id);
    });
  });

  // PUR-03: אישור לפי סכום — מעל הסף רק מנהל (inventory:approve)
  const PO_APPROVAL_LIMIT = 5_000_00;
  app.post('/purchase-orders/:id/:action', { preHandler: requireAuth('purchase:write') }, async (req) => {
    const { id, action } = z.object({ id: z.string().uuid(), action: z.enum(['approve', 'order', 'cancel', 'close']) }).parse(req.params);
    return tx(req, async (c) => {
      const po = await loadPo(c, id);
      const to = ({ approve: 'approved', order: 'ordered', cancel: 'cancelled', close: 'closed' } as const)[action];
      assertTransition('purchase_order', po.status, to);
      if (action === 'approve' && po.total_agorot > PO_APPROVAL_LIMIT) assertPerm(req, 'inventory:approve', 'הזמנה מעל ₪5,000 דורשת אישור מנהל');
      await c.query('UPDATE purchase_orders SET status = $2, approved_by = CASE WHEN $2 = \'approved\' THEN $3::uuid ELSE approved_by END WHERE id = $1', [id, to, req.auth.userId]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: `po.${action}`, targetType: 'purchase_order', targetId: id, details: { total: po.total_agorot } });
      return loadPo(c, id);
    });
  });

  // ===== קליטת סחורה =====
  app.get('/goods-receipts', { preHandler: requireAuth('stock:read') }, async (req) => tx(req, (c) => many(c,
    `SELECT g.id, g.number, g.status, g.supplier_doc_ref, g.created_at, g.posted_at, s.name AS supplier_name, po.number AS po_number, b.name AS branch_name,
       (SELECT COALESCE(SUM(ROUND(qty_milli * unit_cost_agorot / 1000.0)),0) FROM goods_receipt_lines l WHERE l.receipt_id = g.id) AS total_agorot
     FROM goods_receipts g JOIN suppliers s ON s.id = g.supplier_id JOIN branches b ON b.id = g.branch_id LEFT JOIN purchase_orders po ON po.id = g.po_id
     ORDER BY g.number DESC LIMIT 200`)));

  app.get('/goods-receipts/:id', { preHandler: requireAuth('stock:read') }, async (req) => tx(req, (c) => loadGr(c, (req.params as any).id)));

  // RCV-01 / RCV-02: מתוך הזמנה (השורות הפתוחות נטענות) או ישירה עם סיבה
  app.post('/goods-receipts', { preHandler: requireAuth('inventory:receive') }, async (req) => {
    const b = Gr.parse(req.body);
    branchScope(req, b.branchId);
    if (!b.poId && !b.reason) throw new AppError(422, 'invalid', 'קליטה בלי הזמנה דורשת סיבה', { fieldErrors: { reason: 'חובה' } });
    return tx(req, async (c) => {
      let lines = b.lines;
      if (b.poId) {
        const po = await loadPo(c, b.poId);
        if (!['approved', 'ordered', 'partial'].includes(po.status)) throw new AppError(409, 'invalid_state', 'אפשר לקלוט רק מהזמנה מאושרת');
        if (lines.length === 0) {
          lines = po.lines.filter((l: any) => l.open_qty_milli > 0).map((l: any) => ({
            productId: l.product_id, poLineId: l.id, qtyMilli: l.open_qty_milli, unitCostAgorot: l.unit_cost_agorot, condition: 'ok' as const,
          }));
        }
      }
      const number = await nextNumber(c, req.auth.tenantId, 'gr');
      const gr = await one(c,
        `INSERT INTO goods_receipts (tenant_id, number, po_id, supplier_id, branch_id, supplier_doc_ref, supplier_invoice_total_agorot, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [req.auth.tenantId, number, b.poId ?? null, b.supplierId, b.branchId, b.supplierDocRef ?? null, b.supplierInvoiceTotalAgorot ?? null, b.reason ?? null, req.auth.userId]);
      for (const l of lines) {
        await c.query('INSERT INTO goods_receipt_lines (tenant_id, receipt_id, product_id, po_line_id, qty_milli, unit_cost_agorot, condition) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [req.auth.tenantId, gr.id, l.productId, l.poLineId ?? null, l.qtyMilli, l.unitCostAgorot, l.condition]);
      }
      return loadGr(c, gr.id);
    });
  });

  app.put('/goods-receipts/:id', { preHandler: requireAuth('inventory:receive') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      lines: z.array(GrLine), supplierDocRef: z.string().nullable().optional(), supplierInvoiceTotalAgorot: z.number().int().nullable().optional(),
    }).parse(req.body);
    return tx(req, async (c) => {
      const gr = await one(c, 'SELECT * FROM goods_receipts WHERE id = $1 FOR UPDATE', [id]);
      if (!gr) throw notFound('הקליטה');
      if (gr.status === 'posted') throw new AppError(409, 'immutable', 'קליטה שאושרה לא נערכת. תיקון — דרך החזרה לספק או התאמת מלאי.');
      await c.query('UPDATE goods_receipts SET supplier_doc_ref = COALESCE($2, supplier_doc_ref), supplier_invoice_total_agorot = COALESCE($3, supplier_invoice_total_agorot) WHERE id = $1',
        [id, b.supplierDocRef ?? null, b.supplierInvoiceTotalAgorot ?? null]);
      await c.query('DELETE FROM goods_receipt_lines WHERE receipt_id = $1', [id]);
      for (const l of b.lines) {
        await c.query('INSERT INTO goods_receipt_lines (tenant_id, receipt_id, product_id, po_line_id, qty_milli, unit_cost_agorot, condition) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [req.auth.tenantId, id, l.productId, l.poLineId ?? null, l.qtyMilli, l.unitCostAgorot, l.condition]);
      }
      return loadGr(c, id);
    });
  });

  // RCV-06: אישור אטומי — אישור כפול לא מכפיל מלאי. RCV-08: חריגה מההזמנה דורשת allowOver + הרשאת אישור
  app.post('/goods-receipts/:id/post', { preHandler: requireAuth('inventory:receive') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ allowOver: z.boolean().default(false) }).parse(req.body ?? {});
    return tx(req, async (c) => {
      const gr = await one(c, 'SELECT * FROM goods_receipts WHERE id = $1 FOR UPDATE', [id]);
      if (!gr) throw notFound('הקליטה');
      if (gr.status === 'posted') return { ...(await loadGr(c, id)), replay: true };
      const lines = await many(c, 'SELECT l.*, p.name FROM goods_receipt_lines l JOIN products p ON p.id = l.product_id WHERE l.receipt_id = $1', [id]);
      if (lines.length === 0) throw new AppError(422, 'invalid', 'אין שורות לקליטה');
      const over: string[] = [];
      for (const l of lines) {
        if (!l.po_line_id) continue;
        const pl = await one(c, 'SELECT * FROM purchase_order_lines WHERE id = $1 FOR UPDATE', [l.po_line_id]);
        if (pl && pl.received_qty_milli + l.qty_milli > pl.qty_milli) over.push(l.name);
      }
      if (over.length && !b.allowOver) {
        throw new AppError(409, 'over_receipt', `כמות גדולה מההזמנה: ${over.join(', ')}. צריך אישור מנהל.`, { data: { over } });
      }
      if (over.length) assertPerm(req, 'inventory:approve', 'קליטה מעל ההזמנה דורשת אישור מנהל');
      for (const l of lines) {
        await addMovement(c, {
          tenantId: req.auth.tenantId, branchId: gr.branch_id, productId: l.product_id, qtyDeltaMilli: l.qty_milli,
          location: l.condition === 'damaged' ? 'damaged' : 'sale', unitCost: l.unit_cost_agorot, sourceType: 'goods_receipt', sourceId: id, actorId: req.auth.userId,
        });
        if (l.condition === 'ok') await updateAverageCost(c, l.product_id, l.qty_milli, l.unit_cost_agorot);
        if (l.po_line_id) await c.query('UPDATE purchase_order_lines SET received_qty_milli = received_qty_milli + $2 WHERE id = $1', [l.po_line_id, l.qty_milli]);
      }
      if (gr.po_id) {
        const open = await one(c, 'SELECT COUNT(*)::int AS n FROM purchase_order_lines WHERE po_id = $1 AND received_qty_milli < qty_milli', [gr.po_id]);
        await c.query('UPDATE purchase_orders SET status = $2 WHERE id = $1', [gr.po_id, open.n === 0 ? 'received' : 'partial']);
      }
      await c.query("UPDATE goods_receipts SET status = 'posted', posted_by = $2, posted_at = now() WHERE id = $1", [id, req.auth.userId]);
      const out = await loadGr(c, id);
      // PUR-07: התאמה לחשבונית ספק — מוצגת, לא חוסמת
      const variance = gr.supplier_invoice_total_agorot != null ? gr.supplier_invoice_total_agorot - out.total_agorot : null;
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'goods_receipt.post', targetType: 'goods_receipt', targetId: id, details: { lines: lines.length, total: out.total_agorot, variance, over } });
      await c.query(`INSERT INTO outbox_events (tenant_id, event_type, payload) VALUES ($1,'GoodsReceiptPosted',$2)`, [req.auth.tenantId, JSON.stringify({ id, number: gr.number })]);
      return { ...out, invoice_variance_agorot: variance };
    });
  });

  // RCV-07: החזרה לספק — יציאת מלאי מתועדת, הפריט לא נשאר זמין למכירה
  app.post('/supplier-returns', { preHandler: requireAuth('inventory:receive') }, async (req) => {
    const b = z.object({
      supplierId: z.string().uuid(), branchId: z.string().uuid(), reason: z.string().min(2),
      lines: z.array(z.object({ productId: z.string().uuid(), qtyMilli: z.number().int().positive(), location: z.enum(['sale', 'damaged']).default('damaged') })).min(1),
    }).parse(req.body);
    branchScope(req, b.branchId);
    return tx(req, async (c) => {
      const id = (await one(c, 'SELECT gen_random_uuid() AS id')).id;
      for (const l of b.lines) {
        const p = await one(c, 'SELECT name, cost_agorot FROM products WHERE id = $1', [l.productId]);
        if (!p) throw notFound('המוצר');
        await takeStock(c, {
          tenantId: req.auth.tenantId, branchId: b.branchId, productId: l.productId, qtyDeltaMilli: -l.qtyMilli, location: l.location,
          unitCost: p.cost_agorot, sourceType: 'supplier_return', sourceId: id, reason: b.reason, actorId: req.auth.userId, allowNegative: false, productName: p.name,
        });
      }
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'supplier_return', targetType: 'supplier', targetId: b.supplierId, details: { id, lines: b.lines.length, reason: b.reason } });
      return { id };
    });
  });
}
