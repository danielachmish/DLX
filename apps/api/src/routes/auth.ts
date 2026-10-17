// הרשמה, כניסה בסיסמה, כניסה מהירה ב-PIN לקופאי (IAM-02, TEN-01, ADM-06)
import { isValidIsraeliId, ROLE_PERMISSIONS, type Role } from '@dlx/core';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../audit.js';
import { hashSecret, requireAuth, tx, verifySecret, type TokenPayload } from '../auth.js';
import { many, one, withTenant } from '../db.js';
import { AppError } from '../errors.js';

const Signup = z.object({
  business: z.object({
    slug: z.string().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{2,40}$/, 'אותיות באנגלית, ספרות ומקף בלבד (3–40)'),
    legalName: z.string().min(2), tradeName: z.string().optional().nullable(),
    taxId: z.string().refine(isValidIsraeliId, 'מספר עוסק / ח"פ לא תקין'),
    taxStatus: z.enum(['murshe', 'company', 'patur']),
    address: z.string().optional().nullable(), phone: z.string().optional().nullable(), email: z.string().email().optional().nullable(),
  }),
  branch: z.object({ name: z.string().min(1).default('סניף ראשי'), address: z.string().optional().nullable(), taxZone: z.enum(['regular', 'eilat']).default('regular') }),
  owner: z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(8, 'לפחות 8 תווים') }),
});

const Login = z.object({ slug: z.string().toLowerCase(), email: z.string().email(), password: z.string().min(1) });
const Pin = z.object({ slug: z.string().toLowerCase(), pin: z.string().regex(/^\d{4,8}$/) });

export async function authRoutes(app: FastifyInstance) {
  const sign = (p: TokenPayload) => app.jwt.sign(p);

  const session = async (tenantId: string, userId: string) => withTenant(app.pool, tenantId, async (c) => {
    const u = await one(c, 'SELECT id, name, email, role, branch_id, token_version FROM users WHERE id = $1', [userId]);
    const t = await one(c, 'SELECT id, slug, legal_name, trade_name, tax_id, tax_status, status, documents_mode, training_of FROM tenants WHERE id = $1', [tenantId]);
    const branches = await many(c, 'SELECT id, name, tax_zone FROM branches WHERE active ORDER BY created_at');
    const registers = await many(c, 'SELECT id, branch_id, code, name FROM registers WHERE active ORDER BY code');
    const token = sign({ tid: tenantId, uid: u.id, role: u.role, bid: u.branch_id, tv: u.token_version });
    return {
      token, user: { id: u.id, name: u.name, email: u.email, role: u.role, branchId: u.branch_id, permissions: ROLE_PERMISSIONS[u.role as Role] },
      tenant: t, branches, registers,
    };
  });

  app.post('/auth/signup', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
    const b = Signup.parse(req.body);
    const taken = await app.pool.query('SELECT dlx_slug_taken($1) AS t', [b.business.slug]);
    if (taken.rows[0].t) throw new AppError(409, 'slug_taken', 'קוד העסק כבר תפוס', { fieldErrors: { 'business.slug': 'תפוס' } });
    const tenantId = randomUUID();
    const pw = await hashSecret(b.owner.password);
    const userId = await withTenant(app.pool, tenantId, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id, tax_status, address, phone, email, return_policy)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tenantId, b.business.slug, b.business.legalName, b.business.tradeName ?? null, b.business.taxId.replace(/\D/g, ''), b.business.taxStatus,
          b.business.address ?? null, b.business.phone ?? null, b.business.email ?? null,
          'החזרה עד 14 ימים מיום הקנייה, עם חשבונית, בפריט שלא נפגם. ההחזר באמצעי התשלום המקורי.']);
      const br = await one(c, 'INSERT INTO branches (tenant_id, name, address, tax_zone) VALUES ($1,$2,$3,$4) RETURNING id',
        [tenantId, b.branch.name, b.branch.address ?? b.business.address ?? null, b.branch.taxZone]);
      await c.query("INSERT INTO registers (tenant_id, branch_id, code, name) VALUES ($1,$2,'01','קופה 1')", [tenantId, br.id]);
      const u = await one(c, `INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES ($1,$2,lower($3),$4,'owner') RETURNING id`,
        [tenantId, b.owner.name, b.owner.email, pw]);
      await audit(c, { tenantId, actorId: u.id, action: 'tenant.create', targetType: 'tenant', targetId: tenantId, ip: req.ip, details: { slug: b.business.slug } });
      return u.id as string;
    });
    return session(tenantId, userId);
  });

  app.post('/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const b = Login.parse(req.body);
    const r = await app.pool.query('SELECT * FROM dlx_login_lookup($1, $2)', [b.slug, b.email]);
    const row = r.rows[0];
    const ok = row && row.active && (await verifySecret(b.password, row.password_hash));
    if (row) {
      await withTenant(app.pool, row.tenant_id, (c) => audit(c, {
        tenantId: row.tenant_id, actorId: row.user_id, action: 'auth.login', result: ok ? 'ok' : 'denied', ip: req.ip,
      }));
    }
    if (!ok) throw new AppError(401, 'bad_credentials', 'קוד עסק, אימייל או סיסמה לא נכונים');
    if (row.tenant_status === 'closed') throw new AppError(403, 'tenant_closed', 'החשבון סגור. לייצוא נתונים — פנו לתמיכה.');
    return session(row.tenant_id, row.user_id);
  });

  app.post('/auth/pin', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = Pin.parse(req.body);
    const r = await app.pool.query('SELECT * FROM dlx_pin_lookup($1)', [b.slug]);
    for (const row of r.rows) {
      if (await verifySecret(b.pin, row.pin_hash)) {
        await withTenant(app.pool, row.tenant_id, (c) => audit(c, { tenantId: row.tenant_id, actorId: row.user_id, action: 'auth.pin', ip: req.ip }));
        return session(row.tenant_id, row.user_id);
      }
    }
    throw new AppError(401, 'bad_credentials', 'קוד PIN לא נכון');
  });

  app.get('/me', { preHandler: requireAuth() }, async (req) => {
    await tx(req, async () => null);
    return session(req.auth.tenantId, req.auth.userId);
  });
}
