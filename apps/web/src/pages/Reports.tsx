// דוחות (RPT-02..RPT-06, G-02): מכירות לפי ממד, רווחיות, מע"מ, רשימת מלאי לתאריך, חריגים
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DataTable, { type Column } from '../components/DataTable';
import Icon from '../components/Icon';
import { Badge, Card, EmptyState, Field, LoadError, Money, PageHeader, Skeleton, StatCard, StatGrid, Tabs } from '../components/ui';
import { api, qs } from '../lib/api';
import { DOC_TITLE, dateOnly, dateTime, money, PAY_LABEL, qty, todayIL } from '../lib/format';
import { printHtml } from '../lib/misc';
import { can, useSession } from '../lib/session';
import { showToast } from '../lib/toast';
import { useLoad } from '../lib/useLoad';
import { downloadCsv, RangeFields, shekels, toastError, useRange } from './admin/common';
import '../styles/admin.css';

const GROUPS = [
  { key: 'day', label: 'יום' }, { key: 'product', label: 'מוצר' }, { key: 'category', label: 'קטגוריה' }, { key: 'cashier', label: 'קופאי' },
  { key: 'payment', label: 'אמצעי תשלום' }, { key: 'hour', label: 'שעה' }, { key: 'branch', label: 'סניף' },
];

export default function Reports() {
  const [params, setParams] = useSearchParams();
  const tabs = [
    { key: 'sales', label: 'מכירות', icon: 'chart' },
    ...(can('reports:profit') ? [{ key: 'profit', label: 'רווחיות', icon: 'coins' }] : []),
    ...(can('tax:export') ? [{ key: 'vat', label: 'מע"מ', icon: 'percent' }] : []),
    ...(can('reports:profit') ? [{ key: 'inventory', label: 'רשימת מלאי', icon: 'box' }] : []),
    { key: 'exceptions', label: 'חריגים', icon: 'alert' },
  ];
  const tab = tabs.find((t) => t.key === params.get('tab'))?.key ?? 'sales';
  return (
    <div>
      <PageHeader sub="כל הסכומים ממסמכים ותנועות שנסגרו" />
      <Tabs items={tabs} value={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} label="סוג דוח" />
      {tab === 'sales' && <SalesReport />}
      {tab === 'profit' && <ProfitReport />}
      {tab === 'vat' && <VatReport />}
      {tab === 'inventory' && <InventoryList />}
      {tab === 'exceptions' && <Exceptions />}
    </div>
  );
}

function BranchSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const s = useSession();
  if (!s || s.branches.length < 2 || s.user.branchId) return null;
  return (
    <Field label="סניף">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">כל הסניפים</option>
        {s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </Field>
  );
}

