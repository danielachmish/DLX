// מלאי (INV-01..INV-04): היתרה היא תמיד סכום התנועות. אין עדכון יתרה ישיר, ואין מחיקת תנועה.
import { symmetricRound } from '@dlx/core';
import { type Db, many, one } from '../db.js';
import { AppError } from '../errors.js';

export type Location = 'sale' | 'damaged' | 'transit';
export type SourceType = 'sale' | 'return' | 'goods_receipt' | 'supplier_return' | 'adjustment' | 'count' | 'transfer' | 'opening';

export interface MovementInput {
  tenantId: string; branchId: string; productId: string; qtyDeltaMilli: number; location?: Location;
  unitCost?: number; sourceType: SourceType; sourceId?: string | null; reason?: string | null; actorId?: string | null;
}

// INV-03, T02: נעילה למוצר-סניף — שתי קופות לא מוכרות במקביל את היחידה האחרונה
export async function lockStock(c: Db, tenantId: string, branchId: string, productId: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 11))', [`stock:${tenantId}:${branchId}:${productId}`]);
}

export async function onHand(c: Db, branchId: string, productId: string, location: Location = 'sale'): Promise<number> {
  const r = await one<{ q: number }>(c,
    'SELECT COALESCE(SUM(qty_delta_milli),0) AS q FROM stock_movements WHERE branch_id = $1 AND product_id = $2 AND location = $3',
    [branchId, productId, location]);
  return r?.q ?? 0;
}

export async function addMovement(c: Db, m: MovementInput): Promise<void> {
  if (!m.qtyDeltaMilli) return;
  await c.query(
    `INSERT INTO stock_movements (tenant_id, branch_id, product_id, location, qty_delta_milli, unit_cost_agorot, source_type, source_id, reason, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [m.tenantId, m.branchId, m.productId, m.location ?? 'sale', m.qtyDeltaMilli, m.unitCost ?? 0, m.sourceType, m.sourceId ?? null, m.reason ?? null, m.actorId ?? null]);
}

// יציאת מלאי עם בדיקת מלאי שלילי לפי מדיניות העסק (D07)
export async function takeStock(c: Db, m: MovementInput & { allowNegative: boolean; productName: string }): Promise<void> {
  await lockStock(c, m.tenantId, m.branchId, m.productId);
  const have = await onHand(c, m.branchId, m.productId, m.location ?? 'sale');
  const need = -m.qtyDeltaMilli;
  if (!m.allowNegative && have - need < 0) {
    throw new AppError(409, 'out_of_stock', `אין מספיק מלאי ל"${m.productName}" (יש ${have / 1000})`, { data: { productId: m.productId, have } });
  }
  await addMovement(c, m);
}

// D06: ממוצע נע — עלות ליחידה מתעדכנת בקליטה לפי כל המלאי של העסק
export async function updateAverageCost(c: Db, productId: string, qtyMilli: number, unitCost: number): Promise<number> {
  const p = await one<{ cost_agorot: number; q: number }>(c,
    `SELECT p.cost_agorot, COALESCE((SELECT SUM(qty_delta_milli) FROM stock_movements m WHERE m.product_id = p.id AND m.location = 'sale'),0) AS q
     FROM products p WHERE p.id = $1 FOR UPDATE`, [productId]);
  if (!p) throw new AppError(404, 'not_found', 'המוצר לא נמצא');
  const before = Math.max(0, p.q - qtyMilli); // התנועה של הקליטה כבר נרשמה
  const avg = before <= 0 ? unitCost : symmetricRound((before * p.cost_agorot + qtyMilli * unitCost) / (before + qtyMilli));
  await c.query('UPDATE products SET cost_agorot = $2 WHERE id = $1', [productId, avg]);
  return avg;
}

export interface AvailabilityRow {
  product_id: string; sku: string; name: string; branch_id: string; on_hand: number; damaged: number; min_stock_milli: number;
}

export async function availability(c: Db, opts: { branchId?: string | null; productId?: string; q?: string; low?: boolean; limit?: number; offset?: number }) {
  return many<AvailabilityRow & { available: number; price_agorot: number; cost_agorot: number; unit_measure: string }>(c,
    `SELECT p.id AS product_id, p.sku, p.name, p.unit_measure, p.price_agorot, p.cost_agorot, p.min_stock_milli, b.id AS branch_id, b.name AS branch_name,
       COALESCE(SUM(m.qty_delta_milli) FILTER (WHERE m.location = 'sale'),0) AS on_hand,
       COALESCE(SUM(m.qty_delta_milli) FILTER (WHERE m.location = 'damaged'),0) AS damaged,
       COALESCE(SUM(m.qty_delta_milli) FILTER (WHERE m.location = 'sale'),0) AS available
     FROM products p CROSS JOIN branches b
     LEFT JOIN stock_movements m ON m.product_id = p.id AND m.branch_id = b.id
     WHERE p.track_stock AND p.status = 'active'
       AND ($1::uuid IS NULL OR b.id = $1) AND ($2::uuid IS NULL OR p.id = $2)
       AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%' OR p.sku ILIKE $3 || '%')
     GROUP BY p.id, b.id
     HAVING (NOT $4::boolean OR COALESCE(SUM(m.qty_delta_milli) FILTER (WHERE m.location = 'sale'),0) <= p.min_stock_milli)
     ORDER BY p.name LIMIT $5 OFFSET $6`,
    [opts.branchId ?? null, opts.productId ?? null, opts.q ?? null, !!opts.low, opts.limit ?? 200, opts.offset ?? 0]);
}
