// רכש וקליטה (S10, S11, S13): הזמנות רכש, קליטות סחורה וספקים (PUR-01..PUR-07, RCV-01, RCV-02, G-19)
import { isValidIsraeliId, parseQty, parseShekels } from '@dlx/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DataTable from '../components/DataTable';
import Icon from '../components/Icon';
import { Badge, EmptyState, Field, LoadError, Modal, PageHeader, Skeleton, Tabs } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateOnly, dateTime, money, todayIL, toShekelInput } from '../lib/format';
import { useSavedState } from '../lib/misc';
import { can, useSession } from '../lib/session';
import { showError, showToast } from '../lib/toast';
import { loadPhase, useLoad } from '../lib/useLoad';
import { BranchSelect, defaultBranch, GR_STATUS, PO_STATUS, type PickedProduct, ProductPicker } from './office/shared';
import '../styles/office.css';

export default function Purchasing() {
  const [tab, setTab] = useSavedState('purTab', 'po');
  return (
    <div>
      <PageHeader sub="הזמנות מספקים, קליטת סחורה למלאי ופרטי ספקים" />
      <Tabs value={tab} onChange={setTab} items={[{ key: 'po', label: 'הזמנות רכש', icon: 'book' }, { key: 'gr', label: 'קליטות', icon: 'truck' }, { key: 'sup', label: 'ספקים', icon: 'building' }]} />
      {tab === 'po' && <PoTab />}
      {tab === 'gr' && <GrTab />}
      {tab === 'sup' && <SuppliersTab />}
    </div>
  );
}

function PoTab() {
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(false);
  const list = useLoad(() => api.get(`/purchase-orders${status ? `?status=${status}` : ''}`), [status]);
  const phase = loadPhase(list);
  const write = can('purchase:write');
  return (
    <>
      <div className="toolbar">
        <div className="chips grow">
          {[['', 'הכל'], ['draft', 'טיוטות'], ['approved', 'מאושרות'], ['ordered', 'נשלחו'], ['partial', 'חלקיות'], ['received', 'התקבלו']].map(([k, l]) => (
            <button key={k} type="button" className={'chip-f' + (status === k ? ' on' : '')} onClick={() => setStatus(k!)}>{l}</button>
          ))}
        </div>
        {write && <button type="button" className="action-btn inline" onClick={() => setOpen(true)}><Icon name="plus" size={18} />הזמנה חדשה</button>}
      </div>
      {phase === 'loading' && <Skeleton rows={5} />}
      {phase === 'error' && <LoadError error={list.error} what="הזמנות הרכש" onRetry={list.reload} />}
      {phase === 'empty' && <EmptyState icon="book" title="אין הזמנות רכש" action={write ? { label: 'הזמנה חדשה', onClick: () => setOpen(true), primary: true } : null} />}
      {phase === 'ready' && (
        <DataTable rows={list.data} rowKey={(r: any) => r.id} onRowClick={(r: any) => nav(`/purchasing/po/${r.id}`)} columns={[
          { key: 'n', label: 'הזמנה', primary: true, value: (r: any) => r.number, render: (r: any) => `הזמנה ${r.number}` },
          { key: 'sup', label: 'ספק', value: (r: any) => r.supplier_name },
          { key: 'st', label: 'סטטוס', render: (r: any) => <Badge tone={PO_STATUS[r.status]?.tone}>{PO_STATUS[r.status]?.label ?? r.status}</Badge> },
          { key: 'br', label: 'סניף', value: (r: any) => r.branch_name, hideOnCard: true },
          { key: 'at', label: 'נוצרה', render: (r: any) => dateOnly(r.created_at), hideOnCard: true },
          { key: 'exp', label: 'צפי', render: (r: any) => (r.expected_at ? dateOnly(r.expected_at) : '—') },
          { key: 'open', label: 'שורות פתוחות', num: true, value: (r: any) => r.open_lines, hideOnCard: true },
          { key: 'total', label: 'סכום (לפני מע"מ)', num: true, value: (r: any) => Number(r.total_agorot), render: (r: any) => money(Number(r.total_agorot)) },
        ]} />
      )}
      {open && <NewPoModal onClose={() => setOpen(false)} onDone={(id) => nav(`/purchasing/po/${id}`)} />}
    </>
  );
}

