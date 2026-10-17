// קופה (WF-01, S03, UX-01..UX-07): סריקה / חיפוש, עגלה, הנחות, לקוח, תשלום.
// טלפון — טור אחד עם פס "לתשלום" צמוד; אייפד לרוחב ומחשב — חיפוש ואריחים מימין, עגלה וסה"כ משמאל.
// אופליין (D08): חיפוש באריחים שמורים ועגלה בלבד; תשלום וסגירה רק עם חיבור.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Badge, EmptyState, LoadError, Money, Skeleton } from '../../components/ui';
import { api, ApiError, newKey, qs } from '../../lib/api';
import { askConfirm, askText } from '../../lib/dialogs';
import { money, qty } from '../../lib/format';
import { cls, useBarcodeScanner, useOnline } from '../../lib/misc';
import { useSetPageHeader } from '../../lib/pageHeader';
import { currentRegister, type Session, useSession } from '../../lib/session';
import { showError, showToast } from '../../lib/toast';
import { useLoad } from '../../lib/useLoad';
import '../../styles/pos.css';
import {
  addLine, type CartState, computeLocal, emptyCart, lineFromProduct, loadCart, loadRecent, type PosLine, pushRecent, restricted, saveCart,
} from './cart';
import CustomerPicker from './CustomerPicker';
import LineEditor from './LineEditor';
import PaySheet, { SuccessView } from './PaySheet';
import ShiftGate, { RegisterPicker } from './ShiftGate';

export default function Pos() {
  const session = useSession()!;
  const reg = currentRegister(session);
  useSetPageHeader('קופה', reg ? reg.name : undefined);
  const shift = useLoad(() => (reg ? api.get(`/cash-sessions/current${qs({ registerId: reg.id })}`) : Promise.resolve(null)), [reg?.id]);
  if (!reg) return <EmptyState icon="store" title="אין קופה מוגדרת" text="מנהל צריך להוסיף קופה בהגדרות" />;
  if (shift.data === undefined && shift.loading) return <div className="content-pad"><Skeleton variant="card" /></div>;
  if (shift.data === undefined && shift.error) return <LoadError error={shift.error} what="מצב המשמרת" onRetry={shift.reload} />;
  if (!shift.data || shift.data.session.status !== 'active') return <ShiftGate session={session} registerId={reg.id} onOpened={shift.reload} />;
  return <Register key={reg.id} session={session} reg={reg} shift={shift.data} />;
}

