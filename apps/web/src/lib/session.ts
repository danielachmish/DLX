// מצב התחברות במכשיר. האסימון קצר-חיים (12 שעות); ההרשאות מגיעות מהשרת ומשמשות רק להסתרת כפתורים —
// הבדיקה האמיתית תמיד בשרת. הקופה שהמכשיר משויך אליה נשמרת בנפרד (מכשיר = קופה).
import { useSyncExternalStore } from 'react';

export interface SessionUser { id: string; name: string; email: string | null; role: string; branchId: string | null; permissions: string[] }
export interface Session {
  token: string; slug: string; user: SessionUser;
  tenant: { id: string; slug: string; legal_name: string; trade_name: string | null; tax_id: string; tax_status: 'murshe' | 'company' | 'patur'; status: string };
  branches: { id: string; name: string; tax_zone: string }[];
  registers: { id: string; branch_id: string; code: string; name: string }[];
}

const KEY = 'dlx_session';
const REG_KEY = 'dlx_register';
let current: Session | null = read();
const listeners = new Set<() => void>();

function read(): Session | null {
  try { const s = localStorage.getItem(KEY); return s ? (JSON.parse(s) as Session) : null; } catch { return null; }
}

export function getSession() { return current; }

export function setSession(s: Session | null) {
  current = s;
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* מצב פרטי */ }
  listeners.forEach((l) => l());
}

export function useSession(): Session | null {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => current, () => current);
}

export const can = (perm: string, s: Session | null = current) => !!s?.user.permissions.includes(perm);

export function logout() { setSession(null); }

export function getRegisterId(): string | null {
  try { return localStorage.getItem(REG_KEY); } catch { return null; }
}
export function setRegisterId(id: string) {
  try { localStorage.setItem(REG_KEY, id); } catch { /* לא קריטי */ }
  listeners.forEach((l) => l());
}

export function currentRegister(s: Session | null = current) {
  if (!s) return null;
  const id = getRegisterId();
  const allowed = s.registers.filter((r) => !s.user.branchId || r.branch_id === s.user.branchId);
  return allowed.find((r) => r.id === id) ?? allowed[0] ?? null;
}

export const ROLE_LABEL: Record<string, string> = {
  owner: 'בעל העסק', manager: 'מנהל סניף', cashier: 'קופאי', warehouse: 'מחסנאי', purchaser: 'קניין', accountant: 'מנהל חשבונות',
};
