// קטלוג (PRD-01..PRD-08, PRI-01, PRI-05, INV-09): מוצרים, ברקודים, מחיר סניף, ייבוא, ארכוב, מדבקות מדף
import { DEFAULT_SCALE, internalBarcode, normalizeBarcode, parseScaleBarcode } from '@dlx/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { hasPerm, requireAuth, tx } from '../auth.js';
import { type Db, many, nextNumber, one } from '../db.js';
import { AppError, notFound } from '../errors.js';

const BarcodeIn = z.object({
  barcode: z.string().min(3).max(32).transform(normalizeBarcode),
  unitFactorMilli: z.number().int().positive().default(1000),
  kind: z.enum(['unit', 'pack', 'carton', 'internal']).default('unit'),
});

export const ProductIn = z.object({
  sku: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(80).nullable().optional(),
  brand: z.string().max(80).nullable().optional(),
  unitMeasure: z.enum(['unit', 'kg', 'g', 'liter', 'ml', 'meter']).default('unit'),
  soldByWeight: z.boolean().default(false),
  priceAgorot: z.number().int().min(0),
  costAgorot: z.number().int().min(0).optional(),
  taxCategory: z.enum(['standard', 'zero', 'exempt']).default('standard'),
  restriction: z.enum(['none', 'age18', 'alcohol', 'tobacco']).default('none'),
  depositAgorot: z.number().int().min(0).default(0),
  unitPriceBasis: z.string().max(30).nullable().optional(),
  unitPriceFactorMilli: z.number().int().positive().nullable().optional(),
  trackStock: z.boolean().default(true),
  minStockMilli: z.number().int().min(0).default(0),
  scaleCode: z.string().regex(/^\d{5}$/).nullable().optional(),
  barcodes: z.array(BarcodeIn).default([]),
  version: z.number().int().optional(),
});
export type ProductInput = z.infer<typeof ProductIn>;

// T20: עלות ורווחיות רק למי שמורשה
export function publicProduct(req: FastifyRequest, p: any) {
  if (!p) return p;
  if (hasPerm(req, 'costs:read')) return p;
  const { cost_agorot: _c, ...rest } = p;
  return rest;
}

async function categoryId(c: Db, tenantId: string, name?: string | null) {
  if (!name) return null;
  const r = await one(c, `INSERT INTO categories (tenant_id, name) VALUES ($1,$2) ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [tenantId, name.trim()]);
  return r.id as string;
}

// PRD-05: ברקוד שכבר שייך למוצר אחר — חסימה ברורה, לא דריסה
async function setBarcodes(c: Db, tenantId: string, productId: string, barcodes: z.infer<typeof BarcodeIn>[]) {
  for (const b of barcodes) {
    const owner = await one(c, 'SELECT b.product_id, p.name FROM barcodes b JOIN products p ON p.id = b.product_id WHERE b.barcode = $1', [b.barcode]);
    if (owner && owner.product_id !== productId) {
      throw new AppError(409, 'barcode_taken', `הברקוד ${b.barcode} כבר משויך ל"${owner.name}"`, { fieldErrors: { barcodes: b.barcode } });
    }
  }
  await c.query('DELETE FROM barcodes WHERE product_id = $1 AND NOT (barcode = ANY($2::text[]))', [productId, barcodes.map((b) => b.barcode)]);
  for (const b of barcodes) {
    await c.query(
      `INSERT INTO barcodes (tenant_id, barcode, product_id, unit_factor_milli, kind) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, barcode) DO UPDATE SET unit_factor_milli = EXCLUDED.unit_factor_milli, kind = EXCLUDED.kind`,
      [tenantId, b.barcode, productId, b.unitFactorMilli, b.kind]);
  }
}

export async function createProduct(c: Db, tenantId: string, actorId: string, b: ProductInput) {
  const cat = await categoryId(c, tenantId, b.category);
  const p = await one(c,
    `INSERT INTO products (tenant_id, sku, name, description, category_id, brand, unit_measure, sold_by_weight, price_agorot, cost_agorot, tax_category,
       restriction, deposit_agorot, unit_price_basis, unit_price_factor_milli, track_stock, min_stock_milli, scale_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [tenantId, b.sku, b.name, b.description ?? null, cat, b.brand ?? null, b.unitMeasure, b.soldByWeight, b.priceAgorot, b.costAgorot ?? 0, b.taxCategory,
      b.restriction, b.depositAgorot, b.unitPriceBasis ?? null, b.unitPriceFactorMilli ?? null, b.trackStock, b.minStockMilli, b.scaleCode ?? null]);
  let codes = b.barcodes;
  if (codes.length === 0 && !b.soldByWeight) {
    const n = await nextNumber(c, tenantId, 'internal_barcode');
    codes = [{ barcode: internalBarcode(n), unitFactorMilli: 1000, kind: 'internal' }];
  }
  await setBarcodes(c, tenantId, p.id, codes);
  await c.query('INSERT INTO price_changes (tenant_id, product_id, old_price, new_price, actor_id) VALUES ($1,$2,NULL,$3,$4)', [tenantId, p.id, b.priceAgorot, actorId]);
  return p;
}

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category,
    COALESCE((SELECT json_agg(json_build_object('barcode', b.barcode, 'unitFactorMilli', b.unit_factor_milli, 'kind', b.kind) ORDER BY b.kind, b.barcode)
      FROM barcodes b WHERE b.product_id = p.id), '[]') AS barcodes
  FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

