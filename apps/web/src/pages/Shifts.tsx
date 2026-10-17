// משמרות וקופה (CSH-01..CSH-05, WF-04): דוח X של המשמרת הנוכחית, תנועות מגירה, סגירה עם ספירה ודוח Z, היסטוריה
import { parseShekels } from '@dlx/core';
import { useState } from 'react';
import DataTable from '../components/DataTable';
import Icon from '../components/Icon';
import NumPad from '../components/NumPad';
import { Badge, Card, EmptyState, Field, LoadError, Modal, Money, PageHeader, Skeleton, Tabs } from '../components/ui';
import { api, ApiError, qs } from '../lib/api';
import { askConfirm } from '../lib/dialogs';
import { DOC_TITLE, dateTime, money, PAY_LABEL } from '../lib/format';
import { cls, printHtml, useSavedState } from '../lib/misc';
import { can, currentRegister, useSession } from '../lib/session';
import { showError, showToast } from '../lib/toast';
import { useLoad } from '../lib/useLoad';
import '../styles/pos.css';

const EVENT_LABEL: Record<string, string> = { paid_in: 'הכנסה לקופה', drop: 'משיכה לכספת', expense: 'הוצאה מהקופה', no_sale: 'פתיחת מגירה', bank_deposit: 'הפקדה לבנק' };
const MANAGER_EVENTS = ['drop', 'expense', 'bank_deposit'];

export default function Shifts() {
  const session = useSession()!;
  const reg = currentRegister(session);
  const [tab, setTab] = useSavedState('shiftsTab', 'current');
  const [view, setView] = useState<string | null>(null);
  return (
    <div>
      <PageHeader sub={reg ? `${reg.name} · דוח X, תנועות מגירה וסגירת יום` : undefined} />
      <Tabs variant="seg" value={tab} onChange={setTab} items={[{ key: 'current', label: 'המשמרת הנוכחית' }, { key: 'history', label: 'היסטוריה' }]} />
      {tab === 'current' ? (reg ? <Current registerId={reg.id} /> : <EmptyState icon="store" title="אין קופה מוגדרת" />) : <History registerId={reg?.id} onOpen={setView} />}
      {view && <ReportModal id={view} onClose={() => setView(null)} />}
    </div>
  );
}

function Current({ registerId }: { registerId: string }) {
  const cur = useLoad(() => api.get(`/cash-sessions/current${qs({ registerId })}`), [registerId]);
  const [closing, setClosing] = useState(false);
  const [z, setZ] = useState<any>(null);
  if (z) return <Report rep={z} closed onPrint={() => printHtml(zHtml(z))} />;
  if (cur.data === undefined && cur.loading) return <Skeleton variant="counters" rows={4} />;
  if (cur.data === undefined && cur.error) return <LoadError error={cur.error} what="המשמרת" onRetry={cur.reload} />;
  if (!cur.data) return <EmptyState icon="wallet" title="אין משמרת פתוחה" text="פותחים משמרת ממסך הקופה" />;
  const rep = cur.data;
  return (
    <div className="stack">
      <Report rep={rep} onPrint={() => printHtml(zHtml(rep, true))} />
      <EventForm sessionId={rep.session.id} onDone={cur.reload} />
      {rep.session.status === 'active' && (
        <div className="form-actions">
          <button type="button" className="action-btn warn" onClick={() => setClosing(true)}><Icon name="lock" size={18} />סגירת משמרת (Z)</button>
        </div>
      )}
      {closing && <CloseModal rep={rep} onClose={() => setClosing(false)} onClosed={(r) => { setClosing(false); setZ(r); }} />}
    </div>
  );
}