export interface PoLineDraft { product: PickedProduct; qty: string; cost: string }

// עורך שורות הזמנה — משותף ליצירה ולעריכת טיוטה
export function PoLinesEditor({ lines, setLines }: { lines: PoLineDraft[]; setLines: (l: PoLineDraft[]) => void }) {
  return (
    <div className="line-editor">
      <ProductPicker onPick={(p) => { if (!lines.some((l) => l.product.id === p.id)) setLines([...lines, { product: p, qty: '1', cost: p.cost_agorot ? toShekelInput(p.cost_agorot) : '' }]); }} />
      {lines.map((l, i) => (
        <div key={l.product.id} className="line-row">
          <span className="nm">{l.product.name}<small>{l.product.sku}</small></span>
          <input value={l.qty} inputMode="decimal" aria-label="כמות" dir="ltr" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
          <input className="cost" value={l.cost} inputMode="decimal" aria-label="עלות ליחידה לפני מע״מ" placeholder="עלות ₪" dir="ltr" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))} />
          <button type="button" className="icon-btn" aria-label="הסרה" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Icon name="trash" size={18} /></button>
        </div>
      ))}
      {lines.length > 0 && <p className="muted small flush">כמות · עלות ליחידה לפני מע"מ</p>}
    </div>
  );
}

export function poLinesBody(lines: PoLineDraft[]) {
  const out = lines.map((l) => ({ productId: l.product.id, qtyMilli: parseQty(l.qty), unitCostAgorot: parseShekels(l.cost || '0') }));
  if (out.some((l) => !l.qtyMilli || l.unitCostAgorot == null)) throw new Error('כמות או עלות לא תקינה באחת השורות');
  return out;
}

function NewPoModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const s = useSession();
  const sups = useLoad(() => api.get('/suppliers'), []);
  const [supplierId, setSupplierId] = useState('');
  const [branchId, setBranchId] = useState(defaultBranch(s));
  const [expectedAt, setExpectedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<PoLineDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post('/purchase-orders', { supplierId, branchId, expectedAt: expectedAt || null, notes: notes || null, lines: poLinesBody(lines) });
      showToast(`הזמנה ${r.number} נוצרה כטיוטה`); onDone(r.id);
    } catch (e) { showError(e); setBusy(false); }
  };
  const active = (sups.data ?? []).filter((x: any) => x.active);
  return (
    <Modal title="הזמנת רכש חדשה" size="wide" onClose={onClose} footer={<><button type="button" className="action-btn" disabled={busy || !supplierId || !lines.length} onClick={save}>שמירת טיוטה</button><button type="button" className="action-btn ghost" onClick={onClose}>ביטול</button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="ספק"><select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">בחירה…</option>{active.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Field label="סניף"><BranchSelect value={branchId} onChange={setBranchId} allowAll={false} /></Field>
          <Field label="צפי אספקה"><input type="date" value={expectedAt} min={todayIL()} onChange={(e) => setExpectedAt(e.target.value)} /></Field>
          <Field label="הערות"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        {sups.data && active.length === 0 && <div className="notice"><Icon name="alert" size={18} />אין ספקים פעילים. צריך להוסיף ספק בלשונית "ספקים".</div>}
        <PoLinesEditor lines={lines} setLines={setLines} />
      </div>
    </Modal>
  );
}

