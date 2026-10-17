// מסמכים ומכירות (ACC-07, S06): איתור לפי סוג, תאריך, מספר, לקוח; ורשימת מכירות עם מצב (כולל ממתינות ומבוטלות)
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DataTable from '../components/DataTable';
import { Badge, EmptyState, Field, LoadError, Money, PageHeader, Skeleton, Tabs } from '../components/ui';
import { api, qs } from '../lib/api';
import { askChoice, askText } from '../lib/dialogs';
import { DOC_TITLE, dateTime, daysAgoIL, todayIL } from '../lib/format';
import { useSavedState } from '../lib/misc';
import { showError, showToast } from '../lib/toast';
import { useLoad } from '../lib/useLoad';

const CREDIT = ['credit_invoice', 'return_note'];
const SALE_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' }> = {
  finalized: { label: 'נסגרה', tone: 'ok' }, payment_pending: { label: 'ממתינה לתשלום', tone: 'warn' },
  exception: { label: 'חריגה', tone: 'danger' }, cancelled: { label: 'בוטלה', tone: 'info' }, draft: { label: 'טיוטה', tone: 'info' },
};

export default function Documents() {
  const [tab, setTab] = useSavedState('docsTab', 'docs');
  return (
    <div>
      <PageHeader sub="כל מסמך שהופק נשמר כמו שהוא — תיקון רק במסמך מקושר" />
      <Tabs variant="seg" value={tab} onChange={setTab} items={[{ key: 'docs', label: 'מסמכים' }, { key: 'sales', label: 'מכירות' }]} />
      {tab === 'docs' ? <DocList /> : <SalesList />}
    </div>
  );
}

function DocList() {
  const nav = useNavigate();
  const [f, setF] = useSavedState('docsFilter', { type: '', from: daysAgoIL(30), to: todayIL(), q: '', serial: '' });
  const list = useLoad(() => api.get(`/documents${qs({ type: f.type, from: f.from, to: f.to, q: f.q, serial: f.serial, limit: 300 })}`), [f.type, f.from, f.to, f.q, f.serial]);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const sign = (r: any) => (CREDIT.includes(r.doc_type) ? -1 : 1);
  return (
    <div className="stack">
      <div className="form-grid">
        <Field label="סוג">
          <select value={f.type} onChange={set('type')}><option value="">הכל</option>{Object.entries(DOC_TITLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        <Field label="מתאריך"><input type="date" value={f.from} onChange={set('from')} /></Field>
        <Field label="עד תאריך"><input type="date" value={f.to} onChange={set('to')} /></Field>
        <Field label="מספר מסמך"><input value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value.replace(/\D/g, '') })} inputMode="numeric" dir="ltr" /></Field>
        <Field label="לקוח / ע.מ."><input value={f.q} onChange={set('q')} /></Field>
      </div>
      {list.data === undefined && list.loading && <Skeleton />}
      {list.data === undefined && list.error && <LoadError error={list.error} what="המסמכים" onRetry={list.reload} />}
      {list.data && (
        <DataTable rows={list.data} rowKey={(r: any) => r.id} onRowClick={(r: any) => nav(`/documents/${r.id}`)}
          empty={<EmptyState icon="receipt" title="אין מסמכים בטווח הזה" />}
          footer={list.data.length > 0 ? <tr><td colSpan={5}>סה"כ ({list.data.length})</td><td className="num"><Money a={list.data.reduce((a: number, r: any) => a + sign(r) * r.total_agorot, 0)} /></td><td /></tr> : undefined}
          columns={[
            { key: 'title', label: 'מסמך', primary: true, render: (r: any) => `${DOC_TITLE[r.doc_type] ?? r.doc_type} ${r.serial}`, value: (r: any) => r.serial },
            { key: 'date', label: 'תאריך', render: (r: any) => dateTime(r.issued_at), value: (r: any) => r.issued_at },
            { key: 'customer', label: 'לקוח', render: (r: any) => r.customer_name ?? '—', muted: true },
            { key: 'branch', label: 'סניף', render: (r: any) => r.branch_name ?? '—', muted: true, hideOnCard: true },
            { key: 'flags', label: 'סטטוס', render: (r: any) => (
              <span className="row-gap">
                {CREDIT.includes(r.doc_type) && <Badge tone="credit">זיכוי</Badge>}
                {r.allocation_number && <Badge tone="ok">הקצאה</Badge>}
                {r.allocation_status === 'failed' && <Badge tone="danger">בלי הקצאה</Badge>}
                {r.print_count === 0 && <Badge>לא הודפס</Badge>}
              </span>) },
            { key: 'total', label: 'סכום', num: true, render: (r: any) => <Money a={sign(r) * r.total_agorot} />, value: (r: any) => sign(r) * r.total_agorot },
            { key: 'vat', label: 'מע"מ', num: true, hideOnCard: true, render: (r: any) => <Money a={sign(r) * r.vat_agorot} /> },
          ]} />
      )}
    </div>
  );
}

