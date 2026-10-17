// קריאות לשרת: אסימון, Idempotency-Key לפעולות כספיות, ושגיאה אחידה (code, message_he, field_errors).
import { getSession, logout } from './session';

export class ApiError extends Error {
  status: number; code: string; fieldErrors?: Record<string, string>; retryable: boolean; data?: any; serverError: boolean; offline: boolean;
  constructor(status: number, body: any, offline = false) {
    super(body?.message_he || (offline ? 'אין חיבור לשרת' : 'משהו השתבש'));
    this.status = status; this.code = body?.code ?? (offline ? 'offline' : 'error'); this.fieldErrors = body?.field_errors;
    this.retryable = !!body?.retryable || offline; this.data = body?.data; this.serverError = status >= 500; this.offline = offline;
  }
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export interface ReqOpts { key?: string | true; raw?: boolean }

export async function request<T = any>(method: string, path: string, body?: unknown, opts: ReqOpts = {}): Promise<T> {
  const s = getSession();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (s) headers.authorization = `Bearer ${s.token}`;
  if (opts.key) headers['idempotency-key'] = opts.key === true ? newKey() : opts.key;
  let res: Response;
  try {
    res = await fetch(path.startsWith('/') ? path : `/v1/${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, null, true);
  }
  if (opts.raw && res.ok) return (await res.text()) as unknown as T;
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && s) logout();
    throw new ApiError(res.status, data);
  }
  return data as T;
}

const v1 = (p: string) => (p.startsWith('/v1') || p.startsWith('/health') ? p : `/v1${p.startsWith('/') ? '' : '/'}${p}`);

export const api = {
  get: <T = any>(p: string) => request<T>('GET', v1(p)),
  post: <T = any>(p: string, body: unknown = {}, opts?: ReqOpts) => request<T>('POST', v1(p), body, opts),
  put: <T = any>(p: string, body: unknown, opts?: ReqOpts) => request<T>('PUT', v1(p), body, opts),
  text: (p: string) => request<string>('GET', v1(p), undefined, { raw: true }),
};

export function qs(params: Record<string, unknown>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

// הורדת קובץ (CSV / JSON) עם אסימון
export async function download(path: string, filename: string) {
  const s = getSession();
  const res = await fetch(v1(path), { headers: s ? { authorization: `Bearer ${s.token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  saveBlob(await res.blob(), filename);
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
