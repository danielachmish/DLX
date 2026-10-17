// כרטיס מוצר (S09, PRD-01..PRD-08, PRI-01): כל השדות, ברקודים, מלאי לפי סניף, מחירי סניף, היסטוריית מחיר וארכוב
import { isValidGtin, parseQty, parseShekels } from '@dlx/core';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable';
import Icon from '../components/Icon';
import { Badge, Card, EmptyState, Field, LoadError, Modal, PageHeader, Skeleton, Switch } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { askConfirm } from '../lib/dialogs';
import { dateTime, money, qty, toShekelInput } from '../lib/format';
import { can, useSession } from '../lib/session';
import { showError, showToast } from '../lib/toast';
import { useLoad } from '../lib/useLoad';
import { UNIT_LABEL } from './office/shared';
import '../styles/office.css';

interface Bc { barcode: string; unitFactorMilli: number; kind: string }
interface Form {
  sku: string; name: string; description: string; category: string; brand: string; unitMeasure: string; soldByWeight: boolean;
  price: string; cost: string; taxCategory: string; restriction: string; deposit: string; unitPriceBasis: string; unitPriceFactor: string;
  trackStock: boolean; minStock: string; scaleCode: string; barcodes: Bc[]; version?: number;
}

const EMPTY: Form = {
  sku: '', name: '', description: '', category: '', brand: '', unitMeasure: 'unit', soldByWeight: false, price: '', cost: '', taxCategory: 'standard',
  restriction: 'none', deposit: '0', unitPriceBasis: '', unitPriceFactor: '', trackStock: true, minStock: '0', scaleCode: '', barcodes: [],
};

function toForm(p: any): Form {
  return {
    sku: p.sku, name: p.name, description: p.description ?? '', category: p.category ?? '', brand: p.brand ?? '', unitMeasure: p.unit_measure,
    soldByWeight: p.sold_by_weight, price: toShekelInput(p.price_agorot), cost: p.cost_agorot != null ? toShekelInput(p.cost_agorot) : '',
    taxCategory: p.tax_category, restriction: p.restriction, deposit: toShekelInput(p.deposit_agorot), unitPriceBasis: p.unit_price_basis ?? '',
    unitPriceFactor: p.unit_price_factor_milli ? qty(p.unit_price_factor_milli) : '', trackStock: p.track_stock, minStock: qty(p.min_stock_milli),
    scaleCode: p.scale_code ?? '', barcodes: p.barcodes ?? [], version: p.version,
  };
}