function SalesList() {
  const nav = useNavigate();
  const [f, setF] = useSavedState('salesFilter', { from: daysAgoIL(7), to: todayIL(), status: '', q: '' });
  const toTs = (d: string) => new Date(`${d}T00:00:00+03:00`).toISOString();
  const nextDay = (d: string) => new Date(new Date(`${d}T00:00:00+03:00`).getTime() + 86400000).toISOString();
  const list = useLoad(() => api.get(`/sales${qs({ from: f.from ? toTs(f.from) : '', to: f.to ? nextDay(f.to) : '', status: f.status, q: f.q, limit: 300 })}`), [f.from, f.to, f.status, f.q]);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });

  const open = async (r: any) => {
    if (r.status === 'payment_pending' || r.status === 'exception') {
      const c = await askChoice({ title: 'מכירה שלא הושלמה', text: 'המכירה נפתחה לתשלום ולא נסגרה. אפשר להמשיך אותה מהקופה שבה נפתחה, או לבטל.', options: [{ value: 'cancel', label: 'ביטול המכירה', danger: true }] });
      if (c !== 'cancel') return;
      const reason = await askText({ title: 'סיבת ביטול', label: 'סיבה' });
      if (!reason) return;
      try { await api.post(`/sales/${r.id}/cancel`, { reason }); showToast('המכירה בוטלה'); list.reload(); } catch (e) { showError(e); }
      return;
    }
    try {
      const s = await api.get(`/sales/${r.id}`);
      if (s.document_id) nav(`/documents/${s.document_id}`);
    } catch (e) { showError(e); }
  };

  return (
    <div className="stack">
      <div className="form-grid">
        <Field label="מתאריך"><input type="date" value={f.from} onChange={set('from')} /></Field>
        <Field label="עד תאריך"><input type="date" value={f.to} onChange={set('to')} /></Field>
        <Field label="מצב">
          <select value={f.status} onChange={set('status')}><option value="">הכל</option>{Object.entries(SALE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        </Field>
        <Field label="מספר קבלה / לקוח"><input value={f.q} onChange={set('q')} /></Field>
      </div>
      {list.data === undefined && list.loading && <Skeleton />}
      {list.data === undefined && list.error && <LoadError error={list.error} what="המכירות" onRetry={list.reload} />}
      {list.data && (
        <DataTable rows={list.data} rowKey={(r: any) => r.id} onRowClick={open} empty={<EmptyState icon="cart" title="אין מכירות בטווח הזה" />}
          columns={[
            { key: 'when', label: 'זמן', primary: true, render: (r: any) => dateTime(r.finalized_at ?? r.created_at), value: (r: any) => r.created_at },
            { key: 'doc', label: 'מסמך', render: (r: any) => (r.document_serial ? `${DOC_TITLE[r.document_type] ?? ''} ${r.document_serial}` : '—') },
            { key: 'status', label: 'מצב', render: (r: any) => <Badge tone={SALE_STATUS[r.status]?.tone}>{SALE_STATUS[r.status]?.label ?? r.status}</Badge> },
            { key: 'cashier', label: 'קופאי', render: (r: any) => r.cashier_name ?? '—', muted: true },
            { key: 'register', label: 'קופה', render: (r: any) => r.register_name, muted: true, hideOnCard: true },
            { key: 'customer', label: 'לקוח', render: (r: any) => r.customer_name ?? '—', muted: true, hideOnCard: true },
            { key: 'total', label: 'סכום', num: true, render: (r: any) => <Money a={r.total_agorot} />, value: (r: any) => r.total_agorot },
          ]} />
      )}
    </div>
  );
}
