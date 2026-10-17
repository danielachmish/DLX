// מלאי: יתרות, יומן תנועות, התאמות, העברות וספירות (INV-01..INV-07, WF-05, T27, T28)
import { assertTransition } from '@dlx/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { branchScope, hasPerm, requireAuth, tx } from '../auth.js';
import { type Db, many, nextNumber, one } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { addMovement, availability, lockStock, onHand, takeStock } from '../services/stock.js';

async function loadCount(c: Db, id: string) {
  const ic = await one(c, 'SELECT ic.*, b.name AS branch_name FROM inventory_counts ic JOIN branches b ON b.id = ic.branch_id WHERE ic.id = $1', [id]);
  if (!ic) throw notFound('הספירה');
  ic.lines = await many(c,
    `SELECT l.*, p.name, p.sku, p.cost_agorot,
       (SELECT barcode FROM barcodes b WHERE b.product_id = p.id ORDER BY (b.kind='unit') DESC LIMIT 1) AS barcode,
       CASE WHEN l.counted_milli IS NULL THEN NULL ELSE l.counted_milli - l.expected_milli END AS diff_milli
     FROM inventory_count_lines l JOIN products p ON p.id = l.product_id WHERE l.count_id = $1 ORDER BY p.name`, [id]);
  return ic;
}

