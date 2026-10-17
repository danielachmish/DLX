// יומן ביקורת (IAM-05, ACC-08, NFR-10): append-only ב-DB, ושרשרת hash לכל עסק — כל רשומה חותמת על הקודמת,
// כך ששינוי או השמטה ישירים ב-DB מתגלים ב-verifyAuditChain (T23, QA-23).
import { createHash } from 'node:crypto';
import { type Db, type Pool, many, one, withTenant } from './db.js';

export interface AuditInput {
  tenantId: string;
  actorId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  result?: 'ok' | 'denied' | 'failed';
  details?: Record<string, unknown>;
  ip?: string | null;
  correlationId?: string | null;
}

const GENESIS = '0'.repeat(64);

// JSON יציב (מפתחות ממוינים) — אותו hash בכל ריצה
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function chainHash(prev: string, e: { tenant_id: string; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; result: string; details: unknown; created_at: string }) {
  return sha256(prev + canonical({ ...e, created_at: new Date(e.created_at).toISOString() }));
}

export async function audit(c: Db, e: AuditInput): Promise<void> {
  // נעילה לכל עסק — שתי פעולות במקביל לא שוברות את השרשרת
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`audit:${e.tenantId}`]);
  const last = await one<{ hash: string }>(c, 'SELECT hash FROM audit_events WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [e.tenantId]);
  const prev = last?.hash ?? GENESIS;
  const created_at = new Date().toISOString();
  const row = {
    tenant_id: e.tenantId, actor_id: e.actorId, action: e.action, target_type: e.targetType ?? null,
    target_id: e.targetId ?? null, result: e.result ?? 'ok', details: e.details ?? {}, created_at,
  };
  const hash = chainHash(prev, row);
  await c.query(
    `INSERT INTO audit_events (tenant_id, actor_id, action, target_type, target_id, result, details, ip, correlation_id, created_at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [row.tenant_id, row.actor_id, row.action, row.target_type, row.target_id, row.result, JSON.stringify(row.details),
      e.ip ?? null, e.correlationId ?? null, created_at, prev, hash],
  );
}

// ניסיון שנחסם נרשם בטרנזקציה נפרדת — כדי שיישאר גם כשהבקשה עצמה נכשלת
export async function auditDenied(pool: Pool, a: { tenantId: string; userId: string }, perm: string, route: string, ip: string) {
  await withTenant(pool, a.tenantId, (c) => audit(c, {
    tenantId: a.tenantId, actorId: a.userId, action: 'permission.denied', result: 'denied', details: { perm, route }, ip,
  })).catch(() => {});
}

export async function verifyAuditChain(c: Db, tenantId: string): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
  const rows = await many(c, 'SELECT * FROM audit_events WHERE tenant_id = $1 ORDER BY id', [tenantId]);
  let prev = GENESIS;
  for (const r of rows) {
    const h = chainHash(prev, {
      tenant_id: r.tenant_id, actor_id: r.actor_id, action: r.action, target_type: r.target_type, target_id: r.target_id,
      result: r.result, details: r.details, created_at: r.created_at,
    });
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, count: rows.length, brokenAt: Number(r.id) };
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}
