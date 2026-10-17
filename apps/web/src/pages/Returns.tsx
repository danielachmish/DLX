// החזרות (WF-03, RET-01..RET-06, S07): איתור המכירה המקורית, בחירת כמות לכל שורה (לא יותר ממה שנמכר),
// גורל הפריט, סיבה, אופן ההחזר הכספי. הפיקדון חוזר אוטומטית עם הפריט. התוצאה: חשבונית זיכוי מקושרת למקור.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable';
import Icon from '../components/Icon';
import { Card, EmptyState, Field, LoadError, Modal, Money, PageHeader, Skeleton, Tabs } from '../components/ui';
import { api, ApiError, newKey, qs } from '../lib/api';
import { askText } from '../lib/dialogs';
import { DOC_TITLE, dateOnly, dateTime, money, PAY_LABEL, qty } from '../lib/format';
import { cls, printHtml, useSavedState } from '../lib/misc';
import { currentRegister, useSession } from '../lib/session';
import { showError } from '../lib/toast';
import { useLoad } from '../lib/useLoad';
import '../styles/pos.css';

const DISPOSITION = { restock: 'חוזר למלאי', damaged: 'פגום', supplier: 'החזרה לספק' } as const;
type Disp = keyof typeof DISPOSITION;

export default function Returns() {
  const [params] = useSearchParams();
  const [tab, setTab] = useSavedState('returnsTab', 'new');
  const saleParam = params.get('sale');
  const t = saleParam ? 'new' : tab;
  return (
    <div>
      <PageHeader sub="החזרה מתוך המכירה המקורית — זיכוי מקושר, מלאי לפי מצב הפריט" />
      <Tabs variant="seg" value={t} onChange={setTab} items={[{ key: 'new', label: 'החזרה חדשה' }, { key: 'list', label: 'החזרות אחרונות' }]} />
      {t === 'new' ? <NewReturn saleId={saleParam} /> : <RecentReturns />}
    </div>
  );
}