export default function ProductEdit() {
  const { id } = useParams();
  const isNew = !id;
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const s = useSession();
  const write = can('catalog:write');
  const costs = can('costs:read');
  const cats = useLoad(() => api.get('/categories'), []);
  const prod = useLoad(() => (isNew ? Promise.resolve(null) : api.get(`/products/${id}`)), [id]);
  const [f, setF] = useState<Form>(EMPTY);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [newBc, setNewBc] = useState('');
  const [bpOpen, setBpOpen] = useState(false);

  useEffect(() => {
    if (prod.data) setF(toForm(prod.data));
    else if (isNew) setF({ ...EMPTY, barcodes: sp.get('barcode') ? [{ barcode: sp.get('barcode')!, unitFactorMilli: 1000, kind: 'unit' }] : [] });
  }, [prod.data, isNew]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const inp = (k: keyof Form) => (e: any) => set(k, e.target.value);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrs({}); setMsg('');
    const price = parseShekels(f.price);
    const local: Record<string, string> = {};
    if (price == null) local.priceAgorot = 'מחיר לא תקין';
    if (f.scaleCode && !/^\d{5}$/.test(f.scaleCode)) local.scaleCode = '5 ספרות';
    const deposit = parseShekels(f.deposit || '0');
    if (deposit == null) local.depositAgorot = 'סכום לא תקין';
    if (Object.keys(local).length) { setErrs(local); return; }
    const body: any = {
      sku: f.sku.trim(), name: f.name.trim(), description: f.description || null, category: f.category.trim() || null, brand: f.brand || null,
      unitMeasure: f.unitMeasure, soldByWeight: f.soldByWeight, priceAgorot: price, taxCategory: f.taxCategory, restriction: f.restriction,
      depositAgorot: deposit, unitPriceBasis: f.unitPriceBasis || null, unitPriceFactorMilli: f.unitPriceFactor ? parseQty(f.unitPriceFactor) : null,
      trackStock: f.trackStock, minStockMilli: parseQty(f.minStock || '0') ?? 0, scaleCode: f.scaleCode || null, barcodes: f.barcodes,
    };
    if (costs && f.cost) body.costAgorot = parseShekels(f.cost);
    if (!isNew) body.version = f.version;
    setBusy(true);
    try {
      const r = isNew ? await api.post('/products', body) : await api.put(`/products/${id}`, body);
      showToast(isNew ? 'המוצר נוצר' : 'נשמר');
      if (isNew) nav(`/products/${r.id}`, { replace: true }); else prod.reload();
    } catch (x) {
      if (x instanceof ApiError) {
        setMsg(x.code === 'stale' ? 'המוצר עודכן בינתיים על ידי משתמש אחר. לחצו "רענון" כדי לטעון את הגרסה העדכנית.' : x.message);
        setErrs(x.fieldErrors ?? {});
      } else showError(x);
    } finally { setBusy(false); }
  };

  const addBarcode = () => {
    const code = newBc.trim().replace(/\s+/g, '');
    if (!code) return;
    if (f.barcodes.some((b) => b.barcode === code)) { setNewBc(''); return; }
    set('barcodes', [...f.barcodes, { barcode: code, unitFactorMilli: 1000, kind: 'unit' }]);
    setNewBc('');
  };

  const archive = async () => {
    const archived = prod.data.status !== 'archived';
    if (archived && !(await askConfirm({ title: 'להעביר לארכיון?', text: 'המוצר לא יופיע בקופה. ההיסטוריה (מכירות, מסמכים, תנועות) נשמרת.', confirmLabel: 'לארכיון' }))) return;
    try { await api.post(`/products/${id}/archive`, { archived }); showToast(archived ? 'הועבר לארכיון' : 'הוחזר לפעילות'); prod.reload(); } catch (e) { showError(e); }
  };

  if (!isNew && prod.loading && !prod.data) return <><PageHeader title="מוצר" back /><Skeleton variant="card" rows={8} /></>;
  if (!isNew && prod.error && !prod.data) return <><PageHeader title="מוצר" back /><LoadError error={prod.error} what="המוצר" onRetry={prod.reload} /></>;
  const p = prod.data;

  return (
    <div className="stack">
      <PageHeader title={isNew ? 'מוצר חדש' : p?.name ?? 'מוצר'} sub={p ? `מק"ט ${p.sku}${p.status === 'archived' ? ' · בארכיון' : ''}` : undefined} onBack={() => nav('/products')}
        actions={!isNew && write ? <>
          <button type="button" className="action-btn ghost inline" onClick={prod.reload}><Icon name="refresh" size={18} />רענון</button>
          <button type="button" className={'action-btn inline ' + (p?.status === 'archived' ? 'secondary' : 'danger-soft')} onClick={archive}>{p?.status === 'archived' ? 'החזרה לפעילות' : 'העברה לארכיון'}</button>
        </> : undefined} />

      <form onSubmit={submit} className="stack">
        <fieldset disabled={!write} className="plain-fieldset stack">
          <Card title="פרטים" icon="tag">
            <div className="form-grid">
              <Field label='מק"ט' error={errs.sku}><input value={f.sku} onChange={inp('sku')} required dir="ltr" /></Field>
              <Field label="שם המוצר" error={errs.name}><input value={f.name} onChange={inp('name')} required /></Field>
              <Field label="קטגוריה"><input value={f.category} onChange={inp('category')} list="dlx-cats" /></Field>
              <Field label="מותג"><input value={f.brand} onChange={inp('brand')} /></Field>
              <Field label="תיאור" wide><textarea value={f.description} onChange={inp('description')} rows={2} /></Field>
            </div>
            <datalist id="dlx-cats">{(cats.data ?? []).map((c: any) => <option key={c.id} value={c.name} />)}</datalist>
          </Card>

          <Card title="מחיר ומס" icon="coins">
            <div className="form-grid">
              <Field label='מחיר לצרכן (₪, כולל מע"מ)' error={errs.priceAgorot}><input value={f.price} onChange={inp('price')} inputMode="decimal" required dir="ltr" /></Field>
              {costs && <Field label='עלות ליחידה (₪, לפני מע"מ)' hint="מתעדכנת אוטומטית בקליטה (ממוצע נע)"><input value={f.cost} onChange={inp('cost')} inputMode="decimal" dir="ltr" /></Field>}
              <Field label='סיווג מע"מ' hint={f.taxCategory === 'zero' ? 'שיעור אפס — פירות וירקות טריים' : f.taxCategory === 'exempt' ? 'פטור ממע"מ — לאמת מול רו"ח' : 'מע"מ בשיעור הרגיל'}>
                <select value={f.taxCategory} onChange={inp('taxCategory')}><option value="standard">מע"מ רגיל</option><option value="zero">שיעור אפס (פירות וירקות טריים)</option><option value="exempt">פטור</option></select>
              </Field>
              <Field label="פיקדון למכל (₪)" hint="חוק הפיקדון: 0.30 ₪ לבקבוק משקה" error={errs.depositAgorot}><input value={f.deposit} onChange={inp('deposit')} inputMode="decimal" dir="ltr" /></Field>
              <Field label="הגבלת מכירה">
                <select value={f.restriction} onChange={inp('restriction')}>
                  <option value="none">ללא</option><option value="age18">מגיל 18</option><option value="alcohol">אלכוהול (מגיל 18, לא בין 23:00 ל-06:00)</option><option value="tobacco">טבק (מגיל 18)</option>
                </select>
              </Field>
              <Field label="מחיר ליחידת מידה — בסיס" hint='למשל "ל-100 גרם" או "לליטר"'><input value={f.unitPriceBasis} onChange={inp('unitPriceBasis')} /></Field>
              <Field label="כמה יחידות בסיס באריזה" hint="250 גרם במחיר ל-100 גרם = 2.5"><input value={f.unitPriceFactor} onChange={inp('unitPriceFactor')} inputMode="decimal" dir="ltr" /></Field>
            </div>
          </Card>

          <Card title="מלאי ומכירה" icon="box">
            <div className="form-grid">
              <Field label="יחידת מידה"><select value={f.unitMeasure} onChange={inp('unitMeasure')}>{Object.entries(UNIT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="מלאי מינימום" hint="מתחת לזה — התראת מלאי נמוך"><input value={f.minStock} onChange={inp('minStock')} inputMode="decimal" dir="ltr" /></Field>
              <Field label="קוד במאזניים" hint="5 ספרות, לברקוד משקל/מחיר" error={errs.scaleCode}><input value={f.scaleCode} onChange={inp('scaleCode')} inputMode="numeric" maxLength={5} dir="ltr" /></Field>
            </div>
            <div className="row-gap mt">
              <span className="check-row"><Switch on={f.soldByWeight} onChange={(v) => set('soldByWeight', v)} label="נמכר לפי משקל" />נמכר לפי משקל</span>
              <span className="check-row"><Switch on={f.trackStock} onChange={(v) => set('trackStock', v)} label="ניהול מלאי" />ניהול מלאי (שירות / שקית — כבוי)</span>
            </div>
          </Card>

          <Card title="ברקודים" icon="barcode">
            <div className="stack">
              {f.barcodes.length === 0 && <p className="muted small flush">{f.soldByWeight ? 'מוצר שקיל נמכר לפי ברקוד מאזניים — אין חובה בברקוד.' : 'בלי ברקוד ייווצר ברקוד פנימי אוטומטית.'}</p>}
              {f.barcodes.map((b, i) => (
                <div key={b.barcode} className="barcode-row">
                  <input value={b.barcode} readOnly aria-label="ברקוד" />
                  {!isValidGtin(b.barcode) && b.kind !== 'internal' && <Badge tone="warn">ספרת ביקורת לא תקינה</Badge>}
                  <select value={b.kind} aria-label="סוג" onChange={(e) => set('barcodes', f.barcodes.map((x, j) => (j === i ? { ...x, kind: e.target.value, unitFactorMilli: e.target.value === 'unit' || e.target.value === 'internal' ? 1000 : x.unitFactorMilli } : x)))}>
                    <option value="unit">יחידה</option><option value="pack">אריזה</option><option value="carton">קרטון</option><option value="internal">פנימי</option>
                  </select>
                  {(b.kind === 'pack' || b.kind === 'carton') && (
                    <input className="qty-input" aria-label="יחידות באריזה" inputMode="numeric" value={b.unitFactorMilli / 1000}
                      onChange={(e) => set('barcodes', f.barcodes.map((x, j) => (j === i ? { ...x, unitFactorMilli: Math.max(1, Number(e.target.value) || 1) * 1000 } : x)))} />
                  )}
                  <button type="button" className="icon-btn" aria-label="הסרת ברקוד" onClick={() => set('barcodes', f.barcodes.filter((_, j) => j !== i))}><Icon name="trash" size={18} /></button>
                </div>
              ))}
              <div className="barcode-row">
                <input value={newBc} onChange={(e) => setNewBc(e.target.value)} placeholder="ברקוד חדש (סריקה או הקלדה)" inputMode="numeric"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBarcode(); } }} />
                <button type="button" className="action-btn secondary inline small" onClick={addBarcode}><Icon name="plus" size={16} />הוספה</button>
              </div>
              {errs.barcodes && <div className="dlg-err">{errs.barcodes}</div>}
            </div>
          </Card>
        </fieldset>
        {msg && <div className="notice danger" role="alert"><Icon name="alert" size={18} />{msg}</div>}
        {write && <div className="form-actions"><button className="action-btn" disabled={busy}>{busy ? 'שומר…' : isNew ? 'יצירת מוצר' : 'שמירה'}</button></div>}
      </form>

      {p && (
        <div className="split">
          <Card title="מלאי לפי סניף" icon="layers">
            <ul className="list-plain">
              {p.stock.map((st: any) => <li key={st.branch_id}><span>{st.branch_name}</span><span>{qty(st.on_hand)} {UNIT_LABEL[p.unit_measure]}{st.damaged ? <small className="muted"> · פגום {qty(st.damaged)}</small> : null}</span></li>)}
            </ul>
          </Card>
          <Card title="מחירי סניף" icon="store" actions={write && s && s.branches.length > 0 ? <button type="button" className="action-btn secondary inline small" onClick={() => setBpOpen(true)}><Icon name="plus" size={16} />מחיר לסניף</button> : undefined}>
            {p.branch_prices.length === 0 ? <EmptyState compact icon="store" title="כל הסניפים במחיר הקטלוג" /> : (
              <ul className="list-plain">
                {p.branch_prices.map((bp: any) => <li key={bp.id}><span>{bp.branch_name} <small className="muted">מ-{dateTime(bp.valid_from)}{bp.valid_to ? ` עד ${dateTime(bp.valid_to)}` : ''}</small></span><span className="money">{money(bp.price_agorot)}</span></li>)}
              </ul>
            )}
          </Card>
          <Card title="היסטוריית מחיר" icon="history">
            {p.price_history.length === 0 ? <EmptyState compact icon="history" title="אין שינויים" /> : (
              <DataTable responsive={false} rows={p.price_history} rowKey={(h: any) => String(h.id)} columns={[
                { key: 'at', label: 'מתי', render: (h: any) => dateTime(h.created_at) },
                { key: 'old', label: 'לפני', num: true, render: (h: any) => (h.old_price == null ? '—' : money(h.old_price)) },
                { key: 'new', label: 'אחרי', num: true, render: (h: any) => money(h.new_price) },
              ]} />
            )}
          </Card>
        </div>
      )}
      {bpOpen && p && <BranchPriceModal productId={p.id} onClose={() => setBpOpen(false)} onDone={() => { setBpOpen(false); prod.reload(); }} />}
    </div>
  );
}

