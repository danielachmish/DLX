// ייצוא: לרו"ח (CSV, ACC-06, O-05), מבנה אחיד (טיוטה, OPEN-01), וייצוא מלא של נתוני העסק ביציאה מהשירות (G-01)
import { DOC_TYPES, type DocType, PAYMENT_LABEL, type PaymentMethod } from '@dlx/core';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth, tx } from '../auth.js';
import { many } from '../db.js';
import { loadTenant } from '../services/documents.js';
import { buildOpenFormat } from '../services/openFormat.js';

const Range = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // הגנה מהזרקת נוסחאות באקסל
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const toCsv = (rows: unknown[][]) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const shekel = (a: number) => (a / 100).toFixed(2);

export async function exportRoutes(app: FastifyInstance) {
  // יומן מסמכים לרו"ח: מסמך לכל שורה + פירוט אמצעי תשלום. מבנה קבוע ומתועד (ACC-06)
  app.get('/exports/accountant.csv', { preHandler: requireAuth('tax:export') }, async (req, reply) => {
    const q = Range.parse(req.query);
    const docs = await tx(req, async (c) => {
      const rows = await many(c, 'SELECT * FROM documents WHERE tax_date BETWEEN $1 AND $2 ORDER BY doc_type, serial', [q.from, q.to]);
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'export.accountant', details: { ...q, count: rows.length } });
      return rows;
    });
    const header = ['סוג מסמך', 'קוד', 'מספר', 'תאריך', 'שעה', 'לקוח', 'ע.מ./ת.ז. לקוח', 'לפני מע"מ', 'מע"מ', 'סה"כ', 'מסמך מקור', 'מספר הקצאה', 'אמצעי תשלום', 'סניף'];
    const rows = docs.map((d) => {
      const info = DOC_TYPES[d.doc_type as DocType];
      const s = info.isCredit ? -1 : 1;
      return [
        info.title, info.code, d.serial, d.tax_date, new Date(d.issued_at).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }),
        d.customer?.name ?? '', d.customer?.taxId ?? '', shekel(s * d.net_agorot), shekel(s * d.vat_agorot), shekel(s * d.total_agorot), d.original_document_id ?? '',
        d.allocation_number ?? '', (d.payments as any[]).map((p) => `${PAYMENT_LABEL[p.method as PaymentMethod] ?? p.method} ${shekel(p.amount)}`).join(' | '), d.issuer?.branchName ?? '',
      ];
    });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="dlx-documents-${q.from}-${q.to}.csv"`);
    return toCsv([header, ...rows]);
  });

  // מבנה אחיד — טיוטה (ר' האזהרה ב-services/openFormat.ts)
  app.post('/exports/open-format', { preHandler: requireAuth('tax:export') }, async (req) => {
    const q = Range.parse(req.body);
    return tx(req, async (c) => {
      const tenant = await loadTenant(c, req.auth.tenantId);
      const documents = await many(c, `SELECT * FROM documents WHERE tax_date BETWEEN $1 AND $2 AND doc_type <> 'delivery_note' ORDER BY issued_at`, [q.from, q.to]);
      const items = await many(c,
        `SELECT p.sku, p.name, p.unit_measure, (SELECT barcode FROM barcodes b WHERE b.product_id = p.id LIMIT 1) AS barcode,
           COALESCE(SUM(m.qty_delta_milli) FILTER (WHERE (m.created_at AT TIME ZONE 'Asia/Jerusalem')::date < $1),0) AS opening_milli,
           COALESCE(SUM(m.qty_delta_milli) FILTER (WHERE m.qty_delta_milli > 0 AND (m.created_at AT TIME ZONE 'Asia/Jerusalem')::date BETWEEN $1 AND $2),0) AS in_milli,
           COALESCE(-SUM(m.qty_delta_milli) FILTER (WHERE m.qty_delta_milli < 0 AND (m.created_at AT TIME ZONE 'Asia/Jerusalem')::date BETWEEN $1 AND $2),0) AS out_milli
         FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id AND m.location = 'sale' WHERE p.track_stock GROUP BY p.id ORDER BY p.sku`, [q.from, q.to]);
      const primaryId = String(Date.now()).slice(-15);
      const out = buildOpenFormat({
        tenant, from: q.from, to: q.to, primaryId, documents, items,
        software: { name: 'DLX', version: '0.1.0', registration: app.config.softwareRegistration ?? '00000000', vendorVatId: process.env.DLX_VENDOR_VAT_ID ?? '000000000', vendorName: 'DLX' },
      });
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'export.open_format', details: { ...q, records: out.totalRecords, primaryId } });
      return { path: out.path, counts: out.counts, totalRecords: out.totalRecords, warning: out.warning, iniBase64: out.ini.toString('base64'), bkmvdataBase64: out.bkmvdata.toString('base64') };
    });
  });

  // G-01: ייצוא מלא של כל נתוני העסק (JSON) — כדי שהעסק יעמוד בחובת השמירה גם אחרי שעזב את השירות
  app.get('/exports/full', { preHandler: requireAuth('settings:write') }, async (req, reply) => {
    const data = await tx(req, async (c) => {
      const tables = ['tenants', 'branches', 'registers', 'categories', 'products', 'barcodes', 'branch_prices', 'price_changes', 'suppliers', 'purchase_orders',
        'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines', 'stock_movements', 'inventory_counts', 'inventory_count_lines', 'customers', 'consents',
        'customer_ledger', 'cash_sessions', 'cash_events', 'sales', 'sale_lines', 'payments', 'returns', 'return_lines', 'documents', 'document_prints',
        'allocation_requests', 'vouchers', 'voucher_ledger', 'audit_events'];
      const out: Record<string, unknown> = { exported_at: new Date().toISOString(), export_id: randomUUID(), format: 'dlx-full-export-v1' };
      for (const t of tables) out[t] = await many(c, `SELECT * FROM ${t}`);
      out.users = await many(c, 'SELECT id, name, email, role, branch_id, active, created_at FROM users'); // בלי סיסמאות ו-PIN
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'export.full' });
      return out;
    });
    reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', 'attachment; filename="dlx-full-export.json"');
    return data;
  });
}