function NewReturn({ saleId }: { saleId: string | null }) {
  const session = useSession()!;
  const reg = currentRegister(session);
  const [q, setQ] = useState('');
  const [sale, setSale] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Record<string, { qty: number; disp: Disp }>>({});
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'original' | 'cash' | 'credit_note'>('original');
  const [key, setKey] = useState(() => newKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [result, setResult] = useState<any>(null);
  const shift = useLoad(() => (reg ? api.get(`/cash-sessions/current${qs({ registerId: reg.id })}`) : Promise.resolve(null)), [reg?.id]);

  const load = async (p: Promise<any>) => {
    setLoading(true); setMsg(''); setSale(null); setSel({});
    try {
      const s = await p;
      if (s.status !== 'finalized') throw new Error('אפשר להחזיר רק ממכירה שנסגרה');
      setSale(s);
    } catch (e) { setMsg(e instanceof Error ? e.message : 'שגיאה'); } finally { setLoading(false); }
  };
  useEffect(() => { if (saleId) void load(api.get(`/sales/${saleId}`)); }, [saleId]);

  const items = (sale?.lines ?? []).filter((l: any) => l.kind === 'item');
  const left = (l: any) => l.qty_milli - l.returned_qty_milli;
  const est = items.reduce((a: number, l: any) => {
    const s = sel[l.id];
    if (!s?.qty) return a;
    return a + Math.round(((l.total_agorot - l.returned_total_agorot) * s.qty) / Math.max(1, left(l)));
  }, 0);
  const chosen = Object.entries(sel).filter(([, v]) => v.qty > 0);

  const setQty = (l: any, v: number) => {
    const max = left(l);
    const n = Math.max(0, Math.min(max, v));
    setSel({ ...sel, [l.id]: { qty: n, disp: sel[l.id]?.disp ?? 'restock' } });
  };

  const submit = async (approverPin?: string) => {
    if (!reg) return;
    if (!chosen.length) { setMsg('בחרו מה מחזירים'); return; }
    if (reason.trim().length < 2) { setMsg('צריך סיבה להחזרה'); return; }
    setBusy(true); setMsg('');
    try {
      const r = await api.post('/returns', {
        saleId: sale.id, registerId: reg.id, reason: reason.trim(), refundMethod: method, approverPin,
        lines: chosen.map(([saleLineId, v]) => ({ saleLineId, qtyMilli: v.qty, disposition: v.disp })),
      }, { key });
      setResult(r);
    } catch (e) {
      if (e instanceof ApiError && !e.offline && e.status < 500) setKey(newKey());
      if (e instanceof ApiError && e.code === 'approval_required') {
        setBusy(false);
        const pin = await askText({ title: 'נדרש אישור מנהל', text: e.message, label: 'PIN של מנהל', inputMode: 'numeric', type: 'password', icon: 'key' });
        if (pin) return submit(pin);
        return;
      }
      setMsg(e instanceof Error ? e.message : 'שגיאה');
    } finally { setBusy(false); }
  };

  const reset = () => { setResult(null); setSale(null); setSel({}); setReason(''); setQ(''); setKey(newKey()); };

  if (!reg) return <EmptyState icon="store" title="אין קופה מוגדרת למכשיר" />;
  if (shift.data === null) return <EmptyState icon="wallet" title="אין משמרת פתוחה בקופה" text="החזרה כספית נרשמת במשמרת — פותחים משמרת במסך הקופה" />;

  return (
    <div className="stack">
      <form className="search-box" onSubmit={(e) => { e.preventDefault(); if (q.trim()) void load(api.get(`/returns/lookup${qs({ q: q.trim() })}`)); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="מספר קבלה / חשבונית" inputMode="numeric" aria-label="מספר מסמך" />
        <button className="action-btn inline" type="submit" disabled={loading}><Icon name="search" size={18} />איתור</button>
      </form>
      {loading && <Skeleton variant="card" />}
      {msg && !sale && <div className="notice danger" role="alert"><Icon name="alert" size={18} />{msg}</div>}
      {sale && (
        <>
          <Card title={`${DOC_TITLE[sale.document_type] ?? 'מסמך'} ${sale.document_serial ?? ''}`} icon="receipt"
            actions={<span className="muted small">{dateTime(sale.finalized_at)} · {money(sale.total_agorot)}{sale.customer_name ? ` · ${sale.customer_name}` : ''}</span>}>
            {items.map((l: any) => {
              const max = left(l);
              const s = sel[l.id];
              const step = 1000;
              return (
                <div key={l.id} className={cls('ret-line', max <= 0 && 'off')}>
                  <div>
                    <b>{l.name}</b>
                    <div className="muted small">נמכרו {qty(l.qty_milli)}{l.returned_qty_milli ? ` · הוחזרו ${qty(l.returned_qty_milli)}` : ''} · {money(l.total_agorot)}</div>
                  </div>
                  {max > 0 ? (
                    <div className="ctl">
                      <span className="qty-ctl">
                        <button type="button" aria-label="פחות" onClick={() => setQty(l, (s?.qty ?? 0) - Math.min(step, max))}><Icon name="minus" size={16} /></button>
                        <span>{qty(s?.qty ?? 0)}</span>
                        <button type="button" aria-label="עוד" onClick={() => setQty(l, (s?.qty ?? 0) + Math.min(step, max))}><Icon name="plus" size={16} /></button>
                      </span>
                      {max % 1000 !== 0 && <button type="button" className="action-btn small inline ghost" onClick={() => setQty(l, max)}>הכל</button>}
                      <select value={s?.disp ?? 'restock'} onChange={(e) => setSel({ ...sel, [l.id]: { qty: s?.qty ?? 0, disp: e.target.value as Disp } })} aria-label="מצב הפריט">
                        {Object.entries(DISPOSITION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </div>
                  ) : <span className="muted small">הוחזר במלואו</span>}
                </div>
              );
            })}
          </Card>
          <Card title="החזר כספי" icon="wallet">
            <div className="chips mb">
              {([['original', 'באמצעי המקורי'], ['cash', 'מזומן'], ['credit_note', 'שובר זיכוי']] as const).map(([k, v]) => (
                <button key={k} type="button" className={cls('chip-f', method === k && 'on')} onClick={() => setMethod(k)}>{v}</button>
              ))}
            </div>
            <Field label="סיבת ההחזרה"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="למשל: לא מתאים, פגום" /></Field>
            <p className="muted small mt">הסכום לזיכוי (לפי מה ששולם בפועל, כולל הנחות ופיקדון): <b className="money">{money(est)}</b>{' '}— הסכום הסופי נקבע בשרת.</p>
            {msg && <div className="notice danger mt" role="alert"><Icon name="alert" size={18} />{msg}</div>}
            <div className="form-actions">
              <button type="button" className="action-btn" disabled={busy || !chosen.length} onClick={() => submit()}>{busy ? 'מפיק זיכוי…' : 'ביצוע החזרה'}</button>
              <button type="button" className="action-btn ghost" onClick={reset}>ביטול</button>
            </div>
          </Card>
        </>
      )}
      {!sale && !loading && !msg && <EmptyState icon="undo" title="איתור מכירה להחזרה" text="סורקים או מקלידים את מספר הקבלה" />}
      {result && <ResultModal r={result} onClose={reset} />}
    </div>
  );
}

function ResultModal({ r, onClose }: { r: any; onClose: () => void }) {
  const nav = useNavigate();
  const printDoc = async () => {
    try { const p = await api.post(`/documents/${r.document.id}/print`, { format: '80mm' }); printHtml(p.html); } catch (e) { showError(e); }
  };
  return (
    <Modal title="ההחזרה בוצעה" onClose={onClose} size="wide">
      <div className="pay-sheet">
        <div className="change-box">להחזיר ללקוח<b className="money">{money(r.total_agorot)}</b></div>
        <p className="pos-doc-line">{DOC_TITLE[r.document.doc_type]} מס' <b>{r.document.serial}</b></p>
        <ul className="list-plain">{r.refunds.map((p: any, i: number) => <li key={i}><span>{PAY_LABEL[p.method] ?? p.method}</span><Money a={p.amount} /></li>)}</ul>
        {r.manualCardRefund && <div className="notice"><Icon name="card" size={18} />יש לבצע זיכוי במסוף האשראי החיצוני.</div>}
        {r.voucher && (
          <>
            <div className="voucher-code" aria-label="קוד שובר">{r.voucher.code}</div>
            <p className="muted small">שובר זיכוי על {money(r.voucher.amount_agorot)}, בתוקף עד {dateOnly(r.voucher.expires_at)}</p>
            <button type="button" className="action-btn secondary" onClick={() => printHtml(voucherHtml(r.voucher))}><Icon name="printer" size={18} />הדפסת שובר</button>
          </>
        )}
        <div className="form-actions">
          <button type="button" className="action-btn secondary" onClick={printDoc}><Icon name="printer" size={18} />הדפסת זיכוי</button>
          <button type="button" className="action-btn ghost" onClick={() => nav(`/documents/${r.document.id}`)}>למסמך</button>
        </div>
        <button type="button" className="action-btn" onClick={onClose}>סיום</button>
      </div>
    </Modal>
  );
}

function voucherHtml(v: any) {
  const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>שובר זיכוי</title><style>
  @page { size: 80mm auto; margin: 2mm; } body { font-family: Arial, sans-serif; width: 76mm; margin: 0 auto; text-align: center; }
  h1 { font-size: 15pt; margin: 3mm 0; } .code { font-size: 20pt; font-weight: 800; letter-spacing: 2px; border: 2px dashed #000; padding: 3mm; margin: 3mm 0; direction: ltr; }
  .amt { font-size: 16pt; font-weight: 700; } p { font-size: 9pt; }</style></head><body>
  <h1>שובר זיכוי</h1><div class="amt">${esc(money(v.amount_agorot))}</div><div class="code">${esc(v.code)}</div>
  <p>בתוקף עד ${esc(dateOnly(v.expires_at))}. ניתן לממש בקופה כאמצעי תשלום, גם בחלקים.</p></body></html>`;
}

function RecentReturns() {
  const nav = useNavigate();
  const list = useLoad(() => api.get('/returns'), []);
  if (list.data === undefined && list.loading) return <Skeleton />;
  if (list.data === undefined) return <LoadError error={list.error} what="ההחזרות" onRetry={list.reload} />;
  return (
    <DataTable rows={list.data} rowKey={(r: any) => r.id} empty={<EmptyState icon="undo" title="אין החזרות עדיין" />}
      onRowClick={(r: any) => { if (r.document_serial) void api.get(`/documents${qs({ type: r.document_type, serial: r.document_serial })}`).then((d) => d[0] && nav(`/documents/${d[0].id}`)); }}
      columns={[
        { key: 'n', label: 'החזרה', primary: true, render: (r: any) => `${r.number} · ${DOC_TITLE[r.document_type] ?? ''} ${r.document_serial ?? ''}`, value: (r: any) => r.number },
        { key: 'when', label: 'זמן', render: (r: any) => dateTime(r.created_at), value: (r: any) => r.created_at },
        { key: 'orig', label: 'מסמך מקור', render: (r: any) => r.sale_document_serial ?? '—', muted: true },
        { key: 'reason', label: 'סיבה', render: (r: any) => r.reason, muted: true },
        { key: 'method', label: 'החזר', render: (r: any) => ({ original: 'אמצעי מקורי', cash: 'מזומן', credit_note: 'שובר' } as Record<string, string>)[r.refund_method] ?? r.refund_method, hideOnCard: true },
        { key: 'total', label: 'סכום', num: true, render: (r: any) => <Money a={-r.total_agorot} />, value: (r: any) => r.total_agorot },
      ]} />
  );
}
