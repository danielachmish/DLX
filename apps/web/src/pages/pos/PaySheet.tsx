// גיליון תשלום (POS-03, PAY-01..PAY-07): פיצול אמצעים, עודף ועיגול מזומן, אשראי עם מפתח קבוע לניסיון חוזר,
// וסגירה אטומית בשרת. אחרי הצלחה — מסך "סיום" עם עודף, מספר מסמך, הדפסה ושליחת קישור.
import { cashRound, parseShekels, type Tender, tenderState } from '@dlx/core';
import { useEffect, useMemo, useState } from 'react';
import { useSystemInfo } from '../../lib/system';
import Icon from '../../components/Icon';
import NumPad from '../../components/NumPad';
import { Field, Modal, Money } from '../../components/ui';
import { api, ApiError, newKey } from '../../lib/api';
import { askConfirm, askText } from '../../lib/dialogs';
import { DOC_TITLE, money, PAY_LABEL } from '../../lib/format';
import { cls, printHtml } from '../../lib/misc';
import { showError, showToast } from '../../lib/toast';

type Method = 'cash' | 'card' | 'check' | 'transfer' | 'bit' | 'credit_note' | 'customer_account';
interface LocalTender { method: Exclude<Method, 'card'>; amountAgorot: number; voucherCode?: string; checkNumber?: string; checkBank?: string; checkDate?: string; reference?: string }

const METHODS: { key: Method; icon: string }[] = [
  { key: 'cash', icon: 'coins' }, { key: 'card', icon: 'card' }, { key: 'bit', icon: 'phone' },
  { key: 'check', icon: 'note' }, { key: 'transfer', icon: 'building' }, { key: 'credit_note', icon: 'receipt' },
  { key: 'customer_account', icon: 'book' },
];

const toInput = (a: number) => (a > 0 ? (a / 100).toFixed(2).replace(/\.00$/, '') : '');

