// הגדרות עסק, סניפים, קופות, משתמשים ויומן ביקורת (TEN-01..TEN-06, IAM-01..IAM-05, S17, S18)
import { isValidIsraeliId } from '@dlx/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, verifyAuditChain } from '../audit.js';
import { hashSecret, requireAuth, tx, verifySecret } from '../auth.js';
import { many, one } from '../db.js';
import { AppError, notFound } from '../errors.js';

const Business = z.object({
  legalName: z.string().min(2), tradeName: z.string().nullable().optional(),
  taxId: z.string().refine(isValidIsraeliId, 'מספר עוסק / ח"פ לא תקין'),
  taxStatus: z.enum(['murshe', 'company', 'patur']),
  taxStatusFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  address: z.string().nullable().optional(), phone: z.string().nullable().optional(), email: z.string().email().nullable().optional(),
  allowNegativeStock: z.boolean().optional(), returnDays: z.number().int().min(0).max(365).optional(),
  returnPolicy: z.string().max(600).nullable().optional(), receiptFooter: z.string().max(400).nullable().optional(),
});

const Branch = z.object({ name: z.string().min(1), address: z.string().nullable().optional(), taxZone: z.enum(['regular', 'eilat']).default('regular'), active: z.boolean().default(true) });
const Register = z.object({ branchId: z.string().uuid(), code: z.string().regex(/^[A-Za-z0-9-]{1,10}$/), name: z.string().min(1), active: z.boolean().default(true) });
const Role = z.enum(['owner', 'manager', 'cashier', 'warehouse', 'purchaser', 'accountant']);
const User = z.object({
  name: z.string().min(2), email: z.string().email().nullable().optional(), role: Role, branchId: z.string().uuid().nullable().optional(),
  password: z.string().min(8).optional(), pin: z.string().regex(/^\d{4,8}$/, 'PIN של 4–8 ספרות').optional(), active: z.boolean().optional(),
});

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings/business', { preHandler: requireAuth() }, async (req) => tx(req, (c) => one(c, 'SELECT * FROM tenants WHERE id = $1', [req.auth.tenantId])));

  app.put('/settings/business', { preHandler: requireAuth('settings:write') }, async (req) => {
    const b = Business.parse(req.body);
    return tx(req, async (c) => {
      const before = await one(c, 'SELECT * FROM tenants WHERE id = $1', [req.auth.tenantId]);
      // TEN-03: שינוי סוג עוסק — רק מתאריך עתידי/היום, לא משנה מסמכים קיימים (הם שומרים תמונת מצב)
      const row = await one(c,
        `UPDATE tenants SET legal_name=$2, trade_name=$3, tax_id=$4, tax_status=$5, tax_status_from = COALESCE($6::date, tax_status_from),
           address=$7, phone=$8, email=$9, allow_negative_stock = COALESCE($10, allow_negative_stock), return_days = COALESCE($11, return_days),
           return_policy=$12, receipt_footer=$13 WHERE id = $1 RETURNING *`,
        [req.auth.tenantId, b.legalName, b.tradeName ?? null, b.taxId.replace(/\D/g, ''), b.taxStatus, b.taxStatusFrom ?? null, b.address ?? null,
          b.phone ?? null, b.email ?? null, b.allowNegativeStock ?? null, b.returnDays ?? null, b.returnPolicy ?? null, b.receiptFooter ?? null]);
      const changed = Object.keys(row).filter((k) => JSON.stringify(row[k]) !== JSON.stringify(before[k]) && k !== 'updated_at');
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'settings.business', targetType: 'tenant', targetId: req.auth.tenantId, details: { changed } });
      return row;
    });
  });

  app.get('/branches', { preHandler: requireAuth() }, async (req) => tx(req, (c) => many(c, 'SELECT * FROM branches ORDER BY created_at')));
  app.post('/branches', { preHandler: requireAuth('settings:write') }, async (req) => {
    const b = Branch.parse(req.body);
    return tx(req, async (c) => {
      const r = await one(c, 'INSERT INTO branches (tenant_id, name, address, tax_zone, active) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [req.auth.tenantId, b.name, b.address ?? null, b.taxZone, b.active]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'branch.create', targetType: 'branch', targetId: r.id });
      return r;
    });
  });
  app.put('/branches/:id', { preHandler: requireAuth('settings:write') }, async (req) => {
    const b = Branch.parse(req.body);
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const r = await one(c, 'UPDATE branches SET name=$2, address=$3, tax_zone=$4, active=$5 WHERE id=$1 RETURNING *', [id, b.name, b.address ?? null, b.taxZone, b.active]);
      if (!r) throw notFound('הסניף');
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'branch.update', targetType: 'branch', targetId: id });
      return r;
    });
  });

  app.get('/registers', { preHandler: requireAuth() }, async (req) => tx(req, (c) => many(c, 'SELECT * FROM registers ORDER BY code')));
  app.post('/registers', { preHandler: requireAuth('settings:write') }, async (req) => {
    const b = Register.parse(req.body);
    return tx(req, async (c) => {
      const r = await one(c, 'INSERT INTO registers (tenant_id, branch_id, code, name, active) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [req.auth.tenantId, b.branchId, b.code, b.name, b.active]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'register.create', targetType: 'register', targetId: r.id });
      return r;
    });
  });
  app.put('/registers/:id', { preHandler: requireAuth('settings:write') }, async (req) => {
    const b = Register.parse(req.body);
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const r = await one(c, 'UPDATE registers SET branch_id=$2, code=$3, name=$4, active=$5 WHERE id=$1 RETURNING *', [id, b.branchId, b.code, b.name, b.active]);
      if (!r) throw notFound('הקופה');
      return r;
    });
  });

  // ===== משתמשים =====
  const userCols = 'id, name, email, role, branch_id, active, (pin_hash IS NOT NULL) AS has_pin, created_at';
  app.get('/users', { preHandler: requireAuth('users:write') }, async (req) => tx(req, (c) => many(c, `SELECT ${userCols} FROM users ORDER BY active DESC, name`)));

  async function pinTaken(c: any, pin: string, exceptId?: string) {
    const rows = await many(c, 'SELECT id, pin_hash FROM users WHERE pin_hash IS NOT NULL AND active');
    for (const r of rows) if (r.id !== exceptId && (await verifySecret(pin, r.pin_hash))) return true;
    return false;
  }

  app.post('/users', { preHandler: requireAuth('users:write') }, async (req) => {
    const b = User.parse(req.body);
    if (!b.password && !b.pin) throw new AppError(422, 'invalid', 'צריך סיסמה או PIN');
    if (b.password && !b.email) throw new AppError(422, 'invalid', 'כניסה בסיסמה דורשת אימייל');
    return tx(req, async (c) => {
      if (b.pin && (await pinTaken(c, b.pin))) throw new AppError(409, 'pin_taken', 'ה-PIN כבר בשימוש אצל עובד אחר', { fieldErrors: { pin: 'תפוס' } });
      const r = await one(c,
        `INSERT INTO users (tenant_id, name, email, role, branch_id, password_hash, pin_hash) VALUES ($1,$2,lower($3),$4,$5,$6,$7) RETURNING ${userCols}`,
        [req.auth.tenantId, b.name, b.email ?? null, b.role, b.branchId ?? null, b.password ? await hashSecret(b.password) : null, b.pin ? await hashSecret(b.pin) : null]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'user.create', targetType: 'user', targetId: r.id, details: { role: b.role } });
      return r;
    });
  });

  app.put('/users/:id', { preHandler: requireAuth('users:write') }, async (req) => {
    const b = User.partial().parse(req.body);
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const cur = await one(c, 'SELECT * FROM users WHERE id = $1', [id]);
      if (!cur) throw notFound('המשתמש');
      if (id === req.auth.userId && (b.active === false || (b.role && b.role !== cur.role))) {
        throw new AppError(422, 'invalid', 'אי אפשר להשבית את עצמך או לשנות לעצמך תפקיד');
      }
      if (b.pin && (await pinTaken(c, b.pin, id))) throw new AppError(409, 'pin_taken', 'ה-PIN כבר בשימוש אצל עובד אחר');
      // IAM-02: שינוי תפקיד / השבתה / סיסמה — מבטל אסימונים קיימים
      const bump = (b.role && b.role !== cur.role) || b.active === false || !!b.password || (b.branchId !== undefined && b.branchId !== cur.branch_id);
      const r = await one(c,
        `UPDATE users SET name = COALESCE($2, name), email = CASE WHEN $11::boolean THEN lower($3) ELSE email END, role = COALESCE($4, role),
           branch_id = CASE WHEN $5::boolean THEN $6::uuid ELSE branch_id END, active = COALESCE($7, active),
           password_hash = COALESCE($8, password_hash), pin_hash = COALESCE($9, pin_hash), token_version = token_version + $10
         WHERE id = $1 RETURNING ${userCols}`,
        [id, b.name ?? null, b.email ?? null, b.role ?? null, b.branchId !== undefined, b.branchId ?? null, b.active ?? null,
          b.password ? await hashSecret(b.password) : null, b.pin ? await hashSecret(b.pin) : null, bump ? 1 : 0, b.email !== undefined]);
      await audit(c, {
        tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'user.update', targetType: 'user', targetId: id,
        details: { role: b.role, active: b.active, password: !!b.password, pin: !!b.pin, branch: b.branchId },
      });
      return r;
    });
  });

  // ===== מצב מסמכים (פיילוט / רשמי) =====
  // shadow: הכל עובד, המסמכים מסומנים "פיילוט — לא מסמך רשמי". live: רק אחרי רישום התוכנה ברשות המסים,
  // רק בעלים, ורק עם הקלדת משפט אישור — כדי שאף אחד לא יעבור לרשמי בטעות.
  app.get('/settings/documents-mode', { preHandler: requireAuth() }, async (req) => tx(req, async (c) => {
    const t = await one(c, 'SELECT documents_mode, documents_mode_changed_at, training_of FROM tenants WHERE id = $1', [req.auth.tenantId]);
    const training = await one(c, 'SELECT dlx_training_slug($1) AS slug', [req.auth.tenantId]);
    return { ...t, softwareRegistered: !!app.config.softwareRegistration, allocationConnected: app.providers.allocation.name !== 'none', trainingSlug: training?.slug ?? null };
  }));

  const LIVE_CONFIRM = 'אני מאשר שהתוכנה רשומה ושרו"ח אישר את המסמכים';
  app.put('/settings/documents-mode', { preHandler: requireAuth('settings:write') }, async (req) => {
    const b = z.object({ mode: z.enum(['shadow', 'live']), confirm: z.string().optional() }).parse(req.body);
    return tx(req, async (c) => {
      const t = await one(c, 'SELECT documents_mode, training_of FROM tenants WHERE id = $1 FOR UPDATE', [req.auth.tenantId]);
      if (t.training_of) throw new AppError(422, 'rule', 'סביבת תרגול לא יכולה להפיק מסמכים רשמיים');
      if (b.mode === 'live') {
        if (req.auth.role !== 'owner') throw new AppError(403, 'forbidden', 'מעבר למסמכים רשמיים — רק בעל העסק');
        if (!app.config.softwareRegistration) throw new AppError(422, 'not_registered', 'התוכנה עוד לא רשומה ברשות המסים. אי אפשר להפיק מסמכים רשמיים.');
        if (b.confirm?.trim() !== LIVE_CONFIRM) throw new AppError(422, 'confirm', `צריך להקליד בדיוק: ${LIVE_CONFIRM}`);
      }
      await c.query('UPDATE tenants SET documents_mode = $2, documents_mode_changed_at = now(), documents_mode_changed_by = $3 WHERE id = $1', [req.auth.tenantId, b.mode, req.auth.userId]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'settings.documents_mode', details: { from: t.documents_mode, to: b.mode } });
      return { documents_mode: b.mode };
    });
  });

  // ===== סביבת תרגול לקופאים =====
  // עסק נפרד "<קוד>-train" עם אותם מוצרים, קופות ועובדים (אותו PIN). אין לקוחות, אין מלאי, וכל מסמך מסומן "תרגול"
  app.post('/settings/training', { preHandler: requireAuth('settings:write') }, async (req) => tx(req, async (c) => {
    const t = await one(c, 'SELECT slug, training_of FROM tenants WHERE id = $1', [req.auth.tenantId]);
    if (t.training_of) throw new AppError(422, 'rule', 'כבר נמצאים בסביבת התרגול');
    const r = await one(c, 'SELECT dlx_create_training($1) AS id', [req.auth.tenantId]);
    await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'settings.training', details: { trainingTenant: r.id } });
    return { id: r.id, slug: `${t.slug.slice(0, 34)}-train` };
  }));

  // ===== יומן ביקורת =====
  app.get('/audit', { preHandler: requireAuth('audit:read') }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional(), action: z.string().optional() }).parse(req.query);
    return tx(req, (c) => many(c,
      `SELECT a.id, a.action, a.target_type, a.target_id, a.result, a.details, a.ip, a.created_at, u.name AS actor_name
       FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
       WHERE ($2::bigint IS NULL OR a.id < $2) AND ($3::text IS NULL OR a.action LIKE $3 || '%') ORDER BY a.id DESC LIMIT $1`,
      [q.limit, q.before ?? null, q.action ?? null]));
  });
  app.get('/audit/verify', { preHandler: requireAuth('audit:read') }, async (req) => tx(req, (c) => verifyAuditChain(c, req.auth.tenantId)));
}