function Report({ rep, closed = false, onPrint }: { rep: any; closed?: boolean; onPrint: () => void }) {
  const s = rep.session;
  const net = (m: string) => rep.payments.filter((p: any) => p.method === m).reduce((a: number, p: any) => a + (p.direction === 'in' ? p.amount : -p.amount), 0);
  const methods = [...new Set(rep.payments.map((p: any) => p.method))] as string[];
  return (
    <div className="stack">
      <div className="page-head">
        <div className="page-head-sub">
          {closed || s.status === 'closed' ? <Badge tone="info">דוח Z מס' {s.number}</Badge> : <Badge tone="ok">משמרת {s.number} פתוחה</Badge>}
          {' '}{s.register_name} · נפתחה {dateTime(s.opened_at)}{s.opened_by_name ? ` ע"י ${s.opened_by_name}` : ''}{s.closed_at ? ` · נסגרה ${dateTime(s.closed_at)}` : ''}
        </div>
        <div className="page-head-actions"><button type="button" className="action-btn secondary inline" onClick={onPrint}><Icon name="printer" size={18} />{closed || s.status === 'closed' ? 'הדפסת Z' : 'הדפסת X'}</button></div>
      </div>
      <div className="stat-grid">
        <div className="stat-card"><span className="stat-label">מכירות</span><b className="stat-value">{money(rep.sales.total)}</b><span className="stat-sub">{rep.sales.count} עסקאות</span></div>
        <div className="stat-card"><span className="stat-label">החזרות</span><b className="stat-value">{money(rep.returns.total)}</b><span className="stat-sub">{rep.returns.count}</span></div>
        <div className="stat-card teal"><span className="stat-label">נטו</span><b className="stat-value">{money(rep.net_total_agorot)}</b></div>
        <div className="stat-card"><span className="stat-label">מזומן צפוי במגירה</span><b className="stat-value">{money(rep.expected_cash_agorot)}</b><span className="stat-sub">קופה קטנה {money(s.opening_float_agorot)}</span></div>
      </div>
      {rep.pending_sales > 0 && <div className="notice"><Icon name="alert" size={18} />יש {rep.pending_sales} מכירות שלא הושלמו. צריך להשלים או לבטל אותן לפני סגירה.</div>}
      {(closed || s.status === 'closed') && s.counted_cash_agorot != null && (
        <div className={cls('variance', s.variance_agorot === 0 ? 'ok' : 'bad')}>פער בקופה<b className="money">{money(s.variance_agorot)}</b>{s.variance_reason && <span>{s.variance_reason}</span>}</div>
      )}
      <div className="z-grid">
        <Card title="לפי אמצעי תשלום" icon="card">
          <ul className="list-plain">
            {methods.length === 0 && <li className="muted">אין תשלומים</li>}
            {methods.map((m) => <li key={m}><span>{PAY_LABEL[m] ?? m}</span><Money a={net(m)} /></li>)}
          </ul>
        </Card>
        <Card title="פירוט מכירות" icon="receipt">
          <ul className="list-plain">
            <li><span>ברוטו</span><Money a={rep.sales.gross} /></li>
            <li><span>הנחות</span><Money a={-rep.sales.discount} /></li>
            <li><span>לפני מע"מ</span><Money a={rep.sales.net} /></li>
            <li><span>מע"מ</span><Money a={rep.sales.vat} /></li>
            <li><span>עיגול אגורות</span><Money a={rep.sales.rounding} /></li>
          </ul>
        </Card>
        <Card title="תנועות מגירה" icon="wallet">
          <ul className="list-plain">
            {rep.events.length === 0 && <li className="muted">אין תנועות</li>}
            {rep.events.map((e: any) => <li key={e.kind}><span>{EVENT_LABEL[e.kind] ?? e.kind} ({e.count})</span>{e.kind !== 'no_sale' ? <Money a={e.amount} /> : <span />}</li>)}
          </ul>
        </Card>
        <Card title="מסמכים שהופקו" icon="file">
          <ul className="list-plain">
            {rep.documents.length === 0 && <li className="muted">אין מסמכים</li>}
            {rep.documents.map((d: any) => <li key={d.doc_type}><span>{DOC_TITLE[d.doc_type] ?? d.doc_type} ({d.count})</span><span className="nowrap">{d.first}–{d.last}</span></li>)}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function EventForm({ sessionId, onDone }: { sessionId: string; onDone: () => void }) {
  const kinds = Object.keys(EVENT_LABEL).filter((k) => !MANAGER_EVENTS.includes(k) || can('cash:manage'));
  const [kind, setKind] = useState(kinds[0]!);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const a = parseShekels(amount || '0') ?? 0;
    if (kind !== 'no_sale' && a <= 0) return showError(new Error('צריך סכום'));
    if (reason.trim().length < 2) return showError(new Error('צריך סיבה'));
    setBusy(true);
    try {
      await api.post(`/cash-sessions/${sessionId}/events`, { kind, amountAgorot: kind === 'no_sale' ? 0 : a, reason: reason.trim() });
      showToast(`${EVENT_LABEL[kind]} נרשמה`);
      setAmount(''); setReason(''); onDone();
    } catch (e) { showError(e); } finally { setBusy(false); }
  };
  return (
    <Card title="תנועת מגירה" icon="wallet">
      <div className="chips mb">{kinds.map((k) => <button key={k} type="button" className={cls('chip-f', kind === k && 'on')} onClick={() => setKind(k)}>{EVENT_LABEL[k]}</button>)}</div>
      <div className="form-grid">
        {kind !== 'no_sale' && <Field label="סכום (₪)"><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" /></Field>}
        <Field label="סיבה" hint="נרשמת ביומן הביקורת"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
      <div className="form-actions"><button type="button" className="action-btn" disabled={busy} onClick={submit}>רישום</button></div>
    </Card>
  );
}

function CloseModal({ rep, onClose, onClosed }: { rep: any; onClose: () => void; onClosed: (z: any) => void }) {
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const c = parseShekels(counted || '0') ?? 0;
  const variance = counted ? c - rep.expected_cash_agorot : 0;
  const submit = async () => {
    if (!counted) { setMsg('צריך לספור את המזומן במגירה'); return; }
    if (!(await askConfirm({ title: 'לסגור את המשמרת?', text: `נספר ${money(c)}, צפוי ${money(rep.expected_cash_agorot)}. אחרי הסגירה לא ניתן למכור במשמרת הזו.`, confirmLabel: 'סגירה והפקת Z' }))) return;
    setBusy(true); setMsg('');
    try {
      onClosed(await api.post(`/cash-sessions/${rep.session.id}/close`, { countedCashAgorot: c, varianceReason: reason.trim() || null }));
      showToast('המשמרת נסגרה');
    } catch (e) {
      setMsg(e instanceof ApiError && e.status === 403 ? `${e.message}. מנהל צריך לסגור את המשמרת מהחשבון שלו.` : e instanceof Error ? e.message : 'שגיאה');
    } finally { setBusy(false); }
  };
  return (
    <Modal title="סגירת משמרת" onClose={onClose} size="wide">
      <p className="section-sub">ספרו את כל המזומן שבמגירה (כולל הקופה הקטנה) והקלידו את הסכום.</p>
      <NumPad value={counted} onChange={setCounted} />
      {counted && <div className={cls('variance', Math.abs(variance) <= 2000 ? 'ok' : 'bad', 'mt')}>{variance === 0 ? 'הקופה מאוזנת' : variance > 0 ? 'עודף בקופה' : 'חוסר בקופה'}<b className="money">{money(variance)}</b></div>}
      {Math.abs(variance) > 2000 && <Field label="הסבר לפער (חובה מעל ₪20)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      {msg && <div className="notice danger mt" role="alert"><Icon name="alert" size={18} />{msg}</div>}
      <button type="button" className="action-btn warn" disabled={busy} onClick={submit}>{busy ? 'סוגר…' : 'סגירה והפקת Z'}</button>
    </Modal>
  );
}

function History({ registerId, onOpen }: { registerId?: string; onOpen: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const list = useLoad(() => api.get(`/cash-sessions${qs({ registerId: all ? undefined : registerId })}`), [all, registerId]);
  return (
    <div className="stack">
      <div className="toolbar"><label className="check-row"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />כל הקופות</label></div>
      {list.data === undefined && list.loading && <Skeleton />}
      {list.data === undefined && list.error && <LoadError error={list.error} what="המשמרות" onRetry={list.reload} />}
      {list.data && (
        <DataTable rows={list.data} rowKey={(r: any) => r.id} onRowClick={(r: any) => onOpen(r.id)}
          empty={<EmptyState icon="wallet" title="אין משמרות עדיין" />}
          columns={[
            { key: 'number', label: 'Z', primary: true, render: (r: any) => `Z ${r.number}`, value: (r: any) => r.number },
            { key: 'register', label: 'קופה', render: (r: any) => r.register_name },
            { key: 'opened', label: 'נפתחה', render: (r: any) => dateTime(r.opened_at), value: (r: any) => r.opened_at },
            { key: 'closed', label: 'נסגרה', render: (r: any) => (r.closed_at ? dateTime(r.closed_at) : <Badge tone="ok">פתוחה</Badge>) },
            { key: 'variance', label: 'פער', num: true, render: (r: any) => (r.variance_agorot == null ? '—' : <Money a={r.variance_agorot} />) },
            { key: 'total', label: 'מכירות', num: true, render: (r: any) => <Money a={r.sales_total} />, value: (r: any) => r.sales_total },
          ]} />
      )}
    </div>
  );
}

function ReportModal({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useLoad(() => api.get(`/cash-sessions/${id}`), [id]);
  return (
    <Modal title="דוח משמרת" onClose={onClose} size="xwide">
      {r.data ? <Report rep={r.data} onPrint={() => printHtml(zHtml(r.data, r.data.session.status !== 'closed'))} /> : r.error ? <LoadError error={r.error} what="הדוח" onRetry={r.reload} /> : <Skeleton variant="card" />}
    </Modal>
  );
}

// דוח X / Z להדפסה במדפסת קבלות 80mm
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function zHtml(rep: any, x = false) {
  const s = rep.session;
  const row = (a: string, b: string) => `<tr><td>${esc(a)}</td><td class="n">${esc(b)}</td></tr>`;
  const pays = rep.payments.map((p: any) => row(`${PAY_LABEL[p.method] ?? p.method}${p.direction === 'out' ? ' (החזר)' : ''}`, money(p.direction === 'out' ? -p.amount : p.amount))).join('');
  const ev = rep.events.map((e: any) => row(`${EVENT_LABEL[e.kind] ?? e.kind} (${e.count})`, money(e.amount))).join('');
  const docs = rep.documents.map((d: any) => row(`${DOC_TITLE[d.doc_type] ?? d.doc_type}`, `${d.first}–${d.last}`)).join('');
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${x ? 'X' : 'Z'} ${s.number}</title><style>
  @page { size: 80mm auto; margin: 2mm; } body { font-family: Arial, sans-serif; font-size: 10pt; width: 76mm; margin: 0 auto; }
  h1 { text-align: center; font-size: 14pt; margin: 2mm 0; } table { width: 100%; border-collapse: collapse; } td { padding: .5mm 0; }
  .n { text-align: left; direction: ltr; } h2 { font-size: 11pt; border-bottom: 1px solid #000; margin: 3mm 0 1mm; }</style></head><body>
  <h1>${x ? 'דוח X (ביניים)' : `דוח Z מס' ${esc(s.number)}`}</h1>
  <table>${row('קופה', s.register_name)}${row('סניף', s.branch_name)}${row('נפתחה', dateTime(s.opened_at))}${s.closed_at ? row('נסגרה', dateTime(s.closed_at)) : ''}${row('הודפס', dateTime(new Date().toISOString()))}</table>
  <h2>מכירות</h2><table>${row('מספר עסקאות', String(rep.sales.count))}${row('ברוטו', money(rep.sales.gross))}${row('הנחות', money(-rep.sales.discount))}${row('לפני מע"מ', money(rep.sales.net))}${row('מע"מ', money(rep.sales.vat))}${row('סה"כ מכירות', money(rep.sales.total))}${row('החזרות', money(-rep.returns.total))}${row('נטו', money(rep.net_total_agorot))}${row('עיגול אגורות', money(rep.sales.rounding))}</table>
  <h2>אמצעי תשלום</h2><table>${pays || row('—', '')}</table>
  <h2>מגירה</h2><table>${row('קופה קטנה', money(s.opening_float_agorot))}${ev}${row('מזומן צפוי', money(rep.expected_cash_agorot))}${s.counted_cash_agorot != null ? row('נספר', money(s.counted_cash_agorot)) + row('פער', money(s.variance_agorot)) : ''}</table>
  <h2>מסמכים</h2><table>${docs || row('—', '')}</table>
  </body></html>`;
}
