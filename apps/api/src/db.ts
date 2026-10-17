// חיבור ל-Postgres. כל גישה לנתונים עסקיים עוברת ב-withTenant: טרנזקציה אחת שבה app.tenant_id מוגדר,
// כך שמדיניות ה-RLS מסננת כל שאילתה — גם אם קוד שכח "WHERE tenant_id" (ADM-01).
import pg from 'pg';

// bigint (int8) → number: סכומים באגורות וכמויות באלפיות נשארים בטווח הבטוח של JS
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v); // date נשאר "YYYY-MM-DD", בלי המרת אזור זמן

export type Db = pg.PoolClient;
export type Pool = pg.Pool;

export function createPool(url: string, max = 20): Pool {
  return new pg.Pool({ connectionString: url, max });
}

export async function withTenant<T>(pool: Pool, tenantId: string, fn: (c: Db) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function one<T = any>(c: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await c.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(c: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await c.query(sql, params);
  return r.rows as T[];
}

// מספר רץ לישויות תפעוליות (הזמנה, קליטה, ספירה, משמרת, החזרה) — אותו מנגנון נעילה של מספרי המסמכים
export async function nextNumber(c: Db, tenantId: string, scope: string): Promise<number> {
  await c.query(
    'INSERT INTO document_sequences (tenant_id, doc_type) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tenantId, `#${scope}`]);
  const r = await one<{ n: number }>(c,
    'UPDATE document_sequences SET next_serial = next_serial + 1 WHERE tenant_id = $1 AND doc_type = $2 RETURNING next_serial - 1 AS n',
    [tenantId, `#${scope}`]);
  return r!.n;
}