export default function PaySheet({ sale: initial, customer, onDone, onClosed }: {
  sale: any; customer: { id: string; name: string; kind?: string } | null; onDone: (r: any) => void; onClosed: (cancelled: boolean) => void;
}) {
  const [sale, setSale] = useState<any>(initial);
  const [tenders, setTenders] = useState<LocalTender[]>([]);
  const [method, setMethod] = useState<Method>('cash');
  const [amount, setAmount] = useState('');
  const sys = useSystemInfo();
  const [terminal, setTerminal] = useState<'integrated' | 'external'>('integrated');
  // אין מסוף מחובר בשרת הזה — רק "מסוף חיצוני" (הקופאי מקליד את מספר האישור)
  useEffect(() => { if (sys && !sys.paymentIntegrated) setTerminal('external'); }, [sys]);
  const [approval, setApproval] = useState('');
  const [last4, setLast4] = useState('');
  const [installments, setInstallments] = useState(1);
  const [extra, setExtra] = useState({ voucherCode: '', checkNumber: '', checkBank: '', checkDate: '', reference: '' });
  const [cardKey, setCardKey] = useState<string | null>(null);
  const [cardPending, setCardPending] = useState<{ amount: number; paymentId?: string } | null>(null);
  const [finKey, setFinKey] = useState(() => newKey());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const due: number = sale.total_agorot;
  const cards = useMemo(() => (sale.payments ?? []).filter((p: any) => p.method === 'card' && p.direction === 'in' && p.status === 'captured'), [sale]);
  const all: Tender[] = [...cards.map((p: any) => ({ method: 'card' as const, amount: p.amount_agorot })), ...tenders.map((t) => ({ method: t.method, amount: t.amountAgorot }))];
  const ts = useMemo(() => { try { return tenderState(due, all); } catch { return tenderState(due, []); } }, [due, JSON.stringify(all)]);
  const remaining = ts.remaining;
  const suggest = (m: Method) => (m === 'cash' ? ts.remainingCash : remaining);

  const pick = (m: Method) => { setMethod(m); setMsg(''); setAmount(toInput(suggest(m))); };

  const quick = useMemo(() => {
    const r = ts.remainingCash;
    if (r <= 0) return [];
    const notes = [2000, 5000, 10000, 20000].filter((n) => n > r).slice(0, 3);
    return [...new Set([r, ...notes, Math.ceil(r / 10000) * 10000])].filter((n) => n >= r).slice(0, 4);
  }, [ts.remainingCash]);

  const refresh = async () => setSale(await api.get(`/sales/${sale.id}`));

  async function chargeCard(amt: number) {
    const key = cardKey ?? newKey();
    setCardKey(key); setBusy(true); setMsg('');
    try {
      const r = await api.post(`/sales/${sale.id}/payments`, {
        method: 'card', amountAgorot: amt, installments, terminal,
        approvalCode: terminal === 'external' ? approval.trim() : undefined, last4: last4 || undefined,
      }, { key });
      setSale(r.sale);
      if (r.payment.status === 'captured') { setCardKey(null); setCardPending(null); setAmount(''); setApproval(''); setLast4(''); showToast('האשראי אושר'); }
      else if (r.payment.status === 'pending' || r.payment.status === 'initiated') { setCardPending({ amount: amt, paymentId: r.payment.id }); setMsg('אין עדיין תשובה מחברת האשראי. בודקים שוב באותה עסקה — לא יהיה חיוב כפול.'); }
      else { setCardKey(null); setCardPending(null); setMsg(r.payment.failure_reason || 'העסקה סורבה'); }
    } catch (e) {
      if (e instanceof ApiError && !e.offline && e.status < 500 && e.code !== 'payment_in_progress') setCardKey(null);
      setMsg(e instanceof Error ? e.message : 'שגיאה');
      if (e instanceof ApiError && (e.offline || e.status >= 500)) setCardPending({ amount: amt });
    } finally { setBusy(false); }
  }

  function addTender() {
    setMsg('');
    const a = parseShekels(amount || '0');
    if (!a || a <= 0) { setMsg('צריך סכום'); return; }
    if (method === 'card') {
      if (a > remaining) { setMsg('סכום האשראי גדול מהיתרה'); return; }
      if (terminal === 'external' && !approval.trim()) { setMsg('צריך להזין מספר אישור מהמסוף'); return; }
      void chargeCard(a);
      return;
    }
    if (method !== 'cash' && a > remaining) { setMsg(`${PAY_LABEL[method]}: הסכום גדול מהיתרה`); return; }
    if (method === 'credit_note' && !extra.voucherCode.trim()) { setMsg('צריך קוד שובר'); return; }
    if (method === 'check' && !extra.checkNumber.trim()) { setMsg('צריך מספר שיק'); return; }
    if (method === 'customer_account' && !customer) { setMsg('הקפה דורשת לקוח במכירה'); return; }
    const t: LocalTender = { method, amountAgorot: a };
    if (method === 'credit_note') t.voucherCode = extra.voucherCode.trim().toUpperCase();
    if (method === 'check') { t.checkNumber = extra.checkNumber.trim(); t.checkBank = extra.checkBank.trim() || undefined; t.checkDate = extra.checkDate || undefined; }
    if (method === 'transfer' || method === 'bit') t.reference = extra.reference.trim() || undefined;
    setTenders([...tenders, t]);
    setAmount('');
    setExtra({ voucherCode: '', checkNumber: '', checkBank: '', checkDate: '', reference: '' });
  }

  async function finalize() {
    setBusy(true); setMsg('');
    try {
      const r = await api.post(`/sales/${sale.id}/finalize`, {
        tenders, party: customer?.kind === 'business' ? 'business' : 'consumer',
      }, { key: finKey });
      onDone(r);
    } catch (e) {
      // שגיאה ודאית מהשרת — הבקשה לא בוצעה, ניסיון הבא עם מפתח חדש. ניתוק — אותו מפתח (אולי כבר נסגרה)
      if (e instanceof ApiError && !e.offline && e.status < 500) setFinKey(newKey());
      setMsg(e instanceof Error ? e.message : 'שגיאה');
      if (e instanceof ApiError && e.code === 'payment_in_progress') await refresh().catch(() => {});
    } finally { setBusy(false); }
  }

  async function cancelSale() {
    const reason = await askText({ title: 'ביטול המכירה', label: 'סיבה', initial: cards.length ? '' : 'חזרה לעגלה', confirmLabel: 'ביטול מכירה', danger: true });
    if (!reason) return;
    setBusy(true);
    try {
      const r = await api.post(`/sales/${sale.id}/cancel`, { reason });
      if (r.manualVoids) showToast('יש לבטל את עסקת האשראי גם במסוף החיצוני');
      onClosed(true);
    } catch (e) { showError(e); } finally { setBusy(false); }
  }

  // סגירת הגיליון: בלי אשראי שחויב — המכירה הפתוחה מבוטלת והעגלה נשארת לעריכה
  async function close() {
    if (cards.length || cardPending) {
      if (await askConfirm({ title: 'יש תשלום אשראי במכירה', text: 'כדי לחזור לעגלה צריך לבטל את המכירה (האשראי יבוטל). להמשיך בתשלום?', confirmLabel: 'ביטול המכירה', cancelLabel: 'המשך תשלום', danger: true })) await cancelSale();
      return;
    }
    try { await api.post(`/sales/${sale.id}/cancel`, { reason: 'חזרה לעגלה' }); } catch { /* אם נכשל — נשארת ממתינה ותבוטל בפעם הבאה */ }
    onClosed(true);
  }

  return (
    <Modal title="תשלום" onClose={close} size="wide">
      <div className="pay-sheet">
        <div className="pay-due"><span>לתשלום</span><b className="money">{money(due)}</b></div>

        {(cards.length > 0 || tenders.length > 0) && (
          <div className="tender-list">
            {cards.map((p: any) => (
              <div key={p.id} className="tender-row"><span><Icon name="card" size={16} /> אשראי {p.card_last4 ? `••••${p.card_last4}` : ''} {p.approval_code ? `· אישור ${p.approval_code}` : ''}</span><Money a={p.amount_agorot} /></div>
            ))}
            {tenders.map((t, i) => (
              <div key={i} className="tender-row">
                <span>{PAY_LABEL[t.method]}{t.voucherCode ? ` · ${t.voucherCode}` : ''}{t.checkNumber ? ` · שיק ${t.checkNumber}` : ''}</span>
                <span className="row-gap"><Money a={t.amountAgorot} />
                  <button type="button" className="icon-btn plain" aria-label="הסרה" onClick={() => setTenders(tenders.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button></span>
              </div>
            ))}
            {!ts.settled && <div className="tender-row"><b>נשאר לתשלום</b><b className="money">{money(remaining)}</b></div>}
          </div>
        )}

        {ts.settled ? (
          <>
            {ts.change > 0 && <div className="change-box">עודף ללקוח<b className="money">{money(ts.change)}</b></div>}
            {ts.rounding !== 0 && <p className="muted small">עיגול אגורות: {money(ts.rounding)}</p>}
            {msg && <div className="notice danger" role="alert"><Icon name="alert" size={18} />{msg}</div>}
            <button type="button" className="action-btn" disabled={busy} onClick={finalize}>{busy ? 'מפיק מסמך…' : 'סיום והפקת קבלה'}</button>
          </>
        ) : (
          <>
            <div className="pay-methods" role="radiogroup" aria-label="אמצעי תשלום">
              {METHODS.filter((m) => m.key !== 'customer_account' || customer).map((m) => (
                <button key={m.key} type="button" role="radio" aria-checked={method === m.key} className={cls(method === m.key && 'on')} onClick={() => pick(m.key)}>
                  <Icon name={m.icon} size={22} />{PAY_LABEL[m.key]}
                </button>
              ))}
            </div>

            {method === 'cash' && quick.length > 0 && (
              <div className="quick-cash">{quick.map((n) => <button key={n} type="button" onClick={() => setAmount(toInput(n))}>{money(n)}</button>)}</div>
            )}

            {method === 'card' && (
              <div className="stack">
                <div className="chips">
                  {sys?.paymentIntegrated !== false && <button type="button" className={cls('chip-f', terminal === 'integrated' && 'on')} onClick={() => setTerminal('integrated')}>מסוף מחובר</button>}
                  <button type="button" className={cls('chip-f', terminal === 'external' && 'on')} onClick={() => setTerminal('external')}>מסוף חיצוני</button>
                </div>
                <div className="form-grid">
                  <Field label="תשלומים"><select value={installments} onChange={(e) => setInstallments(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6, 10, 12].map((n) => <option key={n} value={n}>{n === 1 ? 'רגיל' : `${n} תשלומים`}</option>)}</select></Field>
                  {terminal === 'external' && <>
                    <Field label="מספר אישור"><input value={approval} onChange={(e) => setApproval(e.target.value)} inputMode="numeric" dir="ltr" /></Field>
                    <Field label="4 ספרות אחרונות"><input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" dir="ltr" /></Field>
                  </>}
                </div>
                {cardPending && (
                  <div className="notice info"><Icon name="clock" size={18} />
                    <span>בודק סטטוס של {money(cardPending.amount)}…</span>
                    <button type="button" className="action-btn small inline" disabled={busy} onClick={() => chargeCard(cardPending.amount)}>בדיקה שוב</button>
                  </div>
                )}
              </div>
            )}
            {method === 'credit_note' && <Field label="קוד שובר"><input value={extra.voucherCode} onChange={(e) => setExtra({ ...extra, voucherCode: e.target.value })} dir="ltr" autoCapitalize="characters" /></Field>}
            {method === 'check' && (
              <div className="form-grid">
                <Field label="מספר שיק"><input value={extra.checkNumber} onChange={(e) => setExtra({ ...extra, checkNumber: e.target.value })} inputMode="numeric" dir="ltr" /></Field>
                <Field label="בנק / סניף"><input value={extra.checkBank} onChange={(e) => setExtra({ ...extra, checkBank: e.target.value })} /></Field>
                <Field label="תאריך פירעון"><input type="date" value={extra.checkDate} onChange={(e) => setExtra({ ...extra, checkDate: e.target.value })} /></Field>
              </div>
            )}
            {(method === 'transfer' || method === 'bit') && <Field label="אסמכתה"><input value={extra.reference} onChange={(e) => setExtra({ ...extra, reference: e.target.value })} dir="ltr" /></Field>}
            {method === 'customer_account' && customer && <p className="notice info"><Icon name="book" size={18} />הקפה על חשבון {customer.name}. בדיקת מסגרת האשראי בשרת.</p>}

            <NumPad value={amount} onChange={setAmount} onEnter={addTender} enterLabel={method === 'card' ? (busy ? 'מחייב…' : `חיוב אשראי ${amount ? money(parseShekels(amount) ?? 0) : ''}`) : `הוספת ${PAY_LABEL[method]}`} />
            {method === 'cash' && amount && (parseShekels(amount) ?? 0) >= ts.remainingCash && ts.remainingCash > 0 && (
              <p className="muted small">עודף צפוי: {money((parseShekels(amount) ?? 0) - cashRound(remaining))}</p>
            )}
            {msg && <div className="notice danger" role="alert"><Icon name="alert" size={18} />{msg}</div>}
          </>
        )}
        <button type="button" className="action-btn danger-soft inline" disabled={busy} onClick={cancelSale}><Icon name="ban" size={18} />ביטול המכירה</button>
      </div>
    </Modal>
  );
}

// מסך "סיום": עודף גדול, מסמך, הדפסה, קישור לשליחה, מכירה חדשה
export function SuccessView({ result, onNew }: { result: any; onNew: () => void }) {
  const doc = result.document;
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const print = async () => {
    setBusy(true);
    try { const r = await api.post(`/documents/${doc.id}/print`, { format: '80mm' }); printHtml(r.html); showToast(`הודפס: ${r.mark}`); } catch (e) { showError(e); } finally { setBusy(false); }
  };
  const share = async () => {
    try { const r = await api.post(`/documents/${doc.id}/link`); setLink(r.url); } catch (e) { showError(e); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(link!); showToast('הקישור הועתק'); } catch { showToast(link!); } };
  return (
    <Modal title="המכירה הושלמה" onClose={onNew} size="wide">
      <div className="pay-sheet">
        {result.change_agorot > 0
          ? <div className="change-box">עודף ללקוח<b className="money">{money(result.change_agorot)}</b></div>
          : <div className="change-box"><Icon name="check2" size={34} /><b className="pos-done-title">שולם</b></div>}
        <p className="pos-doc-line">{DOC_TITLE[doc.doc_type] ?? doc.doc_type} מס' <b>{doc.serial}</b> · {money(result.sale?.total_agorot)}</p>
        {doc.allocation_number && <p className="muted small">מספר הקצאה: {doc.allocation_number}</p>}
        <div className="form-actions">
          <button type="button" className="action-btn secondary" disabled={busy} onClick={print}><Icon name="printer" size={18} />הדפסת קבלה</button>
          <button type="button" className="action-btn secondary" onClick={share}><Icon name="share" size={18} />קישור ללקוח</button>
        </div>
        {link && (
          <div className="notice info pos-link">
            <span className="pos-link-url" dir="ltr">{link}</span>
            <span className="row-gap">
              <button type="button" className="action-btn small inline" onClick={copy}>העתקה</button>
              <a className="action-btn small inline secondary" href={`https://wa.me/?text=${encodeURIComponent(`הקבלה שלך: ${link}`)}`} target="_blank" rel="noreferrer">וואטסאפ</a>
            </span>
          </div>
        )}
        <button type="button" className="action-btn" autoFocus onClick={onNew}>מכירה חדשה</button>
      </div>
    </Modal>
  );
}