export async function branchPrice(c: Db, productId: string, branchId: string | null, at = new Date()): Promise<number | null> {
  if (!branchId) return null;
  const r = await one<{ price_agorot: number }>(c,
    `SELECT price_agorot FROM branch_prices WHERE product_id = $1 AND branch_id = $2 AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)
     ORDER BY valid_from DESC LIMIT 1`, [productId, branchId, at.toISOString()]);
  return r?.price_agorot ?? null;
}

export async function catalogRoutes(app: FastifyInstance) {
  app.get('/products', { preHandler: requireAuth('catalog:read') }, async (req) => {
    const q = z.object({
      q: z.string().optional(), status: z.enum(['active', 'archived', 'all']).default('active'), category: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const rows = await tx(req, (c) => many(c,
      `${PRODUCT_SELECT}
       WHERE ($1::text = 'all' OR p.status = $1)
         AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%' OR p.sku ILIKE $2 || '%' OR EXISTS (SELECT 1 FROM barcodes b WHERE b.product_id = p.id AND b.barcode = $2))
         AND ($3::text IS NULL OR c.name = $3)
       ORDER BY p.name LIMIT $4 OFFSET $5`, [q.status, q.q?.trim() || null, q.category ?? null, q.limit, q.offset]));
    return rows.map((p) => publicProduct(req, p));
  });

  app.get('/categories', { preHandler: requireAuth('catalog:read') }, async (req) => tx(req, (c) => many(c, 'SELECT id, name FROM categories ORDER BY name')));

  // סריקה בקופה (POS-01, PRD-02, G-17): ברקוד רגיל / אריזה / מאזניים
  app.get('/products/lookup', { preHandler: requireAuth('catalog:read') }, async (req) => {
    const q = z.object({ code: z.string().min(1).transform(normalizeBarcode), branchId: z.string().uuid().optional() }).parse(req.query);
    return tx(req, async (c) => {
      let p = await one(c, `${PRODUCT_SELECT} JOIN barcodes bc ON bc.product_id = p.id WHERE bc.barcode = $1 AND p.status = 'active'`, [q.code]);
      let qtyMilli = 1000;
      let price: number | null = null;
      if (p) {
        const bc = (p.barcodes as any[]).find((b) => b.barcode === q.code);
        qtyMilli = bc?.unitFactorMilli ?? 1000;
      } else {
        const scale = parseScaleBarcode(q.code, DEFAULT_SCALE);
        if (scale) {
          p = await one(c, `${PRODUCT_SELECT} WHERE p.scale_code = $1 AND p.status = 'active'`, [scale.itemCode]);
          if (p && scale.qtyMilli !== undefined) qtyMilli = scale.qtyMilli;
          if (p && scale.price !== undefined) { price = scale.price; qtyMilli = 1000; }
        }
      }
      if (!p) {
        p = await one(c, `${PRODUCT_SELECT} WHERE p.sku = $1 AND p.status = 'active'`, [q.code]);
      }
      if (!p) throw new AppError(404, 'unknown_barcode', `לא נמצא מוצר לברקוד ${q.code}`);
      const bp = await branchPrice(c, p.id, q.branchId ?? req.auth.branchId);
      return { product: publicProduct(req, p), qtyMilli, unitPrice: price ?? bp ?? p.price_agorot, fixedLinePrice: price !== null };
    });
  });

  app.get('/products/:id', { preHandler: requireAuth('catalog:read') }, async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const p = await one(c, `${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
      if (!p) throw notFound('המוצר');
      const stock = await many(c,
        `SELECT b.id AS branch_id, b.name AS branch_name,
           COALESCE(SUM(m.qty_delta_milli) FILTER (WHERE m.location='sale'),0) AS on_hand,
           COALESCE(SUM(m.qty_delta_milli) FILTER (WHERE m.location='damaged'),0) AS damaged
         FROM branches b LEFT JOIN stock_movements m ON m.branch_id = b.id AND m.product_id = $1 GROUP BY b.id ORDER BY b.created_at`, [id]);
      const prices = await many(c, 'SELECT bp.*, b.name AS branch_name FROM branch_prices bp JOIN branches b ON b.id = bp.branch_id WHERE product_id = $1 ORDER BY valid_from DESC LIMIT 20', [id]);
      const history = await many(c, 'SELECT id, branch_id, old_price, new_price, created_at FROM price_changes WHERE product_id = $1 ORDER BY id DESC LIMIT 20', [id]);
      return { ...publicProduct(req, p), stock, branch_prices: prices, price_history: history };
    });
  });

  app.post('/products', { preHandler: requireAuth('catalog:write') }, async (req) => {
    const b = ProductIn.parse(req.body);
    return tx(req, async (c) => {
      const p = await createProduct(c, req.auth.tenantId, req.auth.userId, b);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'product.create', targetType: 'product', targetId: p.id, details: { sku: b.sku } });
      return publicProduct(req, await one(c, `${PRODUCT_SELECT} WHERE p.id = $1`, [p.id]));
    });
  });

  app.put('/products/:id', { preHandler: requireAuth('catalog:write') }, async (req) => {
    const b = ProductIn.parse(req.body);
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const cur = await one(c, 'SELECT * FROM products WHERE id = $1 FOR UPDATE', [id]);
      if (!cur) throw notFound('המוצר');
      if (b.version !== undefined && b.version !== cur.version) throw new AppError(409, 'stale', 'המוצר עודכן בינתיים על ידי משתמש אחר. רעננו ונסו שוב.');
      const cat = await categoryId(c, req.auth.tenantId, b.category);
      // עלות משתנה רק בקליטה (ממוצע נע) או למורשה עלויות
      const cost = hasPerm(req, 'costs:read') && b.costAgorot !== undefined ? b.costAgorot : cur.cost_agorot;
      await c.query(
        `UPDATE products SET sku=$2, name=$3, description=$4, category_id=$5, brand=$6, unit_measure=$7, sold_by_weight=$8, price_agorot=$9, cost_agorot=$10,
           tax_category=$11, restriction=$12, deposit_agorot=$13, unit_price_basis=$14, unit_price_factor_milli=$15, track_stock=$16, min_stock_milli=$17,
           scale_code=$18, version = version + 1 WHERE id = $1`,
        [id, b.sku, b.name, b.description ?? null, cat, b.brand ?? null, b.unitMeasure, b.soldByWeight, b.priceAgorot, cost, b.taxCategory, b.restriction,
          b.depositAgorot, b.unitPriceBasis ?? null, b.unitPriceFactorMilli ?? null, b.trackStock, b.minStockMilli, b.scaleCode ?? null]);
      await setBarcodes(c, req.auth.tenantId, id, b.barcodes);
      if (cur.price_agorot !== b.priceAgorot) {
        await c.query('INSERT INTO price_changes (tenant_id, product_id, old_price, new_price, actor_id) VALUES ($1,$2,$3,$4,$5)',
          [req.auth.tenantId, id, cur.price_agorot, b.priceAgorot, req.auth.userId]);
      }
      await audit(c, {
        tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'product.update', targetType: 'product', targetId: id,
        details: { price: cur.price_agorot !== b.priceAgorot ? [cur.price_agorot, b.priceAgorot] : undefined, tax: cur.tax_category !== b.taxCategory ? [cur.tax_category, b.taxCategory] : undefined },
      });
      return publicProduct(req, await one(c, `${PRODUCT_SELECT} WHERE p.id = $1`, [id]));
    });
  });

  // PRD-08: מוצר עם היסטוריה לא נמחק — רק מאורכב
  app.post('/products/:id/archive', { preHandler: requireAuth('catalog:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const { archived } = z.object({ archived: z.boolean().default(true) }).parse(req.body ?? {});
    return tx(req, async (c) => {
      const r = await one(c, 'UPDATE products SET status = $2 WHERE id = $1 RETURNING id, status', [id, archived ? 'archived' : 'active']);
      if (!r) throw notFound('המוצר');
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: archived ? 'product.archive' : 'product.restore', targetType: 'product', targetId: id });
      return r;
    });
  });

  // PRI-01: מחיר סניף עם תוקף
  app.post('/products/:id/branch-prices', { preHandler: requireAuth('catalog:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ branchId: z.string().uuid(), priceAgorot: z.number().int().min(0), validFrom: z.string().datetime().optional(), validTo: z.string().datetime().nullable().optional() }).parse(req.body);
    return tx(req, async (c) => {
      const r = await one(c, 'INSERT INTO branch_prices (tenant_id, product_id, branch_id, price_agorot, valid_from, valid_to) VALUES ($1,$2,$3,$4,COALESCE($5, now()),$6) RETURNING *',
        [req.auth.tenantId, id, b.branchId, b.priceAgorot, b.validFrom ?? null, b.validTo ?? null]);
      await c.query('INSERT INTO price_changes (tenant_id, product_id, branch_id, old_price, new_price, actor_id) VALUES ($1,$2,$3,NULL,$4,$5)',
        [req.auth.tenantId, id, b.branchId, b.priceAgorot, req.auth.userId]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'price.branch', targetType: 'product', targetId: id, details: { branch: b.branchId, price: b.priceAgorot } });
      return r;
    });
  });

  // PRD-07: ייבוא — שורה לא תקינה לא יוצרת מוצר; דוח שגיאות לכל שורה
  app.post('/products/import', { preHandler: requireAuth('catalog:write') }, async (req) => {
    const b = z.object({ rows: z.array(z.record(z.string(), z.unknown())).max(5000), dryRun: z.boolean().default(false) }).parse(req.body);
    return tx(req, async (c) => {
      const report: { row: number; ok: boolean; sku?: string; error?: string }[] = [];
      const seen = new Set<string>();
      let created = 0;
      for (const [i, raw] of b.rows.entries()) {
        const parsed = ProductIn.safeParse({
          sku: String(raw.sku ?? '').trim(), name: String(raw.name ?? '').trim(), category: raw.category ? String(raw.category) : null,
          priceAgorot: Math.round(Number(String(raw.price ?? '').replace(/[₪,\s]/g, '')) * 100),
          costAgorot: raw.cost ? Math.round(Number(String(raw.cost).replace(/[₪,\s]/g, '')) * 100) : undefined,
          taxCategory: raw.taxCategory || 'standard', barcodes: raw.barcode ? [{ barcode: String(raw.barcode) }] : [],
          unitMeasure: raw.unitMeasure || 'unit',
        });
        if (!parsed.success) { report.push({ row: i + 1, ok: false, sku: String(raw.sku ?? ''), error: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') }); continue; }
        const p = parsed.data;
        if (seen.has(p.sku)) { report.push({ row: i + 1, ok: false, sku: p.sku, error: 'מק"ט כפול בקובץ' }); continue; }
        seen.add(p.sku);
        if (await one(c, 'SELECT 1 FROM products WHERE sku = $1', [p.sku])) { report.push({ row: i + 1, ok: false, sku: p.sku, error: 'מק"ט כבר קיים' }); continue; }
        if (b.dryRun) { report.push({ row: i + 1, ok: true, sku: p.sku }); continue; }
        await c.query('SAVEPOINT imp');
        try {
          await createProduct(c, req.auth.tenantId, req.auth.userId, p);
          await c.query('RELEASE SAVEPOINT imp');
          created++;
          report.push({ row: i + 1, ok: true, sku: p.sku });
        } catch (e: any) {
          await c.query('ROLLBACK TO SAVEPOINT imp');
          report.push({ row: i + 1, ok: false, sku: p.sku, error: e.message });
        }
      }
      if (!b.dryRun) await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'product.import', details: { rows: b.rows.length, created } });
      return { created, failed: report.filter((r) => !r.ok).length, report };
    });
  });

  // O-06: מדבקות מדף — מוצרים שהמחיר שלהם השתנה ועוד לא הודפסה מדבקה
  app.get('/labels/pending', { preHandler: requireAuth('catalog:read') }, async (req) => tx(req, (c) => many(c,
    `SELECT DISTINCT ON (pc.product_id, pc.branch_id) pc.id, pc.product_id, pc.branch_id, pc.new_price, pc.created_at, p.name, p.sku,
       p.unit_price_basis, p.unit_price_factor_milli,
       (SELECT barcode FROM barcodes b WHERE b.product_id = p.id ORDER BY (b.kind = 'unit') DESC LIMIT 1) AS barcode
     FROM price_changes pc JOIN products p ON p.id = pc.product_id
     WHERE pc.label_printed_at IS NULL AND p.status = 'active' ORDER BY pc.product_id, pc.branch_id, pc.id DESC`)));
  app.post('/labels/printed', { preHandler: requireAuth('catalog:read') }, async (req) => {
    const b = z.object({ productIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
    return tx(req, async (c) => {
      const r = await c.query('UPDATE price_changes SET label_printed_at = now() WHERE product_id = ANY($1::uuid[]) AND label_printed_at IS NULL', [b.productIds]);
      return { updated: r.rowCount };
    });
  });
}
