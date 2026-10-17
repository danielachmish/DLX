// לקוחות, יתרות והסכמות (CRM-01..CRM-05, G-04, SEC-01)
import { can, isValidIsraeliId, israelDate } from '@dlx/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth, tx } from '../auth.js';
import { many, one } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { idemKey, idempotent } from '../idempotency.js';
import { issueDocument } from '../services/documents.js';

const Customer = z.object({
  name: z.string().min(1), kind: z.enum(['private', 'business']).default('private'),
  taxId: z.string().refine((v) => !v || isValidIsraeliId(v), 'מספר זהות / עוסק לא תקין').nullable().optional(),
  phone: z.string().max(30).nullable().optional(), email: z.string().email().nullable().optional().or(z.literal('')),
  address: z.string().nullable().optional(), creditLimitAgorot: z.number().int().min(0).optional(), notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

// נוסח ההסכמה נשמר עם הגרסה, כדי שאפשר יהיה להוכיח למה הלקוח הסכים
export const CONSENT_TEXT_VERSION = 'marketing-2026-10-v1';

export async function customerBalance(c: any, customerId: string): Promise<number> {
  const r = await one(c, 'SELECT COALESCE(SUM(amount_agorot),0) AS b FROM customer_ledger WHERE customer_id = $1', [customerId]);
  return r.b;
}

export async function customerRoutes(app: FastifyInstance) {
  app.get('/customers', { preHandler: requireAuth('customers:read') }, async (req) => {
    const q = z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return tx(req, (c) => many(c,
      `SELECT c.id, c.name, c.kind, c.tax_id, c.phone, c.email, c.credit_limit_agorot, c.active,
         COALESCE((SELECT SUM(amount_agorot) FROM customer_ledger l WHERE l.customer_id = c.id),0) AS balance_agorot
       FROM customers c
       WHERE ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%' OR c.phone LIKE '%' || $1 || '%' OR c.tax_id = $1)
       ORDER BY c.active DESC, c.name LIMIT $2`, [q.q?.trim() || null, q.limit]));
  });

  app.post('/customers', { preHandler: requireAuth('customers:write') }, async (req) => {
    const b = Customer.parse(req.body);
    if (b.creditLimitAgorot && b.creditLimitAgorot > 0) {
      if (!can(req.auth.role, 'customers:credit')) throw new AppError(403, 'forbidden', 'מסגרת אשראי ללקוח — רק מנהל');
    }
    return tx(req, async (c) => {
      const r = await one(c,
        `INSERT INTO customers (tenant_id, name, kind, tax_id, phone, email, address, credit_limit_agorot, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.auth.tenantId, b.name, b.kind, b.taxId?.replace(/\D/g, '') || null, b.phone ?? null, b.email || null, b.address ?? null, b.creditLimitAgorot ?? 0, b.notes ?? null]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'customer.create', targetType: 'customer', targetId: r.id });
      return r;
    });
  });

  app.put('/customers/:id', { preHandler: requireAuth('customers:write') }, async (req) => {
    const b = Customer.parse(req.body);
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const cur = await one(c, 'SELECT * FROM customers WHERE id = $1', [id]);
      if (!cur) throw notFound('הלקוח');
      const limit = can(req.auth.role, 'customers:credit') ? (b.creditLimitAgorot ?? cur.credit_limit_agorot) : cur.credit_limit_agorot;
      const r = await one(c,
        `UPDATE customers SET name=$2, kind=$3, tax_id=$4, phone=$5, email=$6, address=$7, credit_limit_agorot=$8, notes=$9, active=COALESCE($10, active) WHERE id=$1 RETURNING *`,
        [id, b.name, b.kind, b.taxId?.replace(/\D/g, '') || null, b.phone ?? null, b.email || null, b.address ?? null, limit, b.notes ?? null, b.active ?? null]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'customer.update', targetType: 'customer', targetId: id });
      return r;
    });
  });

  // CRM-02: כל ההיסטוריה המקושרת
  app.get('/customers/:id', { preHandler: requireAuth('customers:read') }, async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const cu = await one(c, 'SELECT * FROM customers WHERE id = $1', [id]);
      if (!cu) throw notFound('הלקוח');
      cu.balance_agorot = await customerBalance(c, id);
      cu.documents = await many(c, `SELECT id, doc_type, serial, issued_at, total_agorot FROM documents WHERE customer->>'id' = $1 ORDER BY issued_at DESC LIMIT 100`, [id]);
      cu.ledger = await many(c, 'SELECT id, amount_agorot, source_type, source_id, document_id, created_at FROM customer_ledger WHERE customer_id = $1 ORDER BY id DESC LIMIT 100', [id]);
      cu.consents = await many(c,
        `SELECT DISTINCT ON (kind) kind, granted, source, text_version, created_at FROM consents WHERE customer_id = $1 ORDER BY kind, id DESC`, [id]);
      return cu;
    });
  });

  // G-04 / CRM-05: הסכמה לדיוור — כל שינוי נרשם (מתי, איך, איזה נוסח). ביטול = רשומה חדשה עם granted=false
  app.post('/customers/:id/consents', { preHandler: requireAuth('customers:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ kind: z.enum(['marketing_sms', 'marketing_email', 'computerized_docs']), granted: z.boolean(), source: z.enum(['pos', 'office', 'web', 'unsubscribe_link', 'phone']) }).parse(req.body);
    return tx(req, async (c) => {
      if (!(await one(c, 'SELECT 1 FROM customers WHERE id = $1', [id]))) throw notFound('הלקוח');
      const r = await one(c, 'INSERT INTO consents (tenant_id, customer_id, kind, granted, source, text_version, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [req.auth.tenantId, id, b.kind, b.granted, b.source, CONSENT_TEXT_VERSION, req.auth.userId]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'consent', targetType: 'customer', targetId: id, details: b });
      return r;
    });
  });

  // CRM-04: תשלום על חשבון חוב → קבלה (400), התנועה מקטינה את היתרה
  app.post('/customers/:id/payments', { preHandler: requireAuth('pos:sell') }, async (req) => {
    const { id } = req.params as { id: string };
    const key = idemKey(req);
    const b = z.object({
      method: z.enum(['cash', 'card', 'check', 'transfer', 'bit']), amountAgorot: z.number().int().positive(), sessionId: z.string().uuid().nullable().optional(),
      approvalCode: z.string().max(20).nullable().optional(), last4: z.string().regex(/^\d{4}$/).nullable().optional(),
      checkNumber: z.string().nullable().optional(), checkBank: z.string().nullable().optional(), checkDate: z.string().nullable().optional(),
    }).parse(req.body);
    return tx(req, async (c) => (await idempotent(c, req.auth.tenantId, key, 'customer.payment', { id, ...b }, async () => {
      const cu = await one(c, 'SELECT * FROM customers WHERE id = $1', [id]);
      if (!cu) throw notFound('הלקוח');
      const balance = await customerBalance(c, id);
      if (b.amountAgorot > balance) throw new AppError(422, 'rule', 'הסכום גדול מיתרת החוב');
      const session = b.sessionId ? await one(c, "SELECT * FROM cash_sessions WHERE id = $1 AND status = 'active'", [b.sessionId]) : null;
      const pay = await one(c,
        `INSERT INTO payments (tenant_id, customer_id, session_id, method, amount_agorot, status, provider, approval_code, card_last4, check_number, check_bank, check_date, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,'captured',$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [req.auth.tenantId, id, session?.id ?? null, b.method, b.amountAgorot, b.method === 'card' ? 'manual_terminal' : 'none', b.approvalCode ?? null, b.last4 ?? null,
          b.checkNumber ?? null, b.checkBank ?? null, b.checkDate ?? null, key]);
      const doc = await issueDocument(c, app.providers, {
        tenantId: req.auth.tenantId, actorId: req.auth.userId, type: 'receipt', taxDate: israelDate(new Date()),
        branchId: session?.branch_id ?? req.auth.branchId, registerId: session?.register_id ?? null,
        customer: { id: cu.id, name: cu.name, taxId: cu.tax_id, kind: cu.kind, address: cu.address, phone: cu.phone },
        lines: [{ name: 'תשלום על חשבון', qtyMilli: 1000, unitPrice: b.amountAgorot, discount: 0, total: b.amountAgorot, rateBp: 0, net: b.amountAgorot, vat: 0 }],
        payments: [{ method: b.method, amount: b.amountAgorot, approvalCode: b.approvalCode, last4: b.last4, checkNumber: b.checkNumber, checkBank: b.checkBank, checkDate: b.checkDate }],
        totals: { gross: b.amountAgorot, discount: 0, net: b.amountAgorot, vat: 0, total: b.amountAgorot, byRate: [{ rateBp: 0, net: b.amountAgorot, vat: 0, total: b.amountAgorot }] },
        sourceType: 'customer_payment', sourceId: pay.id,
      });
      await c.query('INSERT INTO customer_ledger (tenant_id, customer_id, amount_agorot, source_type, source_id, document_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [req.auth.tenantId, id, -b.amountAgorot, 'payment', pay.id, doc.id]);
      return { paymentId: pay.id, document: { id: doc.id, doc_type: doc.doc_type, serial: doc.serial }, balance_agorot: balance - b.amountAgorot };
    })).value);
  });
}
