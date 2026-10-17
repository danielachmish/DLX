// Idempotency-Key (PAY-02, חוזה API): ניסיון חוזר עם אותו מפתח מחזיר את אותה תוצאה ולא מבצע שוב.
// המפתח נרשם באותה טרנזקציה של הפעולה: אם הפעולה נכשלה — גם המפתח מתבטל, וניסיון חוזר מותר.
// שתי בקשות במקביל עם אותו מפתח: השנייה מחכה לנעילה של הראשונה ומקבלת את התשובה השמורה.
import type { FastifyRequest } from 'fastify';
import { canonical, sha256 } from './audit.js';
import { type Db, one } from './db.js';
import { AppError } from './errors.js';

export function idemKey(req: FastifyRequest): string {
  const k = req.headers['idempotency-key'];
  const key = Array.isArray(k) ? k[0] : k;
  if (!key || key.length < 8 || key.length > 200) {
    throw new AppError(400, 'idempotency_required', 'חסר Idempotency-Key לפעולה כספית / מסמך');
  }
  return key;
}

export async function idempotent<T>(c: Db, tenantId: string, key: string, route: string, body: unknown, fn: () => Promise<T>): Promise<{ replay: boolean; value: T }> {
  const hash = sha256(canonical(body ?? null));
  const inserted = await one(c,
    `INSERT INTO idempotency_keys (tenant_id, key, route, request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING key`,
    [tenantId, key, route, hash]);
  if (!inserted) {
    const prev = await one<{ route: string; request_hash: string; response: T }>(c,
      'SELECT route, request_hash, response FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 FOR UPDATE', [tenantId, key]);
    if (prev && (prev.route !== route || prev.request_hash !== hash)) {
      throw new AppError(422, 'idempotency_mismatch', 'אותו Idempotency-Key נשלח עם בקשה אחרת');
    }
    if (prev && prev.response !== null) return { replay: true, value: prev.response };
  }
  const value = await fn();
  await c.query('UPDATE idempotency_keys SET response = $3, status_code = 200 WHERE tenant_id = $1 AND key = $2',
    [tenantId, key, JSON.stringify(value)]);
  return { replay: false, value };
}