function BranchPriceModal({ productId, onClose, onDone }: { productId: string; onClose: () => void; onDone: () => void }) {
  const s = useSession()!;
  const [branchId, setBranchId] = useState(s.user.branchId ?? s.branches[0]?.id ?? '');
  const [price, setPrice] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const save = async () => {
    const a = parseShekels(price);
    if (a == null) { showError('מחיר לא תקין'); return; }
    try {
      await api.post(`/products/${productId}/branch-prices`, {
        branchId, priceAgorot: a, validFrom: from ? new Date(from).toISOString() : undefined, validTo: to ? new Date(to).toISOString() : null,
      });
      showToast('מחיר הסניף נשמר'); onDone();
    } catch (e) { showError(e); }
  };
  return (
    <Modal title="מחיר לסניף" onClose={onClose} footer={<><button type="button" className="action-btn" onClick={save}>שמירה</button><button type="button" className="action-btn ghost" onClick={onClose}>ביטול</button></>}>
      <div className="stack">
        <Field label="סניף"><select value={branchId} onChange={(e) => setBranchId(e.target.value)}>{s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="מחיר (₪, כולל מע״מ)"><input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" dir="ltr" /></Field>
        <Field label="בתוקף מ-" hint="ריק = מעכשיו"><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="עד" hint="ריק = ללא הגבלה"><input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
