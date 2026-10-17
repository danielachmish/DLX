// משמרות וקופה (CSH-01..CSH-05, WF-04, POS-03, O-01..O-03): פתיחה, תנועות מגירה, דוח X, סגירה עם דוח Z
import { assertTransition } from '@dlx/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { assertPerm, branchScope, requireAuth, tx } from '../auth.js';
import { type Db, many, nextNumber, one } from '../db.js';
import { AppError, notFound } from '../errors.js';

// סטייה שמעליה צריך הסבר ואישור מנהל (₪20)
export const VARIANCE_APPROVAL_AGOROT = 20_00;

export async function sessionReport(c: Db, sessionId: string) {
  const s = await one(c,
    `SELECT s.*, r.code AS register_code, r.name AS register_name, b.name AS branch_name, uo.name AS opened_by_name, uc.name AS closed_by_name
     FROM cash_sessions s JOIN registers r ON r.id = s.register_id JOIN branches b ON b.id = s.branch_id
     LEFT JOIN users uo ON uo.id = s.opened_by LEFT JOIN users uc ON uc.id = s.closed_by WHERE s.id = $1`, [sessionId]);
  if (!s) throw notFound('המשמרת');
  const sales = await one(c,
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(gross_agorot),0) AS gross, COALESCE(SUM(discount_agorot),0) AS discount,
       COALESCE(SUM(net_agorot),0) AS net, COALESCE(SUM(vat_agorot),0) AS vat, COALESCE(SUM(total_agorot),0) AS total,
       COALESCE(SUM(rounding_agorot),0) AS rounding
     FROM sales WHERE session_id = $1 AND status = 'finalized'`, [sessionId]);
  const returns = await one(c,
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_agorot),0) AS total, COALESCE(SUM(net_agorot),0) AS net, COALESCE(SUM(vat_agorot),0) AS vat
     FROM returns WHERE session_id = $1 AND document_id IS NOT NULL`, [sessionId]);
  const pays = await many(c,
    `SELECT method, direction, COUNT(*)::int AS count, COALESCE(SUM(amount_agorot),0) AS amount FROM payments
     WHERE session_id = $1 AND status IN ('captured','refunded_partial','refunded_full') GROUP BY method, direction ORDER BY method`, [sessionId]);
  const events = await many(c, 'SELECT kind, COUNT(*)::int AS count, COALESCE(SUM(amount_agorot),0) AS amount FROM cash_events WHERE session_id = $1 GROUP BY kind', [sessionId]);
  const pending = await one(c, "SELECT COUNT(*)::int AS n FROM sales WHERE session_id = $1 AND status IN ('payment_pending','exception')", [sessionId]);
  const docs = await many(c,
    `SELECT doc_type, MIN(serial) AS first, MAX(serial) AS last, COUNT(*)::int AS count FROM documents d
     WHERE d.register_id = $1 AND d.issued_at >= $2 AND ($3::timestamptz IS NULL OR d.issued_at <= $3) GROUP BY doc_type`,
    [s.register_id, s.opened_at, s.closed_at]);
  const ev = (k: string) => events.find((e) => e.kind === k)?.amount ?? 0;
  const pay = (m: string, d: string) => pays.find((p) => p.method === m && p.direction === d)?.amount ?? 0;
  const expectedCash = s.opening_float_agorot + pay('cash', 'in') - pay('cash', 'out') + ev('paid_in') - ev('drop') - ev('expense') - ev('bank_deposit');
  return {
    session: s, sales, returns, payments: pays, events, documents: docs, pending_sales: pending.n,
    expected_cash_agorot: expectedCash, net_total_agorot: sales.total - returns.total,
  };
}

export async function activeSession(c: Db, registerId: string) {
  return one(c, "SELECT * FROM cash_sessions WHERE register_id = $1 AND status = 'active'", [registerId]);
}

