// מסמכים: איתור, צפייה, הדפסה (מקור/העתק), קישור צפייה ללקוח, והפקה ידנית מהמשרד (ACC-07, FIS-05, FIS-07, DIG-01)
import { assertDocAllowed, computeCart, DOC_TYPES, type DocType, israelDate, printMark } from '@dlx/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth, tx } from '../auth.js';
import { many, one, withTenant } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { idemKey, idempotent } from '../idempotency.js';
import { issueDocument, loadTenant, newPublicToken, verifyDocumentHash } from '../services/documents.js';
import { type PrintFormat, renderDocumentHtml } from '../services/render.js';

const DOC_TYPE_KEYS = Object.keys(DOC_TYPES) as [DocType, ...DocType[]];

export async function documentRoutes(app: FastifyInstance) {
  // ACC-07: איתור לפי עסק, סוג, מספר, תאריך, סכום, לקוח
  app.get('/documents', { preHandler: requireAuth('document:read') }, async (req) => {
    const q = z.object({
      type: z.enum(DOC_TYPE_KEYS).optional(), serial: z.coerce.number().int().optional(), from: z.string().optional(), to: z.string().optional(),
      q: z.string().optional(), minTotal: z.coerce.number().int().optional(), maxTotal: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    return tx(req, (c) => many(c,
      `SELECT d.id, d.doc_type, d.doc_code, d.serial, d.issued_at, d.tax_date, d.total_agorot, d.vat_agorot, d.net_agorot, d.customer->>'name' AS customer_name,
         d.allocation_number, d.allocation_status, d.print_count, d.source_type, d.source_id, d.original_document_id, b.name AS branch_name
       FROM documents d LEFT JOIN branches b ON b.id = d.branch_id
       WHERE ($1::text IS NULL OR d.doc_type = $1) AND ($2::bigint IS NULL OR d.serial = $2)
         AND ($3::date IS NULL OR d.tax_date >= $3) AND ($4::date IS NULL OR d.tax_date <= $4)
         AND ($5::text IS NULL OR d.customer->>'name' ILIKE '%' || $5 || '%' OR d.customer->>'taxId' = $5)
         AND ($6::bigint IS NULL OR d.total_agorot >= $6) AND ($7::bigint IS NULL OR d.total_agorot <= $7)
       ORDER BY d.issued_at DESC LIMIT $8 OFFSET $9`,
      [q.type ?? null, q.serial ?? null, q.from ?? null, q.to ?? null, q.q?.trim() || null, q.minTotal ?? null, q.maxTotal ?? null, q.limit, q.offset]));
  });

  app.get('/documents/:id', { preHandler: requireAuth('document:read') }, async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const d = await one(c, 'SELECT * FROM documents WHERE id = $1', [id]);
      if (!d) throw notFound('המסמך');
      const related = await many(c, 'SELECT id, doc_type, serial, issued_at, total_agorot FROM documents WHERE original_document_id = $1 OR id = $2 ORDER BY issued_at',
        [id, d.original_document_id]);
      const prints = await many(c, 'SELECT p.mark, p.format, p.created_at, u.name AS actor_name FROM document_prints p LEFT JOIN users u ON u.id = p.actor_id WHERE document_id = $1 ORDER BY p.id', [id]);
      return { ...d, title: DOC_TYPES[d.doc_type as DocType].title, related: related.filter((r) => r.id !== id), prints, hash_ok: verifyDocumentHash(d) };
    });
  });

  // FIS-05, T14: ההדפסה הראשונה בלבד "מקור". הדפסה חוזרת / קריסה באמצע — "העתק", לא מקור שני
  app.post('/documents/:id/print', { preHandler: requireAuth('document:read') }, async (req) => {
    const { id } = req.params as { id: string };
    const { format, preview } = z.object({ format: z.enum(['80mm', '58mm', 'a4']).default('80mm'), preview: z.boolean().default(false) }).parse(req.body ?? {});
    return tx(req, async (c) => {
      const d = await one(c, 'SELECT * FROM documents WHERE id = $1 FOR UPDATE', [id]);
      if (!d) throw notFound('המסמך');
      const mark = preview ? 'תצוגה בלבד — לא מסמך' : printMark(d.print_count);
      if (!preview) {
        await c.query('UPDATE documents SET print_count = print_count + 1 WHERE id = $1', [id]);
        await c.query('INSERT INTO document_prints (tenant_id, document_id, mark, format, actor_id) VALUES ($1,$2,$3,$4,$5)', [req.auth.tenantId, id, mark, format, req.auth.userId]);
        if (d.print_count > 0) await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'document.reprint', targetType: 'document', targetId: id });
      }
      const orig = d.original_document_id ? await one(c, 'SELECT serial FROM documents WHERE id = $1', [d.original_document_id]) : null;
      const viewUrl = d.public_token ? `${app.config.publicBaseUrl}/d/${d.public_token}` : null;
      return { html: renderDocumentHtml(d, { format: format as PrintFormat, mark, viewUrl, originalSerial: orig?.serial ?? null }), mark };
    });
  });

  // D05: קישור צפייה ללקוח (וואטסאפ / SMS / מייל). המסמך הרשמי נשאר המסמך שהופק — הקישור מציג אותו כ"העתק"
  app.post('/documents/:id/link', { preHandler: requireAuth('document:send') }, async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const d = await one(c, 'SELECT id, public_token FROM documents WHERE id = $1', [id]);
      if (!d) throw notFound('המסמך');
      let token = d.public_token;
      if (!token) {
        token = newPublicToken();
        await c.query('UPDATE documents SET public_token = $2 WHERE id = $1 AND public_token IS NULL', [id, token]);
      }
      await audit(c, { tenantId: req.auth.tenantId, actorId: req.auth.userId, action: 'document.link', targetType: 'document', targetId: id });
      return { url: `${app.config.publicBaseUrl}/d/${token}`, apiUrl: `/v1/public/documents/${token}`, token };
    });
  });

  // צפייה ציבורית לפי אסימון בלבד (בלי זיהוי). נגיש, מימין לשמאל (G-07)
  app.get('/public/documents/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const r = await app.pool.query('SELECT * FROM dlx_public_document($1)', [token]);
    const hit = r.rows[0];
    if (!hit) throw new AppError(404, 'not_found', 'המסמך לא נמצא');
    const html = await withTenant(app.pool, hit.tenant_id, async (c) => {
      const d = await one(c, 'SELECT * FROM documents WHERE id = $1', [hit.document_id]);
      const orig = d.original_document_id ? await one(c, 'SELECT serial FROM documents WHERE id = $1', [d.original_document_id]) : null;
      return renderDocumentHtml(d, { format: 'a4', mark: 'העתק נאמן למקור', originalSerial: orig?.serial ?? null });
    });
    reply.header('content-type', 'text/html; charset=utf-8').header('x-robots-tag', 'noindex').header('cache-control', 'private, no-store');
    return html;
  });

  // הפקה ידנית מהמשרד: חשבונית מס / חשבונית עסקה / תעודת משלוח ללקוח (B2B). חשבוניות ישראל נבדקות במנוע (QA-09)
  app.post('/documents', { preHandler: requireAuth('document:issue') }, async (req) => {
    const key = idemKey(req);
    const b = z.object({
      type: z.enum(['tax_invoice', 'deal_invoice', 'delivery_note']),
      customerId: z.string().uuid(),
      branchId: z.string().uuid().optional(),
      lines: z.array(z.object({
        name: z.string().min(1), productId: z.string().uuid().optional(), qtyMilli: z.number().int().positive(), unitPriceAgorot: z.number().int().min(0),
        taxCategory: z.enum(['standard', 'zero', 'exempt']).default('standard'), discountAgorot: z.number().int().min(0).optional(),
      })).min(1),
      notes: z.string().max(500).optional(),
      postToAccount: z.boolean().default(true), // חשבונית מס בלי תקבול — נרשמת כחוב הלקוח
      allowWithoutAllocation: z.boolean().default(false),
    }).parse(req.body);
    return tx(req, async (c) => (await idempotent(c, req.auth.tenantId, key, 'document.manual', b, async () => {
      const tenant = await loadTenant(c, req.auth.tenantId);
      assertDocAllowed(b.type, tenant.tax_status);
      const cu = await one(c, 'SELECT * FROM customers WHERE id = $1', [b.customerId]);
      if (!cu) throw notFound('הלקוח');
      const branch = b.branchId ? await one(c, 'SELECT * FROM branches WHERE id = $1', [b.branchId]) : await one(c, 'SELECT * FROM branches WHERE active ORDER BY created_at LIMIT 1');
      const date = israelDate(new Date());
      const { lines, totals } = computeCart({
        lines: b.lines.map((l, i) => ({ key: String(i), productId: l.productId, name: l.name, unitPrice: l.unitPriceAgorot, qtyMilli: l.qtyMilli, taxCategory: l.taxCategory, discountAgorot: l.discountAgorot })),
      }, { date, status: tenant.tax_status, zone: branch?.tax_zone ?? 'regular' });
      const doc = await issueDocument(c, app.providers, {
        tenantId: req.auth.tenantId, actorId: req.auth.userId, type: b.type, taxDate: date, branchId: branch?.id ?? null,
        customer: { id: cu.id, name: cu.name, taxId: cu.tax_id, kind: cu.kind, address: cu.address, phone: cu.phone },
        lines: lines.map((l) => ({ name: l.name, qtyMilli: l.qtyMilli, unitPrice: l.unitPrice, discount: l.lineDiscount, total: l.total, rateBp: l.rateBp, net: l.net, vat: l.vat })),
        totals: { gross: totals.gross, discount: totals.discount, net: totals.net, vat: totals.vat, total: totals.total, byRate: totals.byRate },
        sourceType: 'manual', notes: b.notes ?? null, allowWithoutAllocation: b.allowWithoutAllocation,
      });
      if (b.postToAccount && b.type !== 'delivery_note') {
        await c.query("INSERT INTO customer_ledger (tenant_id, customer_id, amount_agorot, source_type, source_id, document_id) VALUES ($1,$2,$3,'invoice',$4,$4)",
          [req.auth.tenantId, cu.id, totals.total, doc.id]);
      }
      return doc;
    })).value);
  });
}
