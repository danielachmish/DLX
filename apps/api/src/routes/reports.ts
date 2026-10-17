// דוחות (RPT-01..RPT-06, פרק 11 — מדדים מוסכמים, G-02 רשימת מלאי לסוף שנה).
// כל סכום מגיע ממסמכים / תנועות שנסגרו. מכירות נטו = מכירות פחות החזרות (שורות), לפני ואחרי מע"מ.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { branchScope, hasPerm, requireAuth, tx } from '../auth.js';
import { many, one } from '../db.js';

const Range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branchId: z.string().uuid().optional(),
});

export async function reportRoutes(app: FastifyInstance) {
  // RPT-01: לוח בקרה לבעל העסק — היום, לפי סניף
  app.get('/reports/dashboard', { preHandler: requireAuth('reports:sales') }, async (req) => {
    const q = z.object({ branchId: z.string().uuid().optional(), date: z.string().optional() }).parse(req.query);
    const branchId = branchScope(req, q.branchId);
    return tx(req, async (c) => {
      const day = q.date ?? (await one(c, "SELECT (now() AT TIME ZONE 'Asia/Jerusalem')::date::text AS d")).d;
      const sales = await one(c,
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_agorot),0) AS total, COALESCE(SUM(net_agorot),0) AS net, COALESCE(SUM(discount_agorot),0) AS discount
         FROM sales WHERE status = 'finalized' AND tax_date = $1 AND ($2::uuid IS NULL OR branch_id = $2)`, [day, branchId]);
      const returns = await one(c,
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_agorot),0) AS total, COALESCE(SUM(net_agorot),0) AS net FROM returns
         WHERE document_id IS NOT NULL AND (created_at AT TIME ZONE 'Asia/Jerusalem')::date = $1 AND ($2::uuid IS NULL OR branch_id = $2)`, [day, branchId]);
      const byMethod = await many(c,
        `SELECT p.method, COALESCE(SUM(CASE WHEN p.direction='in' THEN p.amount_agorot ELSE -p.amount_agorot END),0) AS amount
         FROM payments p JOIN cash_sessions s ON s.id = p.session_id
         WHERE p.status IN ('captured','refunded_partial','refunded_full') AND (p.created_at AT TIME ZONE 'Asia/Jerusalem')::date = $1 AND ($2::uuid IS NULL OR s.branch_id = $2)
         GROUP BY p.method ORDER BY amount DESC`, [day, branchId]);
      const byHour = await many(c,
        `SELECT extract(hour FROM finalized_at AT TIME ZONE 'Asia/Jerusalem')::int AS hour, COUNT(*)::int AS count, SUM(total_agorot) AS total
         FROM sales WHERE status = 'finalized' AND tax_date = $1 AND ($2::uuid IS NULL OR branch_id = $2) GROUP BY 1 ORDER BY 1`, [day, branchId]);
      const top = await many(c,
        `SELECT l.product_id, l.name, SUM(l.qty_milli) AS qty_milli, SUM(l.total_agorot) AS total
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE s.status = 'finalized' AND s.tax_date = $1 AND l.kind = 'item' AND ($2::uuid IS NULL OR s.branch_id = $2)
         GROUP BY l.product_id, l.name ORDER BY total DESC LIMIT 8`, [day, branchId]);
      const low = await one(c,
        `SELECT COUNT(*)::int AS n FROM (SELECT p.id FROM products p CROSS JOIN branches b LEFT JOIN stock_movements m ON m.product_id = p.id AND m.branch_id = b.id AND m.location = 'sale'
           WHERE p.track_stock AND p.status = 'active' AND ($1::uuid IS NULL OR b.id = $1) GROUP BY p.id, b.id HAVING COALESCE(SUM(m.qty_delta_milli),0) <= p.min_stock_milli) x`, [branchId]);
      const openSessions = await many(c,
        `SELECT s.id, s.number, s.opened_at, r.name AS register_name, u.name AS opened_by_name FROM cash_sessions s JOIN registers r ON r.id = s.register_id
         LEFT JOIN users u ON u.id = s.opened_by WHERE s.status <> 'closed' AND ($1::uuid IS NULL OR s.branch_id = $1) ORDER BY s.opened_at`, [branchId]);
      let gross_profit: number | null = null;
      if (hasPerm(req, 'reports:profit')) {
        const gp = await one(c,
          `SELECT COALESCE(SUM(l.net_agorot - ROUND(l.unit_cost_agorot * l.qty_milli / 1000.0)),0) AS gp FROM sale_lines l JOIN sales s ON s.id = l.sale_id
           WHERE s.status = 'finalized' AND s.tax_date = $1 AND l.kind = 'item' AND ($2::uuid IS NULL OR s.branch_id = $2)`, [day, branchId]);
        gross_profit = gp.gp;
      }
      const exceptions = await exceptionCount(c);
      return {
        day, sales, returns, net_sales_agorot: sales.net - returns.net, total_after_returns_agorot: sales.total - returns.total,
        avg_basket_agorot: sales.count ? Math.round(sales.total / sales.count) : 0, by_method: byMethod, by_hour: byHour, top_products: top,
        low_stock: low.n, open_sessions: openSessions, gross_profit_agorot: gross_profit, exceptions,
      };
    });
  });

  // RPT-02: מכירות לפי ממד — סכום הדוח תואם לסכום המסמכים בתקופה
  app.get('/reports/sales', { preHandler: requireAuth('reports:sales') }, async (req) => {
    const q = Range.extend({ groupBy: z.enum(['day', 'product', 'category', 'cashier', 'register', 'payment', 'hour', 'branch']).default('day') }).parse(req.query);
    const branchId = branchScope(req, q.branchId);
    return tx(req, async (c) => {
      if (q.groupBy === 'payment') {
        return many(c,
          `SELECT p.method AS key, p.method AS label, COUNT(*)::int AS count,
             SUM(CASE WHEN p.direction='in' THEN p.amount_agorot ELSE -p.amount_agorot END) AS total
           FROM payments p JOIN cash_sessions s ON s.id = p.session_id
           WHERE p.status IN ('captured','refunded_partial','refunded_full') AND (p.created_at AT TIME ZONE 'Asia/Jerusalem')::date BETWEEN $1 AND $2
             AND ($3::uuid IS NULL OR s.branch_id = $3) GROUP BY p.method ORDER BY total DESC`, [q.from, q.to, branchId]);
      }
      const dim = {
        day: { key: 's.tax_date::text', label: 's.tax_date::text', join: '' },
        hour: { key: "extract(hour FROM s.finalized_at AT TIME ZONE 'Asia/Jerusalem')::int::text", label: "lpad(extract(hour FROM s.finalized_at AT TIME ZONE 'Asia/Jerusalem')::int::text, 2, '0') || ':00'", join: '' },
        product: { key: 'l.product_id::text', label: 'l.name', join: '' },
        category: { key: "COALESCE(cat.name, 'ללא קטגוריה')", label: "COALESCE(cat.name, 'ללא קטגוריה')", join: 'LEFT JOIN products p ON p.id = l.product_id LEFT JOIN categories cat ON cat.id = p.category_id' },
        cashier: { key: 's.cashier_id::text', label: 'u.name', join: 'LEFT JOIN users u ON u.id = s.cashier_id' },
        register: { key: 's.register_id::text', label: 'r.name', join: 'LEFT JOIN registers r ON r.id = s.register_id' },
        branch: { key: 's.branch_id::text', label: 'b.name', join: 'LEFT JOIN branches b ON b.id = s.branch_id' },
      }[q.groupBy];
      const profit = hasPerm(req, 'reports:profit')
        ? ", SUM(l.net_agorot - ROUND(l.unit_cost_agorot * l.qty_milli / 1000.0)) FILTER (WHERE l.kind = 'item') AS gross_profit"
        : '';
      return many(c,
        `SELECT ${dim.key} AS key, ${dim.label} AS label, COUNT(DISTINCT s.id)::int AS count, SUM(l.qty_milli) FILTER (WHERE l.kind = 'item') AS qty_milli,
           SUM(l.line_discount_agorot + l.cart_discount_agorot) AS discount, SUM(l.net_agorot) AS net, SUM(l.vat_agorot) AS vat, SUM(l.total_agorot) AS total ${profit}
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id ${dim.join}
         WHERE s.status = 'finalized' AND s.tax_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR s.branch_id = $3)
         GROUP BY 1, 2 ORDER BY ${q.groupBy === 'day' || q.groupBy === 'hour' ? '1' : 'total DESC'} LIMIT 1000`, [q.from, q.to, branchId]);
    });
  });

  // סיכום מע"מ עסקאות לתקופה (לדוח התקופתי): מסמכי מס פחות זיכויים
  app.get('/reports/vat', { preHandler: requireAuth('tax:export') }, async (req) => {
    const q = Range.parse(req.query);
    return tx(req, (c) => many(c,
      `SELECT doc_type, COUNT(*)::int AS count, SUM(net_agorot) AS net, SUM(vat_agorot) AS vat, SUM(total_agorot) AS total
       FROM documents WHERE tax_date BETWEEN $1 AND $2 AND doc_type IN ('tax_invoice','tax_invoice_receipt','credit_invoice') GROUP BY doc_type`, [q.from, q.to]))
      .then((rows) => {
        const sign = (r: any) => (r.doc_type === 'credit_invoice' ? -1 : 1);
        return {
          rows, net_agorot: rows.reduce((a, r) => a + sign(r) * r.net, 0), vat_agorot: rows.reduce((a, r) => a + sign(r) * r.vat, 0),
          note: 'מע"מ עסקאות בלבד. מע"מ תשומות — מחשבוניות הספקים אצל מנהל החשבונות.',
        };
      });
  });

  // RPT-03: רווחיות — רק למורשה
  app.get('/reports/profit', { preHandler: requireAuth('reports:profit') }, async (req) => {
    const q = Range.parse(req.query);
    const branchId = branchScope(req, q.branchId);
    return tx(req, (c) => many(c,
      `SELECT l.product_id, l.name, SUM(l.qty_milli) AS qty_milli, SUM(l.net_agorot) AS net, SUM(ROUND(l.unit_cost_agorot * l.qty_milli / 1000.0)) AS cost,
         SUM(l.net_agorot - ROUND(l.unit_cost_agorot * l.qty_milli / 1000.0)) AS gross_profit, bool_or(l.unit_cost_agorot = 0) AS missing_cost
       FROM sale_lines l JOIN sales s ON s.id = l.sale_id
       WHERE s.status = 'finalized' AND l.kind = 'item' AND s.tax_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR s.branch_id = $3)
       GROUP BY l.product_id, l.name ORDER BY gross_profit DESC LIMIT 1000`, [q.from, q.to, branchId]));
  });

  // G-02: רשימת מלאי לתאריך (סוף שנה) — כמות ועלות לפי מוצר וסניף, מחושב מהתנועות עד התאריך
  app.get('/reports/inventory-list', { preHandler: requireAuth('reports:profit') }, async (req) => {
    const q = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), branchId: z.string().uuid().optional() }).parse(req.query);
    return tx(req, async (c) => {
      const rows = await many(c,
        `SELECT p.sku, p.name, p.unit_measure, b.name AS branch_name, m.location, SUM(m.qty_delta_milli) AS qty_milli, p.cost_agorot,
           ROUND(SUM(m.qty_delta_milli) * p.cost_agorot / 1000.0) AS value_agorot
         FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN branches b ON b.id = m.branch_id
         WHERE (m.created_at AT TIME ZONE 'Asia/Jerusalem')::date <= $1 AND ($2::uuid IS NULL OR m.branch_id = $2)
         GROUP BY p.id, b.id, m.location HAVING SUM(m.qty_delta_milli) <> 0 ORDER BY b.name, p.name`, [q.date, q.branchId ?? null]);
      return {
        date: q.date, rows, total_value_agorot: rows.filter((r) => r.location === 'sale').reduce((a, r) => a + Number(r.value_agorot), 0),
        note: 'הערכה לפי עלות ממוצעת נוכחית. לפני הגשה — לאמת שיטת הערכה וחתימה מול רו"ח (G-02).',
      };
    });
  });

  // מרכז חריגים (S19): תשלום שנתקע, מכירה פתוחה, מסמך בלי מספר הקצאה, פער קופה, מלאי שלילי
  app.get('/reports/exceptions', { preHandler: requireAuth('reports:sales') }, async (req) => tx(req, async (c) => ({
    stuck_payments: await many(c,
      `SELECT p.id, p.amount_agorot, p.status, p.created_at, p.sale_id FROM payments p WHERE p.status IN ('initiated','pending') AND p.created_at < now() - interval '2 minutes' ORDER BY p.created_at`),
    open_sales: await many(c,
      `SELECT s.id, s.total_agorot, s.created_at, r.name AS register_name FROM sales s JOIN registers r ON r.id = s.register_id
       WHERE s.status IN ('payment_pending','exception') AND s.created_at < now() - interval '30 minutes' ORDER BY s.created_at`),
    allocation_failed: await many(c, "SELECT id, doc_type, serial, issued_at, total_agorot FROM documents WHERE allocation_status IN ('failed','pending') ORDER BY issued_at DESC LIMIT 100"),
    cash_variance: await many(c,
      `SELECT s.id, s.number, s.closed_at, s.variance_agorot, s.variance_reason, r.name AS register_name FROM cash_sessions s JOIN registers r ON r.id = s.register_id
       WHERE s.status = 'closed' AND s.variance_agorot <> 0 AND s.closed_at > now() - interval '30 days' ORDER BY s.closed_at DESC`),
    negative_stock: await many(c,
      `SELECT p.id, p.name, b.name AS branch_name, SUM(m.qty_delta_milli) AS on_hand FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN branches b ON b.id = m.branch_id
       WHERE m.location = 'sale' GROUP BY p.id, b.id HAVING SUM(m.qty_delta_milli) < 0`),
    no_sale_opens: await many(c,
      `SELECT e.id, e.created_at, e.reason, u.name AS actor_name FROM cash_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.kind = 'no_sale' AND e.created_at > now() - interval '7 days' ORDER BY e.created_at DESC`),
  })));
}

async function exceptionCount(c: any): Promise<number> {
  const r = await one(c,
    `SELECT (SELECT COUNT(*) FROM payments WHERE status IN ('initiated','pending') AND created_at < now() - interval '2 minutes')
          + (SELECT COUNT(*) FROM sales WHERE status IN ('payment_pending','exception') AND created_at < now() - interval '30 minutes')
          + (SELECT COUNT(*) FROM documents WHERE allocation_status IN ('failed','pending')) AS n`);
  return Number(r.n);
}
