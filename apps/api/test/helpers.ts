// סביבת בדיקה: מסד dlx_test נקי בכל ריצה, מיגרציות, ושרת אמיתי (inject) מול Postgres אמיתי עם RLS.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { seedDemo } from '../src/seed.js';

export const OWNER_URL = process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://dlx_owner:dlx_owner_dev@localhost:5432/dlx_test';
export const APP_URL = process.env.TEST_DATABASE_URL ?? 'postgres://dlx_app:dlx_app_dev@localhost:5432/dlx_test';

export async function resetDb() {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(OWNER_URL, () => {});
}

export async function makeApp() {
  const config = { ...loadConfig(), databaseUrl: APP_URL, ownerUrl: OWNER_URL, logger: false, jwtSecret: 'test-secret', softwareRegistration: '12345678' };
  return buildApp(config);
}

export type App = Awaited<ReturnType<typeof makeApp>>;

export function client(app: App, token: string) {
  const req = async (method: string, url: string, payload?: unknown, key?: string | true) => {
    const res = await app.inject({
      method: method as any, url, payload: payload as any,
      headers: { authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key === true ? randomUUID() : key } : {}) },
    });
    let body: any;
    try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body };
  };
  return {
    get: (url: string) => req('GET', url),
    post: (url: string, payload?: unknown, key?: string | true) => req('POST', url, payload ?? {}, key),
    put: (url: string, payload?: unknown) => req('PUT', url, payload),
  };
}

export async function login(app: App, slug: string, email: string, password: string) {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { slug, email, password } });
  return r.json();
}

export async function pinLogin(app: App, slug: string, pin: string) {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/pin', payload: { slug, pin } });
  return r.json();
}

export { seedDemo };
