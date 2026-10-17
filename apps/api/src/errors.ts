// תשובת שגיאה אחידה (חוזה API, פרק 8): code, message_he, field_errors, correlation_id, retryable
import { CartError, DocumentRuleError, MoneyError, ReturnError, TransitionError } from '@dlx/core';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: { fieldErrors?: Record<string, string>; retryable?: boolean; data?: unknown } = {},
  ) {
    super(message);
  }
}

export const notFound = (what = 'הרשומה') => new AppError(404, 'not_found', `${what} לא נמצאה`);
export const forbidden = (msg = 'אין לך הרשאה לפעולה הזו') => new AppError(403, 'forbidden', msg);
export const conflict = (msg: string, data?: unknown) => new AppError(409, 'conflict', msg, { data });
export const invalid = (msg: string, fieldErrors?: Record<string, string>) => new AppError(422, 'invalid', msg, { fieldErrors });

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  const correlation_id = req.id;
  const send = (status: number, code: string, message_he: string, more: Record<string, unknown> = {}) =>
    reply.status(status).send({ code, message_he, correlation_id, retryable: false, ...more });

  if (err instanceof AppError) {
    return send(err.status, err.code, err.message, {
      field_errors: err.extra.fieldErrors, retryable: !!err.extra.retryable, data: err.extra.data,
    });
  }
  if (err instanceof ZodError) {
    const field_errors: Record<string, string> = {};
    for (const i of err.issues) field_errors[i.path.join('.') || '_'] = i.message;
    return send(400, 'validation', 'חלק מהשדות לא תקינים', { field_errors });
  }
  if (err instanceof TransitionError) return send(409, 'invalid_state', err.message);
  if (err instanceof DocumentRuleError || err instanceof ReturnError || err instanceof CartError || err instanceof MoneyError) {
    return send(422, 'rule', err.message);
  }
  const pgErr = err as { code?: string; message?: string; constraint?: string };
  if (pgErr.code === 'P0001' && pgErr.message?.startsWith('DLX_IMMUTABLE')) {
    return send(409, 'immutable', 'רשומה סופית — אי אפשר לשנות או למחוק. תיקון רק במסמך מתקן.');
  }
  if (pgErr.code === '23505') return send(409, 'duplicate', 'כבר קיימת רשומה עם הערך הזה', { data: { constraint: pgErr.constraint } });
  if (pgErr.code === '23503') return send(422, 'reference', 'הרשומה מפנה לפריט שלא קיים');
  const fe = err as FastifyError;
  if (fe.statusCode && fe.statusCode < 500) {
    return send(fe.statusCode, fe.code ?? 'bad_request', fe.statusCode === 429 ? 'יותר מדי ניסיונות. נסו שוב בעוד דקה.' : 'הבקשה לא תקינה');
  }
  req.log.error({ err }, 'unhandled');
  if (process.env.DLX_DEBUG_ERRORS) console.error('UNHANDLED', err);
  return send(500, 'server_error', 'משהו השתבש בשרת. נסו שוב.', { retryable: true });
}
