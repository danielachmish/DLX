// כרטיס לקוח (CRM-02..CRM-05): יתרה, תנועות, מסמכים, הסכמות לדיוור ותשלום על חשבון
import { parseShekels } from '@dlx/core';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import DataTable from '../components/DataTable';
import Icon from '../components/Icon';
import { Card, EmptyState, Field, LoadError, Modal, Money, PageHeader, Skeleton, StatCard, StatGrid, Switch } from '../components/ui';
import { api } from '../lib/api';
import { DOC_TITLE, dateTime, PAY_LABEL } from '../lib/format';
import { can } from '../lib/session';
import { showToast } from '../lib/toast';
import { useLoad } from '../lib/useLoad';
import CustomerForm from './admin/CustomerForm';
import { apiErrors, toastError } from './admin/common';
import '../styles/admin.css';

const SOURCE: Record<string, string> = { sale: 'מכירה בהקפה', payment: 'תשלום', return: 'החזרה', invoice: 'חשבונית' };
const CONSENTS = [
  { kind: 'marketing_sms', label: 'דיוור ב-SMS / וואטסאפ' },
  { kind: 'marketing_email', label: 'דיוור באימייל' },
];

export default function CustomerView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: c, error, loading, reload } = useLoad<any>(() => api.get(`/customers/${id}`), [id]);
  const [edit, setEdit] = useState(false);
  const [pay, setPay] = useState(false);

  if (!c && loading) return <><PageHeader title="לקוח" back /><Skeleton variant="card" /></>;
  if (!c) return <><PageHeader title="לקוח" back /><LoadError error={error} what="הלקוח" onRetry={reload} /></>;

  const consent = (kind: string) => c.consents.find((x: any) => x.kind === kind);
  const setConsent = async (kind: string, granted: boolean) => {
    try { await api.post(`/customers/${id}/consents`, { kind, granted, source: 'office' }); showToast(granted ? 'ההסכמה נרשמה' : 'הוסר מהדיוור'); reload(); } catch (e) { toastError(e); }
  };

  return (
    <div className="stack">
      <PageHeader title={c.name} sub={c.kind === 'business' ? `לקוח עסקי${c.tax_id ? ` · ${c.tax_id}` : ''}` : 'לקוח פרטי'} onBack={() => nav('/customers')}
        actions={<>
          {can('customers:write') && <button className="action-btn secondary inline" onClick={() => setEdit(true)}><Icon name="edit" size={18} />עריכה</button>}
          {c.balance_agorot > 0 && can('pos:sell') && <button className="action-btn inline" onClick={() => setPay(true)}><Icon name="coins" size={18} />תשלום על חשבון</button>}
        </>} />
      <StatGrid>
        <StatCard label="יתרת חוב" icon="coins" value={<Money a={c.balance_agorot} />} tone={c.balance_agorot > 0 ? 'danger' : 'ok'} />
        <StatCard label="מסגרת אשראי" icon="card" value={c.credit_limit_agorot ? <Money a={c.credit_limit_agorot} /> : 'בלי הקפה'} />
        <StatCard label="מסמכים" icon="receipt" value={c.documents.length} />
      </StatGrid>

      <div className="split">
        <Card title="פרטים" icon="user">
          <dl className="kv">
            <dt>טלפון</dt><dd dir="ltr">{c.phone || '—'}</dd>
            <dt>אימייל</dt><dd dir="ltr">{c.email || '—'}</dd>
            <dt>כתובת</dt><dd>{c.address || '—'}</dd>
            <dt>מספר מזהה</dt><dd>{c.tax_id || '—'}</dd>
            {c.notes && <><dt>הערות</dt><dd>{c.notes}</dd></>}
          </dl>
        </Card>
        <Card title="הסכמה לדיוור" icon="bell">
          {CONSENTS.map((k) => {
            const cur = consent(k.kind);
            return (
              <div className="consent-row" key={k.kind}>
                <div>{k.label}<small>{cur ? `${cur.granted ? 'הסכים' : 'לא מסכים'} · ${dateTime(cur.created_at)} · נוסח ${cur.text_version}` : 'לא נשאל — אסור לשלוח פרסומת'}</small></div>
                <Switch label={k.label} on={!!cur?.granted} onChange={(v) => setConsent(k.kind, v)} />
              </div>
            );
          })}
          <p className="muted small mt">לפי חוק התקשורת (חוק הספאם): פרסומת רק למי שהסכים, עם הכיתוב "פרסומת" ודרך הסרה בכל הודעה. בקשת הסרה מכבדים מיד.</p>
        </Card>
      </div>

      <Card title="תנועות בחשבון" icon="history">
        <DataTable rows={c.ledger} rowKey={(r: any) => String(r.id)}
          empty={<EmptyState compact icon="history" title="אין תנועות" text="מכירה בהקפה, חשבונית ותשלום על חשבון יופיעו כאן" />}
          columns={[
            { key: 'date', label: 'תאריך', primary: true, render: (r: any) => dateTime(r.created_at) },
            { key: 'src', label: 'פעולה', render: (r: any) => SOURCE[r.source_type] ?? r.source_type },
            { key: 'doc', label: 'מסמך', render: (r: any) => (r.document_id ? <Link to={`/documents/${r.document_id}`}>פתיחה</Link> : '—') },
            { key: 'amt', label: 'סכום', num: true, render: (r: any) => <span className={'ledger-amt ' + (r.amount_agorot > 0 ? 'debt' : 'credit')}><Money a={r.amount_agorot} /></span> },
          ]} />
      </Card>

      <Card title="מסמכים" icon="receipt">
        <DataTable rows={c.documents} rowKey={(r: any) => r.id} onRowClick={(r: any) => nav(`/documents/${r.id}`)}
          empty={<EmptyState compact icon="receipt" title="אין מסמכים ללקוח" />}
          columns={[
            { key: 'type', label: 'מסמך', primary: true, render: (r: any) => `${DOC_TITLE[r.doc_type] ?? r.doc_type} ${r.serial}` },
            { key: 'date', label: 'תאריך', render: (r: any) => dateTime(r.issued_at) },
            { key: 'total', label: 'סכום', num: true, render: (r: any) => <Money a={r.total_agorot} /> },
          ]} />
      </Card>

      {edit && <CustomerForm initial={c} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); showToast('נשמר'); reload(); }} />}
      {pay && <PayOnAccount customer={c} onClose={() => setPay(false)} onDone={() => { setPay(false); reload(); }} />}
    </div>
  );
}

