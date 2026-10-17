// מנוע המסמכים (FIS-01..FIS-10, ACC-01..ACC-05): מספור רץ ללא כפילות, תמונת מצב קבועה, hash, מספר הקצאה.
// מסמך שהופק לא משתנה (טריגר ב-DB); תיקון רק במסמך מקושר (זיכוי).
import {
  allocationRequired, assertDocAllowed, DOC_TYPES, type DocType, type TaxStatus,
} from '@dlx/core';
import { randomBytes } from 'node:crypto';
import { audit, canonical, sha256 } from '../audit.js';
import { type Db, one } from '../db.js';
import { AppError } from '../errors.js';
import type { Providers } from './providers.js';

export interface DocLine {
  name: string; sku?: string | null; barcode?: string | null; qtyMilli: number; unitPrice: number; discount: number; total: number;
  rateBp: number; net: number; vat: number; kind?: string;
}
export interface DocPayment {
  method: string; amount: number; last4?: string | null; brand?: string | null; approvalCode?: string | null; installments?: number | null;
  checkNumber?: string | null; checkBank?: string | null; checkDate?: string | null;
}
export interface DocCustomer { id?: string | null; name: string; taxId?: string | null; kind?: string; address?: string | null; phone?: string | null }
export interface DocTotals {
  gross: number; discount: number; net: number; vat: number; total: number; rounding?: number; change?: number;
  byRate: { rateBp: number; net: number; vat: number; total: number }[];
}

export interface IssueInput {
  tenantId: string; actorId: string; type: DocType; taxDate: string; branchId?: string | null; registerId?: string | null;
  customer?: DocCustomer | null; lines: DocLine[]; payments?: DocPayment[]; totals: DocTotals;
  sourceType: string; sourceId?: string | null; originalDocumentId?: string | null; allowWithoutAllocation?: boolean;
  notes?: string | null;
}

export interface TenantRow {
  id: string; slug: string; legal_name: string; trade_name: string | null; tax_id: string; tax_status: TaxStatus; address: string | null;
  phone: string | null; email: string | null; allow_negative_stock: boolean; return_days: number; return_policy: string | null;
  receipt_footer: string | null; computerized_docs_enabled: boolean; status: string;
}

export const loadTenant = async (c: Db, id: string) => {
  const t = await one<TenantRow>(c, 'SELECT * FROM tenants WHERE id = $1', [id]);
  if (!t) throw new AppError(404, 'not_found', 'העסק לא נמצא');
  return t;
};

export async function reserveSerial(c: Db, tenantId: string, type: DocType): Promise<number> {
  await c.query('INSERT INTO document_sequences (tenant_id, doc_type) VALUES ($1,$2) ON CONFLICT DO NOTHING', [tenantId, type]);
  const r = await one<{ serial: number }>(c,
    'UPDATE document_sequences SET next_serial = next_serial + 1 WHERE tenant_id = $1 AND doc_type = $2 RETURNING next_serial - 1 AS serial',
    [tenantId, type]);
  return r!.serial;
}