function SalesReport() {
  const [range, setRange] = useRange();
  const [branchId, setBranchId] = useState('');
  const [groupBy, setGroupBy] = useState('day');
  const { data, error, loading, reload } = useLoad<any[]>(() => api.get('/reports/sales' + qs({ ...range, branchId, groupBy })), [range.from, range.to, branchId, groupBy]);
  const payment = groupBy === 'payment';
  const profit = can('reports:profit') && !payment;
  const sum = (k: string) => (data ?? []).reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const label = GROUPS.find((g) => g.key === groupBy)!.label;
  const lbl = (r: any) => (payment ? PAY_LABEL[r.label] ?? r.label : groupBy === 'day' ? dateOnly(r.label) : r.label ?? '—');

  const columns: Column<any>[] = [
    { key: 'label', label, primary: true, value: (r) => r.label, render: lbl },
    { key: 'count', label: payment ? 'תשלומים' : 'עסקאות', num: true, value: (r) => r.count, render: (r) => r.count },
    ...(!payment ? [
      { key: 'qty', label: 'כמות', num: true, hideOnCard: true, value: (r: any) => Number(r.qty_milli ?? 0), render: (r: any) => qty(Number(r.qty_milli ?? 0)) },
      { key: 'discount', label: 'הנחות', num: true, hideOnCard: true, value: (r: any) => Number(r.discount), render: (r: any) => <Money a={Number(r.discount)} /> },
      { key: 'net', label: 'לפני מע"מ', num: true, value: (r: any) => Number(r.net), render: (r: any) => <Money a={Number(r.net)} /> },
      { key: 'vat', label: 'מע"מ', num: true, hideOnCard: true, value: (r: any) => Number(r.vat), render: (r: any) => <Money a={Number(r.vat)} /> },
    ] : []),
    ...(profit ? [{ key: 'gp', label: 'רווח גולמי', num: true, hideOnCard: true, value: (r: any) => Number(r.gross_profit ?? 0), render: (r: any) => <Money a={Number(r.gross_profit ?? 0)} /> }] : []),
    { key: 'total', label: 'סה"כ', num: true, value: (r) => Number(r.total), render: (r) => <Money a={Number(r.total)} /> },
  ];

  const exportCsv = () => {
    const head = [label, payment ? 'תשלומים' : 'עסקאות', ...(!payment ? ['כמות', 'הנחות', 'לפני מע"מ', 'מע"מ'] : []), ...(profit ? ['רווח גולמי'] : []), 'סה"כ'];
    const rows = (data ?? []).map((r) => [lbl(r), r.count, ...(!payment ? [qty(Number(r.qty_milli ?? 0)), shekels(Number(r.discount)), shekels(Number(r.net)), shekels(Number(r.vat))] : []), ...(profit ? [shekels(Number(r.gross_profit ?? 0))] : []), shekels(Number(r.total))]);
    downloadCsv(`dlx-sales-${groupBy}-${range.from}-${range.to}.csv`, [head, ...rows]);
  };

  return (
    <div className="stack">
      <div className="range-bar">
        <RangeFields range={range} onChange={setRange} />
        <BranchSelect value={branchId} onChange={setBranchId} />
        <button className="action-btn secondary" onClick={exportCsv} disabled={!data?.length}><Icon name="download" size={18} />CSV</button>
      </div>
      <Tabs variant="seg" items={GROUPS} value={groupBy} onChange={setGroupBy} label="קיבוץ לפי" />
      {!data && loading ? <Skeleton /> : !data && error ? <LoadError error={error} what="הדוח" onRetry={reload} /> : (
        <>
          <StatGrid>
            <StatCard label="סה״כ" icon="coins" value={money(sum('total'))} />
            {!payment && <StatCard label="לפני מע״מ" value={money(sum('net'))} />}
            {!payment && <StatCard label="מע״מ" value={money(sum('vat'))} />}
            {profit && <StatCard label="רווח גולמי" tone="ok" value={money(sum('gross_profit'))} />}
          </StatGrid>
          <DataTable rows={data ?? []} rowKey={(r) => String(r.key)} columns={columns}
            empty={<EmptyState icon="chart" title="אין מכירות בתקופה" text="נסו טווח תאריכים אחר" />}
            footer={<tr><td>סה"כ</td><td className="num">{sum('count')}</td>{!payment && <><td className="num">{qty(sum('qty_milli'))}</td><td className="num">{money(sum('discount'))}</td><td className="num">{money(sum('net'))}</td><td className="num">{money(sum('vat'))}</td></>}{profit && <td className="num">{money(sum('gross_profit'))}</td>}<td className="num">{money(sum('total'))}</td></tr>} />
        </>
      )}
    </div>
  );
}

function ProfitReport() {
  const [range, setRange] = useRange();
  const [branchId, setBranchId] = useState('');
  const { data, error, loading, reload } = useLoad<any[]>(() => api.get('/reports/profit' + qs({ ...range, branchId })), [range.from, range.to, branchId]);
  const missing = (data ?? []).filter((r) => r.missing_cost).length;
  const totals = useMemo(() => (data ?? []).reduce((a, r) => ({ net: a.net + Number(r.net), cost: a.cost + Number(r.cost), gp: a.gp + Number(r.gross_profit) }), { net: 0, cost: 0, gp: 0 }), [data]);
  return (
    <div className="stack">
      <div className="range-bar"><RangeFields range={range} onChange={setRange} /><BranchSelect value={branchId} onChange={setBranchId} /></div>
      {missing > 0 && <div className="notice"><Icon name="alert" size={18} />ל-{missing} מוצרים אין עלות. הרווח שלהם מוצג כמלא — לא נכון. צריך לעדכן עלות או לקלוט סחורה.</div>}
      {!data && loading ? <Skeleton /> : !data && error ? <LoadError error={error} what="הרווחיות" onRetry={reload} /> : (
        <>
          <StatGrid>
            <StatCard label="מכירות לפני מע״מ" value={money(totals.net)} />
            <StatCard label="עלות" value={money(totals.cost)} />
            <StatCard label="רווח גולמי" tone="ok" value={money(totals.gp)} sub={totals.net ? `${((totals.gp / totals.net) * 100).toFixed(1)}%` : undefined} />
          </StatGrid>
          <DataTable rows={data ?? []} rowKey={(r) => r.product_id ?? r.name} initialSort={{ key: 'gp', dir: -1 }}
            empty={<EmptyState icon="coins" title="אין מכירות בתקופה" />}
            columns={[
              { key: 'name', label: 'מוצר', primary: true, value: (r) => r.name, render: (r) => <>{r.name}{r.missing_cost && <> <Badge tone="warn">אין עלות</Badge></>}</> },
              { key: 'qty', label: 'כמות', num: true, value: (r) => Number(r.qty_milli), render: (r) => qty(Number(r.qty_milli)) },
              { key: 'net', label: 'מכירות', num: true, value: (r) => Number(r.net), render: (r) => <Money a={Number(r.net)} /> },
              { key: 'cost', label: 'עלות', num: true, hideOnCard: true, value: (r) => Number(r.cost), render: (r) => <Money a={Number(r.cost)} /> },
              { key: 'margin', label: 'שיעור', num: true, hideOnCard: true, value: (r) => (Number(r.net) ? Number(r.gross_profit) / Number(r.net) : 0), render: (r) => (Number(r.net) ? `${((Number(r.gross_profit) / Number(r.net)) * 100).toFixed(1)}%` : '—') },
              { key: 'gp', label: 'רווח גולמי', num: true, value: (r) => Number(r.gross_profit), render: (r) => <Money a={Number(r.gross_profit)} /> },
            ]} />
        </>
      )}
    </div>
  );
}

function VatReport() {
  const [range, setRange] = useRange();
  const { data, error, loading, reload } = useLoad<any>(() => api.get('/reports/vat' + qs(range)), [range.from, range.to]);
  return (
    <div className="stack">
      <div className="range-bar"><RangeFields range={range} onChange={setRange} /></div>
      {!data && loading ? <Skeleton variant="counters" /> : !data && error ? <LoadError error={error} what="סיכום המע״מ" onRetry={reload} /> : data && (
        <>
          <StatGrid>
            <StatCard label="עסקאות לפני מע״מ" value={money(data.net_agorot)} />
            <StatCard label="מע״מ עסקאות" tone="teal" value={money(data.vat_agorot)} />
          </StatGrid>
          <DataTable rows={data.rows} rowKey={(r: any) => r.doc_type}
            empty={<EmptyState icon="percent" title="אין מסמכי מס בתקופה" />}
            columns={[
              { key: 'type', label: 'סוג מסמך', primary: true, render: (r: any) => DOC_TITLE[r.doc_type] ?? r.doc_type },
              { key: 'count', label: 'כמות', num: true, render: (r: any) => r.count },
              { key: 'net', label: 'לפני מע"מ', num: true, render: (r: any) => <Money a={(r.doc_type === 'credit_invoice' ? -1 : 1) * Number(r.net)} /> },
              { key: 'vat', label: 'מע"מ', num: true, render: (r: any) => <Money a={(r.doc_type === 'credit_invoice' ? -1 : 1) * Number(r.vat)} /> },
            ]} />
          <div className="notice info"><Icon name="alert" size={18} />{data.note}</div>
        </>
      )}
    </div>
  );
}

function InventoryList() {
  const [date, setDate] = useState(`${Number(todayIL().slice(0, 4)) - 1}-12-31`);
  const [branchId, setBranchId] = useState('');
  const s = useSession();
  const { data, error, loading, reload } = useLoad<any>(() => api.get('/reports/inventory-list' + qs({ date, branchId })), [date, branchId]);
  const LOC: Record<string, string> = { sale: 'למכירה', damaged: 'פגום', transit: 'בדרך' };
  const print = () => {
    if (!data) return;
    const esc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    const rows = data.rows.map((r: any) => `<tr><td>${esc(r.sku)}</td><td>${esc(r.name)}</td><td>${esc(r.branch_name)}</td><td>${LOC[r.location] ?? r.location}</td><td class="n">${qty(Number(r.qty_milli))}</td><td class="n">${money(r.cost_agorot)}</td><td class="n">${money(Number(r.value_agorot))}</td></tr>`).join('');
    printHtml(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>רשימת מלאי ${esc(date)}</title><style>
      body{font-family:Rubik,Heebo,Arial,sans-serif;margin:12mm;font-size:10pt} table{width:100%;border-collapse:collapse} th,td{border-bottom:1px solid #999;padding:3px 4px;text-align:start} .n{text-align:left;direction:ltr} h1{font-size:15pt;margin:0 0 4px}
    </style></head><body><h1>רשימת מלאי ליום ${esc(dateOnly(date))}</h1><div>${esc(s?.tenant.legal_name)} · ${esc(s?.tenant.tax_id)}</div>
    <table><thead><tr><th>מק"ט</th><th>פריט</th><th>סניף</th><th>מיקום</th><th class="n">כמות</th><th class="n">עלות ליחידה</th><th class="n">שווי</th></tr></thead><tbody>${rows}</tbody></table>
    <p><b>שווי מלאי למכירה: ${money(data.total_value_agorot)}</b></p><p>${esc(data.note)}</p><p>חתימת בעל העסק: ____________</p></body></html>`);
  };
  return (
    <div className="stack">
      <div className="range-bar">
        <Field label="נכון לתאריך"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <BranchSelect value={branchId} onChange={setBranchId} />
        <button className="action-btn secondary" onClick={print} disabled={!data?.rows.length}><Icon name="printer" size={18} />הדפסה</button>
      </div>
      {!data && loading ? <Skeleton /> : !data && error ? <LoadError error={error} what="רשימת המלאי" onRetry={reload} /> : data && (
        <>
          <StatGrid><StatCard label="שווי מלאי למכירה" icon="box" value={money(data.total_value_agorot)} sub={`${data.rows.length} שורות`} /></StatGrid>
          <div className="notice"><Icon name="alert" size={18} />{data.note}</div>
          <DataTable rows={data.rows} rowKey={(r: any) => `${r.sku}-${r.branch_name}-${r.location}`}
            empty={<EmptyState icon="box" title="אין מלאי לתאריך הזה" />}
            columns={[
              { key: 'name', label: 'פריט', primary: true, value: (r: any) => r.name, render: (r: any) => <>{r.name} <span className="muted small">{r.sku}</span></> },
              { key: 'branch', label: 'סניף', render: (r: any) => r.branch_name },
              { key: 'loc', label: 'מיקום', render: (r: any) => <Badge tone={r.location === 'damaged' ? 'warn' : undefined}>{LOC[r.location] ?? r.location}</Badge> },
              { key: 'qty', label: 'כמות', num: true, value: (r: any) => Number(r.qty_milli), render: (r: any) => qty(Number(r.qty_milli)) },
              { key: 'cost', label: 'עלות', num: true, hideOnCard: true, render: (r: any) => <Money a={r.cost_agorot} /> },
              { key: 'value', label: 'שווי', num: true, value: (r: any) => Number(r.value_agorot), render: (r: any) => <Money a={Number(r.value_agorot)} /> },
            ]} />
        </>
      )}
    </div>
  );
}

function Exceptions() {
  const nav = useNavigate();
  const { data, error, loading, reload } = useLoad<any>(() => api.get('/reports/exceptions'), []);
  const reconcile = async (id: string) => {
    try { const p = await api.post(`/payments/${id}/reconcile`); showToast(p.status === 'captured' ? 'התשלום אושר אצל הספק' : p.status === 'failed' ? 'התשלום לא חויב' : 'עדיין אין תשובה מהספק'); reload(); } catch (e) { toastError(e); }
  };
  if (!data && loading) return <Skeleton />;
  if (!data) return <LoadError error={error} what="החריגים" onRetry={reload} />;
  const total = Object.values(data).reduce((a: number, v: any) => a + v.length, 0);
  if (total === 0) return <EmptyState icon="check" title="אין חריגים" text="כל התשלומים, המכירות והמסמכים תקינים" />;
  const Section = ({ title, icon, rows, children }: { title: string; icon: string; rows: any[]; children: React.ReactNode }) =>
    rows.length ? <Card className="exc-section" title={<>{title} <Badge tone="danger">{rows.length}</Badge></>} icon={icon}>{children}</Card> : null;
  return (
    <div className="stack">
      <Section title="תשלומי אשראי שנתקעו" icon="card" rows={data.stuck_payments}>
        <DataTable rows={data.stuck_payments} rowKey={(r: any) => r.id} columns={[
          { key: 'at', label: 'זמן', primary: true, render: (r: any) => dateTime(r.created_at) },
          { key: 'st', label: 'מצב', render: (r: any) => <Badge tone="warn">{r.status === 'pending' ? 'אין תשובה מהספק' : 'נשלח'}</Badge> },
          { key: 'act', label: '', render: (r: any) => <button className="action-btn small secondary" onClick={() => reconcile(r.id)}>בדיקת סטטוס</button> },
          { key: 'amt', label: 'סכום', num: true, render: (r: any) => <Money a={r.amount_agorot} /> },
        ]} />
      </Section>
      <Section title="מכירות שלא נסגרו" icon="cart" rows={data.open_sales}>
        <DataTable rows={data.open_sales} rowKey={(r: any) => r.id} columns={[
          { key: 'at', label: 'זמן', primary: true, render: (r: any) => dateTime(r.created_at) },
          { key: 'reg', label: 'קופה', render: (r: any) => r.register_name },
          { key: 'amt', label: 'סכום', num: true, render: (r: any) => <Money a={r.total_agorot} /> },
        ]} />
        <p className="muted small">צריך להשלים או לבטל בקופה — אחרת אי אפשר לסגור את המשמרת.</p>
      </Section>
      <Section title="מסמכים בלי מספר הקצאה" icon="receipt" rows={data.allocation_failed}>
        <DataTable rows={data.allocation_failed} rowKey={(r: any) => r.id} onRowClick={(r: any) => nav(`/documents/${r.id}`)} columns={[
          { key: 'doc', label: 'מסמך', primary: true, render: (r: any) => `${DOC_TITLE[r.doc_type] ?? r.doc_type} ${r.serial}` },
          { key: 'at', label: 'הופק', render: (r: any) => dateTime(r.issued_at) },
          { key: 'amt', label: 'סכום', num: true, render: (r: any) => <Money a={r.total_agorot} /> },
        ]} />
        <p className="muted small">הלקוח העסקי לא יוכל לקזז מע"מ בלי מספר הקצאה (חשבוניות ישראל).</p>
      </Section>
      <Section title="פערי קופה (30 יום)" icon="wallet" rows={data.cash_variance}>
        <DataTable rows={data.cash_variance} rowKey={(r: any) => r.id} columns={[
          { key: 'z', label: 'משמרת', primary: true, render: (r: any) => `Z ${r.number} · ${r.register_name}` },
          { key: 'at', label: 'נסגרה', render: (r: any) => dateTime(r.closed_at) },
          { key: 'why', label: 'הסבר', render: (r: any) => r.variance_reason || '—' },
          { key: 'amt', label: 'פער', num: true, render: (r: any) => <Money a={Number(r.variance_agorot)} /> },
        ]} />
      </Section>
      <Section title="מלאי שלילי" icon="box" rows={data.negative_stock}>
        <DataTable rows={data.negative_stock} rowKey={(r: any) => `${r.id}-${r.branch_name}`} columns={[
          { key: 'name', label: 'מוצר', primary: true, render: (r: any) => r.name },
          { key: 'br', label: 'סניף', render: (r: any) => r.branch_name },
          { key: 'q', label: 'יתרה', num: true, render: (r: any) => qty(Number(r.on_hand)) },
        ]} />
      </Section>
      <Section title="פתיחת מגירה בלי מכירה (7 ימים)" icon="alert" rows={data.no_sale_opens}>
        <DataTable rows={data.no_sale_opens} rowKey={(r: any) => String(r.id)} columns={[
          { key: 'at', label: 'זמן', primary: true, render: (r: any) => dateTime(r.created_at) },
          { key: 'who', label: 'עובד', render: (r: any) => r.actor_name ?? '—' },
          { key: 'why', label: 'סיבה', render: (r: any) => r.reason || '—' },
        ]} />
      </Section>
    </div>
  );
}