function GrTab() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const list = useLoad(() => api.get('/goods-receipts'), []);
  const phase = loadPhase(list);
  const recv = can('inventory:receive');
  return (
    <>
      <div className="toolbar"><span className="grow muted small">קליטה מהזמנה — מתוך מסך ההזמנה. כאן: קליטה ישירה בלי הזמנה (דורשת סיבה).</span>
        {recv && <button type="button" className="action-btn inline secondary" onClick={() => setOpen(true)}><Icon name="plus" size={18} />קליטה בלי הזמנה</button>}</div>
      {phase === 'loading' && <Skeleton rows={5} />}
      {phase === 'error' && <LoadError error={list.error} what="הקליטות" onRetry={list.reload} />}
      {phase === 'empty' && <EmptyState icon="truck" title="עוד אין קליטות" text="קליטה נפתחת מתוך הזמנת רכש מאושרת, או ישירה עם סיבה" />}
      {phase === 'ready' && (
        <DataTable rows={list.data} rowKey={(r: any) => r.id} onRowClick={(r: any) => nav(`/purchasing/receipts/${r.id}`)} columns={[
          { key: 'n', label: 'קליטה', primary: true, value: (r: any) => r.number, render: (r: any) => `קליטה ${r.number}` },
          { key: 'sup', label: 'ספק', value: (r: any) => r.supplier_name },
          { key: 'st', label: 'סטטוס', render: (r: any) => <Badge tone={GR_STATUS[r.status]?.tone}>{GR_STATUS[r.status]?.label ?? r.status}</Badge> },
          { key: 'po', label: 'הזמנה', render: (r: any) => (r.po_number ? `#${r.po_number}` : 'ישירה') },
          { key: 'ref', label: 'תעודת ספק', render: (r: any) => r.supplier_doc_ref ?? '—', hideOnCard: true },
          { key: 'at', label: 'נקלטה', render: (r: any) => (r.posted_at ? dateTime(r.posted_at) : '—'), hideOnCard: true },
          { key: 'total', label: 'סכום', num: true, value: (r: any) => Number(r.total_agorot), render: (r: any) => money(Number(r.total_agorot)) },
        ]} />
      )}
      {open && <DirectReceiptModal onClose={() => setOpen(false)} onDone={(id) => nav(`/purchasing/receipts/${id}`)} />}
    </>
  );
}

function DirectReceiptModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const s = useSession();
  const sups = useLoad(() => api.get('/suppliers'), []);
  const [supplierId, setSupplierId] = useState('');
  const [branchId, setBranchId] = useState(defaultBranch(s));
  const [reason, setReason] = useState('');
  const [ref, setRef] = useState('');
  const go = async () => {
    try { const r = await api.post('/goods-receipts', { supplierId, branchId, reason, supplierDocRef: ref || null, lines: [] }); onDone(r.id); } catch (e) { showError(e); }
  };
  return (
    <Modal title="קליטה בלי הזמנה" onClose={onClose} footer={<><button type="button" className="action-btn" disabled={!supplierId || reason.trim().length < 2} onClick={go}>פתיחת קליטה</button><button type="button" className="action-btn ghost" onClick={onClose}>ביטול</button></>}>
      <div className="stack">
        <Field label="ספק"><select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">בחירה…</option>{(sups.data ?? []).filter((x: any) => x.active).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="סניף"><BranchSelect value={branchId} onChange={setBranchId} allowAll={false} /></Field>
        <Field label="סיבה" hint="חובה בקליטה בלי הזמנה"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="למשל: אספקה דחופה בטלפון" /></Field>
        <Field label="מספר תעודת משלוח / חשבונית ספק"><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

const certExpired = (d: string | null) => !!d && d < todayIL();

function SuppliersTab() {
  const list = useLoad(() => api.get('/suppliers'), []);
  const phase = loadPhase(list);
  const [edit, setEdit] = useState<any>(null);
  const write = can('purchase:write');
  return (
    <>
      {write && <div className="toolbar"><span className="grow" /><button type="button" className="action-btn inline" onClick={() => setEdit({})}><Icon name="plus" size={18} />ספק חדש</button></div>}
      {phase === 'loading' && <Skeleton rows={4} />}
      {phase === 'error' && <LoadError error={list.error} what="הספקים" onRetry={list.reload} />}
      {phase === 'empty' && <EmptyState icon="building" title="עוד אין ספקים" action={write ? { label: 'ספק חדש', onClick: () => setEdit({}), primary: true } : null} />}
      {phase === 'ready' && (
        <DataTable rows={list.data} rowKey={(r: any) => r.id} onRowClick={write ? (r: any) => setEdit(r) : undefined} columns={[
          { key: 'name', label: 'ספק', primary: true, value: (r: any) => r.name, render: (r: any) => <span>{r.name}{!r.active && <> <Badge>לא פעיל</Badge></>}</span> },
          { key: 'tax', label: 'ע.מ./ח.פ.', render: (r: any) => r.tax_id ?? '—', muted: true },
          { key: 'contact', label: 'איש קשר', render: (r: any) => [r.contact_name, r.phone].filter(Boolean).join(' · ') || '—' },
          { key: 'terms', label: 'תנאי תשלום', render: (r: any) => r.payment_terms ?? '—', hideOnCard: true },
          { key: 'wh', label: 'ניכוי במקור', render: (r: any) => (r.withholding_cert_until ? <Badge tone={certExpired(r.withholding_cert_until) ? 'danger' : 'ok'}>{certExpired(r.withholding_cert_until) ? 'אישור פג' : `עד ${dateOnly(r.withholding_cert_until)}`}</Badge> : <Badge tone="warn">אין אישור</Badge>) },
          { key: 'open', label: 'הזמנות פתוחות', num: true, value: (r: any) => r.open_orders },
        ]} />
      )}
      {edit && <SupplierModal s={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); list.reload(); }} />}
    </>
  );
}