export async function issueDocument(c: Db, providers: Providers, input: IssueInput) {
  const tenant = await loadTenant(c, input.tenantId);
  assertDocAllowed(input.type, tenant.tax_status);
  const info = DOC_TYPES[input.type];
  if (input.lines.length === 0) throw new AppError(422, 'rule', 'מסמך בלי שורות');
  const sum = input.lines.reduce((a, l) => a + l.total, 0);
  if (sum !== input.totals.total || input.totals.net + input.totals.vat !== input.totals.total) {
    throw new AppError(422, 'rule', 'סכומי המסמך לא תואמים לשורות');
  }
  if (info.isCredit && !input.originalDocumentId && input.sourceType !== 'return_no_receipt') {
    throw new AppError(422, 'rule', 'מסמך זיכוי חייב להיות מקושר למסמך המקור');
  }

  const branch = input.branchId ? await one(c, 'SELECT name, address, tax_zone FROM branches WHERE id = $1', [input.branchId]) : null;
  const issuer = {
    legalName: tenant.legal_name, tradeName: tenant.trade_name, taxId: tenant.tax_id, taxStatus: tenant.tax_status,
    address: branch?.address ?? tenant.address, phone: tenant.phone, branchName: branch?.name ?? null, taxZone: branch?.tax_zone ?? 'regular',
    returnPolicy: tenant.return_policy, footer: tenant.receipt_footer,
  };

  const serial = await reserveSerial(c, input.tenantId, input.type);
  const issuedAt = new Date().toISOString();
  const content = {
    type: input.type, code: info.code, serial, issuedAt, taxDate: input.taxDate, issuer, customer: input.customer ?? null,
    lines: input.lines, payments: input.payments ?? [], totals: input.totals, original: input.originalDocumentId ?? null, notes: input.notes ?? null,
  };

  // API-01 / FIS-06: מספר הקצאה לפני ההפקה — כך שהוא מופיע על המסמך עצמו
  let allocationNumber: string | null = null;
  let allocationStatus = 'not_required';
  const needs = allocationRequired({
    date: input.taxDate, type: input.type, issuerStatus: tenant.tax_status, customerVatId: input.customer?.taxId ?? null, netBeforeVat: input.totals.net,
  });
  if (needs) {
    const res = await providers.allocation.request({
      issuerVatId: tenant.tax_id, customerVatId: input.customer!.taxId!, docCode: info.code, serial, date: input.taxDate,
      netBeforeVat: input.totals.net, vat: input.totals.vat, total: input.totals.total,
    });
    if (res.status === 'approved') {
      allocationNumber = res.allocationNumber;
      allocationStatus = 'approved';
    } else if (input.allowWithoutAllocation) {
      allocationStatus = 'failed';
    } else {
      throw new AppError(502, 'allocation_failed', `לא התקבל מספר הקצאה מרשות המסים: ${res.reason}`, { retryable: res.retryable });
    }
    await c.query(
      `INSERT INTO allocation_requests (tenant_id, draft, status, attempts, request_id, response, allocation_number) VALUES ($1,$2,$3,1,$4,$5,$6)`,
      [input.tenantId, JSON.stringify(content), res.status === 'approved' ? 'approved' : res.status, res.requestId, JSON.stringify(res), allocationNumber]);
  }

  // מספר ההקצאה לא בתוך ה-hash: הוא מתועד בנפרד ב-allocation_requests, ומותר להשלים אותו פעם אחת
  const hash = sha256(canonical(content));
  const doc = await one(c,
    `INSERT INTO documents (tenant_id, doc_type, doc_code, serial, issued_at, tax_date, branch_id, register_id, issuer, customer, lines, payments, totals,
       net_agorot, vat_agorot, total_agorot, original_document_id, source_type, source_id, allocation_number, allocation_status, content_hash, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
    [input.tenantId, input.type, info.code, serial, issuedAt, input.taxDate, input.branchId ?? null, input.registerId ?? null,
      JSON.stringify(issuer), input.customer ? JSON.stringify(input.customer) : null, JSON.stringify(input.lines),
      JSON.stringify(input.payments ?? []), JSON.stringify({ ...input.totals, notes: input.notes ?? null }), input.totals.net, input.totals.vat,
      input.totals.total, input.originalDocumentId ?? null, input.sourceType, input.sourceId ?? null, allocationNumber, allocationStatus, hash, input.actorId]);

  await c.query(`UPDATE allocation_requests SET document_id = $2 WHERE tenant_id = $1 AND document_id IS NULL AND (draft->>'serial')::bigint = $3 AND draft->>'type' = $4`,
    [input.tenantId, doc.id, serial, input.type]);
  await audit(c, {
    tenantId: input.tenantId, actorId: input.actorId, action: 'document.issue', targetType: 'document', targetId: doc.id,
    details: { type: input.type, serial, total: input.totals.total, allocation: allocationStatus },
  });
  await c.query(`INSERT INTO outbox_events (tenant_id, event_type, payload, correlation_id) VALUES ($1,'FiscalDocumentIssued',$2,$3)`,
    [input.tenantId, JSON.stringify({ documentId: doc.id, type: input.type, serial }), input.sourceId ?? null]);
  return doc;
}

export const newPublicToken = () => randomBytes(24).toString('base64url');

// QA-06: האם התוכן השמור תואם ל-hash שנחתם בהפקה
export function verifyDocumentHash(doc: any): boolean {
  const content = {
    type: doc.doc_type, code: doc.doc_code, serial: Number(doc.serial), issuedAt: new Date(doc.issued_at).toISOString(), taxDate: doc.tax_date,
    issuer: doc.issuer, customer: doc.customer, lines: doc.lines, payments: doc.payments,
    totals: (({ notes: _n, ...t }) => t)(doc.totals), original: doc.original_document_id, notes: doc.totals?.notes ?? null,
  };
  return sha256(canonical(content)) === doc.content_hash;
}