function Register({ session, reg, shift }: { session: Session; reg: { id: string; branch_id: string; name: string }; shift: any }) {
  const nav = useNavigate();
  const online = useOnline();
  const [cart, setCartState] = useState<CartState>(() => loadCart(reg.id));
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<PosLine | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [tiles, setTiles] = useState<any[]>(() => loadRecent(reg.id));
  const [picking, setPicking] = useState(false);
  const [paying, setPaying] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const setCart = useCallback((c: CartState) => { setCartState(c); saveCart(reg.id, c); }, [reg.id]);
  const focus = () => setTimeout(() => scanRef.current?.focus(), 30);
  const { lines, totals } = computeLocal(cart, session, reg.branch_id);

  // אריחים ראשונים כשאין היסטוריה במכשיר
  useEffect(() => {
    if (tiles.length) return;
    api.get('/products?limit=12').then((rows: any[]) => setTiles(rows.filter((p) => p.status === 'active'))).catch(() => {});
  }, []);

  // המשך מכירה שנפתחה לתשלום לפני רענון
  useEffect(() => {
    if (!cart.pendingSaleId || !online) return;
    api.get(`/sales/${cart.pendingSaleId}`).then((s) => {
      if (s.status === 'payment_pending') setPaying(s);
      else setCart({ ...cart, pendingSaleId: null });
    }).catch(() => setCart({ ...cart, pendingSaleId: null }));
  }, []);

  const add = (p: any, opts: Parameters<typeof lineFromProduct>[1] = {}) => {
    const l = lineFromProduct(p, opts);
    const r = addLine(cart, l);
    setCart(r.cart);
    setSel(r.key);
    pushRecent(reg.id, { ...p, unit_price: opts.fixedPrice ? undefined : opts.unitPrice ?? p.unit_price });
    setTiles(loadRecent(reg.id));
    if (l.soldByWeight && !opts.qtyMilli && !opts.fixedPrice) setEditing(r.cart.lines.find((x) => x.key === r.key)!);
  };

  // סריקה: ברקוד רגיל / אריזה / מאזניים, ואם לא נמצא — חיפוש בשם
  const lookup = async (code: string) => {
    const c = code.trim();
    if (!c) return;
    try {
      const r = await api.get(`/products/lookup${qs({ code: c, branchId: reg.branch_id })}`);
      add(r.product, { unitPrice: r.unitPrice, qtyMilli: r.qtyMilli, barcode: c, fixedPrice: r.fixedLinePrice });
      setQ(''); setResults(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        if (/^\d+$/.test(c)) { showToast(e.message, undefined, 'error'); setQ(''); }
        else void search(c);
      } else showError(e);
    }
    focus();
  };
  useBarcodeScanner((code) => { void lookup(code); }, !paying && !editing && !picking && !done);

  const search = async (text: string) => {
    if (!text.trim()) { setResults(null); return; }
    try { setResults(await api.get(`/pos/products${qs({ q: text.trim(), branchId: reg.branch_id })}`)); } catch (e) { showError(e); }
  };
  useEffect(() => {
    if (!q.trim() || /^\d{6,}$/.test(q.trim())) { setResults(null); return undefined; }
    const t = setTimeout(() => { void search(q); }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const updateLine = (l: PosLine) => { setCart({ ...cart, lines: cart.lines.map((x) => (x.key === l.key ? l : x)) }); setEditing(null); focus(); };
  const removeLine = (key: string) => {
    const before = cart;
    setCart({ ...cart, lines: cart.lines.filter((x) => x.key !== key) });
    setEditing(null);
    showToast('הפריט הוסר', { label: 'ביטול', onClick: () => setCart(before) });
    focus();
  };
  const step = (l: PosLine, d: number) => {
    const next = l.qtyMilli + d * 1000;
    if (next <= 0) removeLine(l.key);
    else setCart({ ...cart, lines: cart.lines.map((x) => (x.key === l.key ? { ...x, qtyMilli: next } : x)) });
  };

  const cartDiscount = async () => {
    const v = await askText({ title: 'הנחה על כל העגלה', label: 'אחוז הנחה', inputMode: 'decimal', initial: cart.cartDiscountBp ? String(cart.cartDiscountBp / 100) : '', required: false,
      validate: (x) => (x === '' || (Number(x) >= 0 && Number(x) <= 100) ? '' : 'בין 0 ל-100') });
    if (v === null) return;
    setCart({ ...cart, cartDiscountBp: Math.round(Number(v || 0) * 100) });
  };

  const clear = async () => {
    if (!cart.lines.length) return;
    if (!(await askConfirm({ title: 'לנקות את העגלה?', confirmLabel: 'ניקוי', danger: true }))) return;
    setCart(emptyCart());
    focus();
  };

  const noSale = async () => {
    const reason = await askText({ title: 'פתיחת מגירה בלי מכירה', label: 'סיבה (נרשמת ביומן)' });
    if (!reason) return;
    try { await api.post(`/cash-sessions/${shift.session.id}/events`, { kind: 'no_sale', amountAgorot: 0, reason }); showToast('נרשם — אפשר לפתוח את המגירה'); } catch (e) { showError(e); }
  };

  // "לתשלום": יצירת המכירה בשרת (המחיר נקבע שם), עם אישור גיל ו-PIN מנהל לפי הצורך
  const pay = async (approverPin?: string, ageVerified?: boolean) => {
    if (!cart.lines.length || busy) return;
    if (!online) { showToast('אין חיבור — אפשר להמשיך לבנות עגלה, התשלום כשהחיבור יחזור', undefined, 'error'); return; }
    let age = ageVerified ?? false;
    if (restricted(cart) && !age) {
      age = await askConfirm({ title: 'בעגלה מוצר מגיל 18', text: 'בדקתם תעודה מזהה והלקוח מעל גיל 18?', confirmLabel: 'כן, נבדק', icon: 'shield' });
      if (!age) return;
    }
    setBusy(true);
    try {
      const sale = await api.post('/sales', {
        registerId: reg.id, customerId: cart.customer?.id ?? null, ageVerified: age, approverPin,
        cartDiscountBp: cart.cartDiscountBp || undefined,
        lines: cart.lines.map((l) => ({ productId: l.productId, qtyMilli: l.qtyMilli, barcode: l.barcode ?? undefined, discountBp: l.discountBp || undefined })),
      }, { key: newKey() });
      setCart({ ...cart, pendingSaleId: sale.id });
      setPaying(sale);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'approval_required') {
        const pin = await askText({ title: 'נדרש אישור מנהל', text: e.message, label: 'PIN של מנהל', inputMode: 'numeric', type: 'password', icon: 'key' });
        setBusy(false);
        if (pin) return pay(pin, age);
        return;
      }
      showError(e);
    } finally { setBusy(false); }
  };

  // קיצורים: F2 חיפוש, F4 תשלום
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); scanRef.current?.focus(); }
      if (e.key === 'F4' && !paying && !done) { e.preventDefault(); void pay(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const deposits = lines.filter((l) => l.kind === 'deposit');
  const items = cart.lines;

  return (
    <div className="pos">
      <section className="pos-right" aria-label="חיפוש מוצרים">
        <div className="pos-ctx">
          <Badge tone="ok">משמרת {shift.session.number}</Badge>
          <span>{session.user.name}</span>
          <RegisterInline session={session} value={reg.id} />
          <span className="right row-gap">
            <button type="button" className="action-btn small inline ghost" onClick={noSale}><Icon name="wallet" size={16} />מגירה</button>
            <button type="button" className="action-btn small inline ghost" onClick={() => nav('/shifts')}><Icon name="chart" size={16} />דוח X</button>
          </span>
        </div>
        {!online && <div className="notice danger" role="status"><Icon name="offline" size={18} />אין חיבור. אפשר לסרוק ולבנות עגלה מהמוצרים השמורים; התשלום יתאפשר כשהחיבור יחזור.</div>}
        <form className="pos-scan" onSubmit={(e) => { e.preventDefault(); void lookup(q); }}>
          <input ref={scanRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="סריקה או חיפוש מוצר (F2)" aria-label="ברקוד או שם מוצר" enterKeyHint="search" autoComplete="off" />
          <button type="submit" className="icon-btn" aria-label="חיפוש"><Icon name="search" /></button>
        </form>
        {results && (
          <div className="pos-results" role="list">
            {results.length === 0 && <EmptyState compact icon="search" title={`לא נמצא "${q}"`} />}
            {results.map((p) => (
              <button key={p.id} type="button" className="pos-result" role="listitem" onClick={() => { add(p); setQ(''); setResults(null); focus(); }}>
                <span>{p.name} <span className="muted small">{p.sku}</span>{p.restriction !== 'none' && <Badge tone="warn">18+</Badge>}</span>
                <Money a={p.unit_price} />
              </button>
            ))}
          </div>
        )}
        {!results && tiles.length > 0 && (
          <div className="pos-tiles" aria-label="מוצרים מהירים">
            {tiles.map((p) => (
              <button key={p.id} type="button" className="pos-tile" onClick={() => { add(p); focus(); }}>
                <span>{p.name}</span><span className="money">{money(p.unit_price ?? p.price_agorot)}{p.sold_by_weight ? ' / ק"ג' : ''}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="pos-left" aria-label="עגלה">
        <div className="cart">
          <div className="cart-head">
            <b>עגלה {items.length ? `(${qty(totals.itemCount)})` : ''}</b>
            <span className="row-gap">
              <button type="button" className="action-btn small inline secondary" onClick={() => setPicking(true)}>
                <Icon name="user" size={16} />{cart.customer ? cart.customer.name : 'לקוח'}
              </button>
              {cart.customer && <button type="button" className="icon-btn plain" aria-label="הסרת לקוח" onClick={() => setCart({ ...cart, customer: null })}><Icon name="x" size={16} /></button>}
            </span>
          </div>
          <div className="cart-lines">
            {items.length === 0 && <EmptyState compact icon="cart" title="העגלה ריקה" text="סורקים ברקוד או בוחרים מוצר" />}
            {items.map((l) => {
              const c = lines.find((x) => x.key === l.key);
              const dep = deposits.find((x) => x.key === `${l.key}:deposit`);
              return (
                <div key={l.key}>
                  <div className={cls('cart-line', sel === l.key && 'sel')} onClick={() => { setSel(l.key); setEditing(l); }} role="button" tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setEditing(l); }} aria-label={`${l.name}, ${qty(l.qtyMilli)}`}>
                    <span className="nm">{l.name}</span>
                    <span className="tot money">{money(c?.total)}</span>
                    <span className="sub">
                      {l.soldByWeight ? `${qty(l.qtyMilli)} ק"ג × ${money(l.unitPrice)}` : (
                        <span className="qty-ctl" onClick={(e) => e.stopPropagation()}>
                          <button type="button" aria-label="פחות" onClick={() => step(l, -1)} disabled={l.fixedPrice}><Icon name="minus" size={16} /></button>
                          <span>{qty(l.qtyMilli)}</span>
                          <button type="button" aria-label="עוד" onClick={() => step(l, 1)} disabled={l.fixedPrice}><Icon name="plus" size={16} /></button>
                        </span>
                      )}
                      {!l.soldByWeight && <span>× {money(l.unitPrice)}</span>}
                      {!!l.discountBp && <Badge tone="teal">הנחה {l.discountBp / 100}%</Badge>}
                      {l.restriction !== 'none' && <Badge tone="warn">18+</Badge>}
                    </span>
                  </div>
                  {dep && <div className="cart-line deposit"><span className="nm">{dep.name}</span><span className="tot money">{money(dep.total)}</span></div>}
                </div>
              );
            })}
          </div>
          {items.length > 0 && (
            <div className="cart-actions">
              <button type="button" className="action-btn small inline secondary" onClick={cartDiscount}><Icon name="percent" size={16} />{cart.cartDiscountBp ? `הנחת עגלה ${cart.cartDiscountBp / 100}%` : 'הנחת עגלה'}</button>
              <button type="button" className="action-btn small inline danger-soft" onClick={clear}><Icon name="trash" size={16} />ניקוי</button>
            </div>
          )}
          <div className="cart-sum">
            {totals.discount > 0 && <div className="row"><span>הנחות</span><Money a={-totals.discount} /></div>}
            {session.tenant.tax_status !== 'patur' && <div className="row"><span>מתוכו מע"מ</span><Money a={totals.vat} /></div>}
          </div>
          <div className="pay-bar">
            <div className="total"><small>סה"כ לתשלום</small><b>{money(totals.total)}</b></div>
            <button type="button" className="action-btn" disabled={!items.length || busy || !online} onClick={() => pay()}>{busy ? '…' : 'לתשלום'}</button>
          </div>
        </div>
      </section>

      {editing && <LineEditor line={editing} onClose={() => { setEditing(null); focus(); }} onSave={updateLine} onRemove={() => removeLine(editing.key)} />}
      {picking && <CustomerPicker onClose={() => setPicking(false)} onPick={(c) => { setCart({ ...cart, customer: { id: c.id, name: c.name, phone: c.phone, kind: c.kind } }); setPicking(false); focus(); }} />}
      {paying && (
        <PaySheet sale={paying} customer={cart.customer}
          onClosed={() => { setPaying(null); setCart({ ...cart, pendingSaleId: null }); focus(); }}
          onDone={(r) => { setPaying(null); setDone(r); setCart(emptyCart()); }} />
      )}
      {done && <SuccessView result={done} onNew={() => { setDone(null); focus(); }} />}
    </div>
  );
}

function RegisterInline({ session, value }: { session: Session; value: string }) {
  const regs = session.registers.filter((r) => !session.user.branchId || r.branch_id === session.user.branchId);
  if (regs.length < 2) return null;
  return <span className="pos-reg"><RegisterPicker session={session} value={value} /></span>;
}
