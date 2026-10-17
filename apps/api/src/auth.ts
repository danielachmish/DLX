// זיהוי והרשאות (IAM-01, IAM-02). סיסמה ו-PIN: scrypt עם salt. אסימון JWT קצר-חיים עם tenant ותפקיד;
// כל בקשה בודקת מחדש שהמשתמש פעיל ושגרסת האסימון עדכנית — השבתה או שינוי תפקיד מבטלים מיד (T34).
import { can, type Permission, type Role } from '@dlx/core';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Db, one, withTenant } from './db.js';
import { AppError, forbidden } from './errors.js';
import { auditDenied } from './audit.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(secret, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [kind, s, k] = stored.split('$');
  if (kind !== 'scrypt' || !s || !k) return false;
  const want = Buffer.from(k, 'base64');
  const got = await scrypt(secret, Buffer.from(s, 'base64'), want.length);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface AuthInfo { tenantId: string; userId: string; role: Role; branchId: string | null; tv: number }

export interface TokenPayload { tid: string; uid: string; role: Role; bid: string | null; tv: number }

declare module 'fastify' {
  interface FastifyRequest { auth: AuthInfo }
}

declare module '@fastify/jwt' {
  interface FastifyJWT { payload: TokenPayload; user: TokenPayload }
}

export function requireAuth(perm?: Permission) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new AppError(401, 'unauthorized', 'צריך להתחבר מחדש');
    }
    const p = req.user;
    req.auth = { tenantId: p.tid, userId: p.uid, role: p.role, branchId: p.bid, tv: p.tv };
    if (perm && !can(p.role, perm)) {
      await auditDenied(req.server.pool, req.auth, perm, req.routeOptions.url ?? req.url, req.ip);
      throw forbidden();
    }
  };
}

export const hasPerm = (req: FastifyRequest, p: Permission) => can(req.auth.role, p);

export function assertPerm(req: FastifyRequest, p: Permission, msg?: string) {
  if (!hasPerm(req, p)) throw forbidden(msg);
}

// טרנזקציה בהקשר העסק של המשתמש, עם בדיקה שהמשתמש עדיין פעיל והעסק לא נעול לכתיבה (G-01)
export async function tx<T>(req: FastifyRequest, fn: (c: Db) => Promise<T>): Promise<T> {
  const a = req.auth;
  return withTenant(req.server.pool, a.tenantId, async (c) => {
    const u = await one<{ active: boolean; token_version: number; tenant_status: string }>(c,
      `SELECT u.active, u.token_version, t.status AS tenant_status FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
      [a.userId]);
    if (!u || !u.active || u.token_version !== a.tv) throw new AppError(401, 'unauthorized', 'המשתמש הושבת או שההרשאות השתנו. צריך להתחבר מחדש');
    if (req.method !== 'GET' && u.tenant_status !== 'active') {
      throw new AppError(423, 'read_only', 'החשבון במצב קריאה בלבד. אפשר לצפות ולייצא, לא לבצע פעולות חדשות.');
    }
    return fn(c);
  });
}

// סניף העבודה: משתמש משויך לסניף — רק אליו; אחרת לפי הבקשה
export function branchScope(req: FastifyRequest, requested?: string | null): string | null {
  const own = req.auth.branchId;
  if (own && requested && requested !== own) throw forbidden('אין לך גישה לסניף הזה');
  return own ?? requested ?? null;
}