function PayOnAccount({ customer, onClose, onDone }: { customer: any; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState((customer.balance_agorot / 100).toFixed(2));
  const [approval, setApproval] = useState('');
  const [last4, setLast4] = useState('');
  const [check, setCheck] = useState({ number: '', bank: '', date: '' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const a = parseShekels(amount);
    if (!a || a <= 0) { setMsg('סכום לא תקין'); return; }
    if (a > customer.balance_agorot) { setMsg('הסכום גדול מיתרת החוב'); return; }
    if (method === 'card' && !approval) { setMsg('צריך מספר אישור מהמסוף'); return; }
    setBusy(true); setMsg('');
    try {
      setResult(await api.post(`/customers/${customer.id}/payments`, {
        method, amountAgorot: a, approvalCode: approval || null, last4: last4 || null,
        checkNumber: check.number || null, checkBank: check.bank || null, checkDate: check.date || null,
      }, { key: true }));
    } catch (x) { setMsg(apiErrors(x).msg); } finally { setBusy(false); }
  };

  if (result) {
    return (
      <Modal title="התשלום נקלט" onClose={onDone}>
        <EmptyState icon="check" title={`קבלה מס' ${result.document.serial}`} text={`יתרה חדשה: ${(result.balance_agorot / 100).toFixed(2)} ₪`} />
        <div className="form-actions">
          <Link className="action-btn inline" to={`/documents/${result.document.id}`}>לקבלה</Link>
          <button className="action-btn ghost" onClick={onDone}>סגירה</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="תשלום על חשבון" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <p className="muted small flush">יתרת חוב: <Money a={customer.balance_agorot} />. התשלום מפיק קבלה ומקטין את היתרה.</p>
        <div className="chips" role="group" aria-label="אמצעי תשלום">
          {['cash', 'card', 'check', 'transfer', 'bit'].map((m) => <button type="button" key={m} className={'chip-f' + (method === m ? ' on' : '')} aria-pressed={method === m} onClick={() => setMethod(m)}>{PAY_LABEL[m]}</button>)}
        </div>
        <Field label="סכום (₪)"><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" /></Field>
        {method === 'card' && <div className="form-grid">
          <Field label="מספר אישור" hint="מהמסוף"><input value={approval} onChange={(e) => setApproval(e.target.value)} dir="ltr" /></Field>
          <Field label="4 ספרות אחרונות"><input value={last4} maxLength={4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ''))} inputMode="numeric" dir="ltr" /></Field>
        </div>}
        {method === 'check' && <div className="form-grid">
          <Field label="מספר שיק"><input value={check.number} onChange={(e) => setCheck({ ...check, number: e.target.value })} inputMode="numeric" dir="ltr" /></Field>
          <Field label="בנק / סניף"><input value={check.bank} onChange={(e) => setCheck({ ...check, bank: e.target.value })} dir="ltr" /></Field>
          <Field label="תאריך פירעון"><input type="date" value={check.date} onChange={(e) => setCheck({ ...check, date: e.target.value })} /></Field>
        </div>}
        {msg && <div className="dlg-err" role="alert">{msg}</div>}
        <div className="form-actions">
          <button className="action-btn" disabled={busy}>{busy ? 'שומר…' : 'קליטת תשלום'}</button>
          <button type="button" className="action-btn ghost" onClick={onClose}>ביטול</button>
        </div>
      </form>
    </Modal>
  );
}