export async function cashRoutes(app: FastifyInstance) {
  app.get('/cash-sessions', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const q = z.object({ registerId: z.string().uuid().optional(), status: z.string().optional() }).parse(req.query);
    return tx(req, (c) => many(c,
      `SELECT s.id, s.number, s.status, s.opened_at, s.closed_at, s.opening_float_agorot, s.expected_cash_agorot, s.counted_cash_agorot, s.variance_agorot,
         r.name AS register_name, b.name AS branch_name, u.name AS opened_by_name,
         (SELECT COALESCE(SUM(total_agorot),0) FROM sales x WHERE x.session_id = s.id AND x.status = 'finalized') AS sales_total
       FROM cash_sessions s JOIN registers r ON r.id = s.register_id JOIN branches b ON b.id = s.branch_id LEFT JOIN users u ON u.id = s.opened_by
       WHERE ($1::uuid IS NULL OR s.register_id = $1) AND ($2::text IS NULL OR s.status = $2) ORDER BY s.number DESC LIMIT 100`,
      [q.registerId ?? null, q.status ?? null]));
  });

  app.get('/cash-sessions/current', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const { registerId } = z.object({ registerId: z.string().uuid() }).parse(req.query);
    return tx(req, async (c) => {
      const s = await one(c, "SELECT id FROM cash_sessions WHERE register_id = $1 AND status <> 'closed'", [registerId]);
      return s ? sessionReport(c, s.id) : null;
    });
  });

  app.get('/cash-sessions/:id', { preHandler: requireAuth('pos:sell') }, async (req) => tx(req, (c) => sessionReport(c, (req.params as any).id)));

  // CSH-01: פתיחה — אין שתי משמרות פתוחות לאותה קופה (אינדקס ייחודי ב-DB)
  app.post('/cash-sessions/open', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const b = z.object({ registerId: z.string().uuid(), openingFloatAgorot: z.number().int().min(0) }).parse(req.body);
    return tx(req, async (c) => {
      const reg = await one(c, 'SELECT * FROM registers WHERE id = $1 AND active', [b.registerId]);
      if (!reg) throw notFound('הקופה');
      branchScope(req, reg.branch_id);
      const open = await one(c, "SELECT id FROM cash_sessions WHERE register_id = $1 AND status <> 'closed'", [b.registerId]);
      if (open) throw new AppError(409, 'session_open', 'כבר יש משמרת פתוחה בקופה הזו', { data: { sessionId: open.id } });
      const number = await nextNumber(c, req.auth.tenantId, 'z');
      const s = await one(c,
        `INSERT INTO cash_sessions (tenant_id, branch_id, register_id, number, status, opened_by, opening_float_agorot) VALUES ($1,$2,$3,$4,'active',$5,$6) RETURNING id`,
        [req.auth.tenantId, reg.branch_id, reg.id, number, req.auth.userId, b.openingFloatAgorot]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'cash.open', targetType: 'cash_session', targetId: s.id, details: { number, float: b.openingFloatAgorot } });
      return sessionReport(c, s.id);
    });
  });

  // CSH-02: תנועת מגירה שאינה מכירה (הכנסה, משיכה לכספת, הוצאה, פתיחה בלי מכירה, הפקדה לבנק) — עם סיבה
  app.post('/cash-sessions/:id/events', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      kind: z.enum(['paid_in', 'drop', 'expense', 'no_sale', 'bank_deposit']), amountAgorot: z.number().int().min(0).default(0), reason: z.string().min(2, 'צריך סיבה'),
    }).parse(req.body);
    if (b.kind !== 'no_sale' && b.amountAgorot <= 0) throw new AppError(422, 'invalid', 'צריך סכום');
    if (['expense', 'bank_deposit', 'drop'].includes(b.kind)) assertPerm(req, 'cash:manage', 'הוצאה / משיכה מהקופה — רק מנהל');
    return tx(req, async (c) => {
      const s = await one(c, 'SELECT * FROM cash_sessions WHERE id = $1 FOR UPDATE', [id]);
      if (!s) throw notFound('המשמרת');
      if (s.status !== 'active') throw new AppError(409, 'invalid_state', 'המשמרת לא פעילה');
      const r = await one(c, 'INSERT INTO cash_events (tenant_id, session_id, kind, amount_agorot, reason, actor_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [req.auth.tenantId, id, b.kind, b.amountAgorot, b.reason, req.auth.userId]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: `cash.${b.kind}`, targetType: 'cash_session', targetId: id, details: { amount: b.amountAgorot, reason: b.reason } });
      return r;
    });
  });

  // WF-04, CSH-03..CSH-05: סגירה. לא סוגרים עם מכירה תלויה; סטייה מעל הסף — סיבה + אישור מנהל
  app.post('/cash-sessions/:id/close', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ countedCashAgorot: z.number().int().min(0), varianceReason: z.string().nullable().optional() }).parse(req.body);
    return tx(req, async (c) => {
      const s = await one(c, 'SELECT * FROM cash_sessions WHERE id = $1 FOR UPDATE', [id]);
      if (!s) throw notFound('המשמרת');
      assertTransition('cash_session', s.status, 'closing');
      const rep = await sessionReport(c, id);
      if (rep.pending_sales > 0) throw new AppError(409, 'pending_sales', `יש ${rep.pending_sales} מכירות שלא הושלמו. צריך להשלים או לבטל אותן לפני סגירה.`);
      const variance = b.countedCashAgorot - rep.expected_cash_agorot;
      if (Math.abs(variance) > VARIANCE_APPROVAL_AGOROT) {
        if (!b.varianceReason) throw new AppError(422, 'variance_reason', 'יש פער בקופה. צריך לכתוב הסבר.', { data: { variance } });
        assertPerm(req, 'cash:approve_variance', 'פער בקופה מעל ₪20 דורש אישור מנהל');
      }
      const closedAt = new Date().toISOString();
      await c.query(
        `UPDATE cash_sessions SET status = 'closed', closed_by = $2, closed_at = $3, expected_cash_agorot = $4, counted_cash_agorot = $5, variance_agorot = $6::bigint,
           variance_reason = $7, variance_approved_by = CASE WHEN abs($6::bigint) > $8::bigint THEN $2::uuid END WHERE id = $1`,
        [id, req.auth.userId, closedAt, rep.expected_cash_agorot, b.countedCashAgorot, variance, b.varianceReason ?? null, VARIANCE_APPROVAL_AGOROT]);
      const z = await sessionReport(c, id);
      await c.query('UPDATE cash_sessions SET z_report = $2 WHERE id = $1', [id, JSON.stringify(z)]);
      await audit(c, {
        tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'cash.close', targetType: 'cash_session', targetId: id,
        details: { number: s.number, expected: rep.expected_cash_agorot, counted: b.countedCashAgorot, variance, sales: rep.sales.total },
      });
      return z;
    });
  });
}