export async function stockRoutes(app: FastifyInstance) {
  app.get('/stock/availability', { preHandler: requireAuth('stock:read') }, async (req) => {
    const q = z.object({
      branchId: z.string().uuid().optional(), productId: z.string().uuid().optional(), q: z.string().optional(), low: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const branchId = branchScope(req, q.branchId);
    const rows = await tx(req, (c) => availability(c, { ...q, branchId }));
    return hasPerm(req, 'costs:read') ? rows : rows.map(({ cost_agorot: _c, ...r }) => r);
  });

  // INV-01: כל תנועה עם סיבה, כמות, סניף ומקור — לשחזור יתרה מכל תאריך
  app.get('/stock/movements', { preHandler: requireAuth('stock:read') }, async (req) => {
    const q = z.object({
      productId: z.string().uuid().optional(), branchId: z.string().uuid().optional(), sourceType: z.string().optional(),
      from: z.string().optional(), to: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200),
    }).parse(req.query);
    const branchId = branchScope(req, q.branchId);
    return tx(req, (c) => many(c,
      `SELECT m.id, m.created_at, m.qty_delta_milli, m.location, m.source_type, m.source_id, m.reason, p.name, p.sku, b.name AS branch_name, u.name AS actor_name
       FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN branches b ON b.id = m.branch_id LEFT JOIN users u ON u.id = m.actor_id
       WHERE ($1::uuid IS NULL OR m.product_id = $1) AND ($2::uuid IS NULL OR m.branch_id = $2) AND ($3::text IS NULL OR m.source_type = $3)
         AND ($4::timestamptz IS NULL OR m.created_at >= $4) AND ($5::timestamptz IS NULL OR m.created_at < $5)
       ORDER BY m.id DESC LIMIT $6`, [q.productId ?? null, branchId, q.sourceType ?? null, q.from ?? null, q.to ?? null, q.limit]));
  });

  // התאמת מלאי ידנית: רק עם סיבה ורק למורשה אישור (IAM-03, INV-01)
  app.post('/stock/adjustments', { preHandler: requireAuth('stock:approve') }, async (req) => {
    const b = z.object({
      branchId: z.string().uuid(), reason: z.string().min(2),
      lines: z.array(z.object({ productId: z.string().uuid(), qtyDeltaMilli: z.number().int().refine((v) => v !== 0), location: z.enum(['sale', 'damaged']).default('sale') })).min(1),
    }).parse(req.body);
    branchScope(req, b.branchId);
    return tx(req, async (c) => {
      const id = (await one(c, 'SELECT gen_random_uuid() AS id')).id;
      for (const l of b.lines) {
        const p = await one(c, 'SELECT name, cost_agorot FROM products WHERE id = $1', [l.productId]);
        if (!p) throw notFound('המוצר');
        await lockStock(c, req.auth.tenantId, b.branchId, l.productId);
        await addMovement(c, { tenantId: req.auth.tenantId, branchId: b.branchId, productId: l.productId, qtyDeltaMilli: l.qtyDeltaMilli, location: l.location, unitCost: p.cost_agorot, sourceType: 'adjustment', sourceId: id, reason: b.reason, actorId: req.auth.userId });
      }
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'stock.adjust', targetType: 'adjustment', targetId: id, details: { reason: b.reason, lines: b.lines } });
      return { id };
    });
  });

  // מלאי פתיחה (INT-07) — פעם אחת לכל מוצר-סניף
  app.post('/stock/opening', { preHandler: requireAuth('stock:approve') }, async (req) => {
    const b = z.object({ branchId: z.string().uuid(), lines: z.array(z.object({ productId: z.string().uuid(), qtyMilli: z.number().int().positive(), unitCostAgorot: z.number().int().min(0).optional() })).min(1) }).parse(req.body);
    return tx(req, async (c) => {
      let created = 0;
      for (const l of b.lines) {
        const exists = await one(c, "SELECT 1 FROM stock_movements WHERE branch_id = $1 AND product_id = $2 AND source_type = 'opening'", [b.branchId, l.productId]);
        if (exists) continue;
        const p = await one(c, 'SELECT cost_agorot FROM products WHERE id = $1', [l.productId]);
        await addMovement(c, { tenantId: req.auth.tenantId, branchId: b.branchId, productId: l.productId, qtyDeltaMilli: l.qtyMilli, unitCost: l.unitCostAgorot ?? p?.cost_agorot ?? 0, sourceType: 'opening', reason: 'מלאי פתיחה', actorId: req.auth.userId });
        if (l.unitCostAgorot !== undefined) await c.query('UPDATE products SET cost_agorot = $2 WHERE id = $1 AND cost_agorot = 0', [l.productId, l.unitCostAgorot]);
        created++;
      }
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'stock.opening', details: { branch: b.branchId, created } });
      return { created };
    });
  });

  // INV-07, T28: העברה בין סניפים — יציאה מסניף אחד וכניסה לשני באותה טרנזקציה, יחידה לא נספרת פעמיים
  app.post('/stock/transfers', { preHandler: requireAuth('stock:approve') }, async (req) => {
    const b = z.object({
      fromBranchId: z.string().uuid(), toBranchId: z.string().uuid(), reason: z.string().default('העברה בין סניפים'),
      lines: z.array(z.object({ productId: z.string().uuid(), qtyMilli: z.number().int().positive() })).min(1),
    }).parse(req.body);
    if (b.fromBranchId === b.toBranchId) throw new AppError(422, 'invalid', 'סניף מקור ויעד זהים');
    return tx(req, async (c) => {
      const t = await one(c, 'SELECT allow_negative_stock FROM tenants WHERE id = $1', [req.auth.tenantId]);
      const id = (await one(c, 'SELECT gen_random_uuid() AS id')).id;
      for (const l of b.lines) {
        const p = await one(c, 'SELECT name, cost_agorot FROM products WHERE id = $1', [l.productId]);
        if (!p) throw notFound('המוצר');
        await takeStock(c, { tenantId: req.auth.tenantId, branchId: b.fromBranchId, productId: l.productId, qtyDeltaMilli: -l.qtyMilli, unitCost: p.cost_agorot, sourceType: 'transfer', sourceId: id, reason: b.reason, actorId: req.auth.userId, allowNegative: t.allow_negative_stock, productName: p.name });
        await addMovement(c, { tenantId: req.auth.tenantId, branchId: b.toBranchId, productId: l.productId, qtyDeltaMilli: l.qtyMilli, unitCost: p.cost_agorot, sourceType: 'transfer', sourceId: id, reason: b.reason, actorId: req.auth.userId });
      }
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'stock.transfer', targetType: 'transfer', targetId: id, details: b });
      return { id };
    });
  });

  // ===== ספירות (INV-05, WF-05) =====
  app.get('/inventory-counts', { preHandler: requireAuth('stock:read') }, async (req) => tx(req, (c) => many(c,
    `SELECT ic.id, ic.number, ic.status, ic.scope, ic.snapshot_at, ic.created_at, ic.posted_at, b.name AS branch_name,
       (SELECT COUNT(*) FROM inventory_count_lines l WHERE l.count_id = ic.id)::int AS lines,
       (SELECT COUNT(*) FROM inventory_count_lines l WHERE l.count_id = ic.id AND l.counted_milli IS NOT NULL)::int AS counted
     FROM inventory_counts ic JOIN branches b ON b.id = ic.branch_id ORDER BY ic.number DESC LIMIT 100`)));

  app.get('/inventory-counts/:id', { preHandler: requireAuth('stock:read') }, async (req) => {
    const ic = await tx(req, (c) => loadCount(c, (req.params as any).id));
    if (!hasPerm(req, 'costs:read')) ic.lines = ic.lines.map(({ cost_agorot: _c, ...l }: any) => l);
    return ic;
  });

  // פתיחת ספירה: snapshot של היתרה הצפויה לכל מוצר בהיקף
  app.post('/inventory-counts', { preHandler: requireAuth('stock:count') }, async (req) => {
    const b = z.object({ branchId: z.string().uuid(), category: z.string().optional(), productIds: z.array(z.string().uuid()).optional(), scope: z.string().optional() }).parse(req.body);
    branchScope(req, b.branchId);
    return tx(req, async (c) => {
      const number = await nextNumber(c, req.auth.tenantId, 'count');
      const ic = await one(c, 'INSERT INTO inventory_counts (tenant_id, number, branch_id, scope, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, snapshot_at',
        [req.auth.tenantId, number, b.branchId, b.scope ?? b.category ?? (b.productIds ? 'בחירה' : 'מלאה'), req.auth.userId]);
      await c.query(
        `INSERT INTO inventory_count_lines (tenant_id, count_id, product_id, expected_milli)
         SELECT $1, $2, p.id, COALESCE((SELECT SUM(qty_delta_milli) FROM stock_movements m WHERE m.product_id = p.id AND m.branch_id = $3 AND m.location = 'sale'),0)
         FROM products p LEFT JOIN categories cat ON cat.id = p.category_id
         WHERE p.track_stock AND p.status = 'active' AND ($4::text IS NULL OR cat.name = $4) AND ($5::uuid[] IS NULL OR p.id = ANY($5))`,
        [req.auth.tenantId, ic.id, b.branchId, b.category ?? null, b.productIds ?? null]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'count.open', targetType: 'inventory_count', targetId: ic.id, details: { number } });
      return loadCount(c, ic.id);
    });
  });

  // רישום כמויות שנספרו (אפשר בכמה סבבים; mode=add לסריקה חוזרת של אותו פריט)
  app.put('/inventory-counts/:id/lines', { preHandler: requireAuth('stock:count') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ mode: z.enum(['set', 'add']).default('set'), lines: z.array(z.object({ productId: z.string().uuid(), countedMilli: z.number().int().min(0) })).min(1) }).parse(req.body);
    return tx(req, async (c) => {
      const ic = await one(c, 'SELECT * FROM inventory_counts WHERE id = $1 FOR UPDATE', [id]);
      if (!ic) throw notFound('הספירה');
      if (ic.status !== 'open' && ic.status !== 'counted') throw new AppError(409, 'invalid_state', 'הספירה כבר בבדיקה או אושרה');
      for (const l of b.lines) {
        const r = await c.query(
          `UPDATE inventory_count_lines SET counted_milli = CASE WHEN $3 = 'add' THEN COALESCE(counted_milli,0) + $4 ELSE $4 END WHERE count_id = $1 AND product_id = $2`,
          [id, l.productId, b.mode, l.countedMilli]);
        if (r.rowCount === 0) {
          // פריט שלא היה בהיקף — נכנס עם הצפי הנוכחי
          const exp = await onHand(c, ic.branch_id, l.productId);
          await c.query('INSERT INTO inventory_count_lines (tenant_id, count_id, product_id, expected_milli, counted_milli) VALUES ($1,$2,$3,$4,$5)', [req.auth.tenantId, id, l.productId, exp, l.countedMilli]);
        }
      }
      return loadCount(c, id);
    });
  });

  app.post('/inventory-counts/:id/:action', { preHandler: requireAuth('stock:count') }, async (req) => {
    const { id, action } = z.object({ id: z.string().uuid(), action: z.enum(['submit', 'review', 'reopen', 'post']) }).parse(req.params);
    return tx(req, async (c) => {
      const ic = await one(c, 'SELECT * FROM inventory_counts WHERE id = $1 FOR UPDATE', [id]);
      if (!ic) throw notFound('הספירה');
      if (action === 'post' && ic.status === 'posted') return { ...(await loadCount(c, id)), replay: true };
      const to = ({ submit: 'counted', review: 'reviewed', reopen: ic.status === 'reviewed' ? 'counted' : 'open', post: 'posted' } as const)[action];
      assertTransition('inventory_count', ic.status, to as any);
      if (action === 'post' || action === 'review') {
        if (!hasPerm(req, 'stock:approve')) throw new AppError(403, 'forbidden', 'אישור ספירה דורש מנהל');
      }
      if (action === 'post') {
        // T27: הפרש = נספר − הצפי ב-snapshot. מכירות שקרו אחרי ה-snapshot כבר בתנועות, ולא נדרסות
        const lines = await many(c, 'SELECT l.*, p.cost_agorot FROM inventory_count_lines l JOIN products p ON p.id = l.product_id WHERE l.count_id = $1 AND l.counted_milli IS NOT NULL', [id]);
        for (const l of lines) {
          const diff = l.counted_milli - l.expected_milli;
          if (diff !== 0) {
            await lockStock(c, req.auth.tenantId, ic.branch_id, l.product_id);
            await addMovement(c, { tenantId: req.auth.tenantId, branchId: ic.branch_id, productId: l.product_id, qtyDeltaMilli: diff, unitCost: l.cost_agorot, sourceType: 'count', sourceId: id, reason: `ספירה ${ic.number}`, actorId: req.auth.userId });
          }
        }
        await c.query('UPDATE inventory_counts SET status = $2, posted_by = $3, posted_at = now() WHERE id = $1', [id, to, req.auth.userId]);
        const value = lines.reduce((a, l) => a + Math.round(((l.counted_milli - l.expected_milli) * l.cost_agorot) / 1000), 0);
        await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'count.post', targetType: 'inventory_count', targetId: id, details: { lines: lines.length, value_agorot: value } });
      } else {
        await c.query('UPDATE inventory_counts SET status = $2 WHERE id = $1', [id, to]);
      }
      return loadCount(c, id);
    });
  });
}