function SupplierModal({ s, onClose, onDone }: { s: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    name: s.name ?? '', taxId: s.tax_id ?? '', contactName: s.contact_name ?? '', phone: s.phone ?? '', email: s.email ?? '', address: s.address ?? '',
    paymentTerms: s.payment_terms ?? '', withholdingCertUntil: s.withholding_cert_until ?? '', withholdingRate: s.withholding_rate_bp != null ? String(s.withholding_rate_bp / 100) : '', active: s.active ?? true,
  });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    if (f.taxId && !isValidIsraeliId(f.taxId)) { setErrs({ taxId: 'מספר עוסק לא תקין' }); return; }
    const body = {
      name: f.name.trim(), taxId: f.taxId || null, contactName: f.contactName || null, phone: f.phone || null, email: f.email || '', address: f.address || null,
      paymentTerms: f.paymentTerms || null, withholdingCertUntil: f.withholdingCertUntil || null,
      withholdingRateBp: f.withholdingRate ? Math.round(Number(f.withholdingRate) * 100) : null, active: f.active,
    };
    try {
      if (s.id) await api.put(`/suppliers/${s.id}`, body); else await api.post('/suppliers', body);
      showToast('הספק נשמר'); onDone();
    } catch (e) { if (e instanceof ApiError) setErrs(e.fieldErrors ?? {}); showError(e); }
  };
  return (
    <Modal title={s.id ? s.name : 'ספק חדש'} size="wide" onClose={onClose} footer={<><button type="button" className="action-btn" disabled={!f.name.trim()} onClick={save}>שמירה</button><button type="button" className="action-btn ghost" onClick={onClose}>ביטול</button></>}>
      <div className="form-grid">
        <Field label="שם הספק" error={errs.name}><input value={f.name} onChange={set('name')} /></Field>
        <Field label="ע.מ. / ח.פ." error={errs.taxId}><input value={f.taxId} onChange={set('taxId')} inputMode="numeric" dir="ltr" /></Field>
        <Field label="איש קשר"><input value={f.contactName} onChange={set('contactName')} /></Field>
        <Field label="טלפון"><input value={f.phone} onChange={set('phone')} inputMode="tel" dir="ltr" /></Field>
        <Field label="אימייל" error={errs.email}><input type="email" value={f.email} onChange={set('email')} dir="ltr" /></Field>
        <Field label="כתובת"><input value={f.address} onChange={set('address')} /></Field>
        <Field label="תנאי תשלום"><input value={f.paymentTerms} onChange={set('paymentTerms')} placeholder="שוטף + 30" /></Field>
        <Field label="אישור ניכוי מס במקור — בתוקף עד" hint={certExpired(f.withholdingCertUntil) ? 'האישור פג — לבקש אישור מעודכן מהספק' : 'ריק = אין אישור, ינוכה בשיעור המלא'}>
          <input type="date" value={f.withholdingCertUntil} onChange={set('withholdingCertUntil')} />
        </Field>
        <Field label="שיעור ניכוי (%)"><input value={f.withholdingRate} onChange={set('withholdingRate')} inputMode="decimal" dir="ltr" /></Field>
        <label className="check-row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />ספק פעיל</label>
      </div>
    </Modal>
  );
}
