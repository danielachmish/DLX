// קליטת סחורה (WF-02, RCV-01..RCV-08): סריקה, כמויות, עלות, פגום, התאמה לחשבונית ספק ואישור למלאי
import { parseQty, parseShekels } from '@dlx/core';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Icon from '../components/Icon';
import NumPad from '../components/NumPad';
import { ActionBar, Badge, Card, EmptyState, Field, LoadError, Modal, PageHeader, Skeleton } from '../components/ui';
import { api, ApiError, qs } from '../lib/api';
import { askConfirm } from '../lib/dialogs';
import { dateTime, money, qty, toShekelInput } from '../lib/format';
import { useBarcodeScanner } from '../lib/misc';
import { showError, showToast } from '../lib/toast';
import { useLoad } from '../lib/useLoad';
import { GR_STATUS } from './office/shared';
import '../styles/office.css';

interface Line { productId: string; poLineId: string | null; name: string; sku: string; qtyMilli: number; unitCostAgorot: number; condition: 'ok' | 'damaged' }

const fromApi = (l: any): Line => ({ productId: l.product_id, poLineId: l.po_line_id, name: l.name, sku: l.sku, qtyMilli: l.qty_milli, unitCostAgorot: l.unit_cost_agorot, condition: l.condition });

export default function ReceiptView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: gr, error, loading, reload, setData } = useLoad(() => api.get(`/goods-receipts/${id}`), [id]);
  const [lines, setLines] = useState<Line[]>([]);
  const [ref, setRef] = useState('');
  const [invoice, setInvoice] = useState('');
  const [dirty, setDirty] = useState(false);
  const [code, setCode] = useState('');
  const [editQty, setEditQty] = useState<number | null>(null);
  const [variance, setVariance] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const posted = gr?.status === 'posted';

  useEffect(() => {
    if (!gr) return;
    setLines(gr.lines.map(fromApi));
    setRef(gr.supplier_doc_ref ?? '');
    setInvoice(gr.supplier_invoice_total_agorot != null ? toShekelInput(gr.supplier_invoice_total_agorot) : '');
    setDirty(false);
  }, [gr]);

  const change = (next: Line[]) => { setLines(next); setDirty(true); };
  const total = lines.reduce((a, l) => a + Math.round((l.qtyMilli * l.unitCostAgorot) / 1000), 0);

  const scan = async (raw: string) => {
    const c = raw.trim();
    if (!c || posted) return;
    setCode('');
    try {
      const r = await api.get(`/products/lookup${qs({ code: c, branchId: gr.branch_id })}`);
      const i = lines.findIndex((l) => l.productId === r.product.id && l.condition === 'ok');
      if (i >= 0) change(lines.map((l, j) => (j === i ? { ...l, qtyMilli: l.qtyMilli + r.qtyMilli } : l)));
      else change([...lines, { productId: r.product.id, poLineId: null, name: r.product.name, sku: r.product.sku, qtyMilli: r.qtyMilli, unitCostAgorot: r.product.cost_agorot ?? 0, condition: 'ok' }]);
      showToast(`${r.product.name} +${qty(r.qtyMilli)}`);
    } catch (e) { showError(e instanceof ApiError && e.status === 404 ? `לא נמצא מוצר לברקוד ${c}` : e); }
    inputRef.current?.focus();
  };
  useBarcodeScanner(scan, !!gr && !posted);

  const save = async () => {
    const inv = invoice ? parseShekels(invoice) : null;
    if (invoice && inv == null) { showError('סכום חשבונית לא תקין'); return false; }
    try {
      setData(await api.put(`/goods-receipts/${id}`, {
        lines: lines.map((l) => ({ productId: l.productId, poLineId: l.poLineId, qtyMilli: l.qtyMilli, unitCostAgorot: l.unitCostAgorot, condition: l.condition })),
        supplierDocRef: ref || null, supplierInvoiceTotalAgorot: inv,
      }));
      showToast('נשמר'); return true;
    } catch (e) { showError(e); return false; }
  };

  const post = async (allowOver = false): Promise<void> => {
    if (dirty && !(await save())) return;
    if (!allowOver && !(await askConfirm({ title: 'לקלוט למלאי?', text: `${lines.length} שורות בסך ${money(total)} לפני מע"מ. אחרי האישור אי אפשר לערוך.`, confirmLabel: 'קליטה למלאי' }))) return;
    try {
      const r = await api.post(`/goods-receipts/${id}/post`, { allowOver });
      setVariance(r.invoice_variance_agorot ?? null);
      setData(r); showToast('הסחורה נקלטה למלאי');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'over_receipt') {
        if (await askConfirm({ title: 'כמות גדולה מההזמנה', text: `${e.message}\nלקלוט בכל זאת? (דורש הרשאת מנהל)`, confirmLabel: 'קליטה עם חריגה' })) return post(true);
      } else showError(e);
    }
  };

  if (loading && !gr) return <><PageHeader title="קליטה" back /><Skeleton variant="card" /></>;
  if (error && !gr) return <><PageHeader title="קליטה" back /><LoadError error={error} what="הקליטה" onRetry={reload} /></>;
  const st = GR_STATUS[gr.status];
  const invAg = invoice ? parseShekels(invoice) : null;
  const diff = posted ? (variance ?? (gr.supplier_invoice_total_agorot != null ? gr.supplier_invoice_total_agorot - gr.total_agorot : null)) : invAg != null ? invAg - total : null;

  return (
    <div className="stack">
      <PageHeader title={`קליטה ${gr.number}`} sub={`${gr.supplier_name}${gr.po_number ? ` · הזמנה ${gr.po_number}` : ' · בלי הזמנה'} · ${st?.label ?? gr.status}`}
        onBack={() => (gr.po_id ? nav(`/purchasing/po/${gr.po_id}`) : nav('/purchasing'))} />
      {gr.reason && <div className="notice info"><Icon name="note" size={18} />סיבה: {gr.reason}</div>}

      {!posted && (
        <Card title="סריקה" icon="scan">
          <form className="scan-box" onSubmit={(e) => { e.preventDefault(); scan(code); }}>
            <input ref={inputRef} value={code} onChange={(e) => setCode(e.target.value)} placeholder="סריקת פריט שהגיע" inputMode="numeric" aria-label="ברקוד" />
            <button className="action-btn inline">הוספה</button>
          </form>
        </Card>
      )}

      <Card title="פרטי ספק" icon="building">
        <div className="form-grid">
          <Field label="מספר תעודת משלוח / חשבונית"><input value={ref} disabled={posted} onChange={(e) => { setRef(e.target.value); setDirty(true); }} /></Field>
          <Field label='סה"כ בחשבונית הספק (₪, לפני מע"מ)' hint="להתאמה מול הקליטה — לא חוסם"><input value={invoice} disabled={posted} inputMode="decimal" dir="ltr" onChange={(e) => { setInvoice(e.target.value); setDirty(true); }} /></Field>
        </div>
        <dl className="kv mt">
          <dt>סה"כ קליטה</dt><dd>{money(posted ? gr.total_agorot : total)}</dd>
          {diff != null && <><dt>הפרש מול חשבונית</dt><dd>{diff === 0 ? <Badge tone="ok">תואם</Badge> : <Badge tone="warn">{money(diff)}</Badge>}</dd></>}
          {posted && <><dt>נקלטה</dt><dd>{dateTime(gr.posted_at)}</dd></>}
        </dl>
      </Card>

      {lines.length === 0 ? <EmptyState icon="scan" title="עוד אין פריטים בקליטה" text="סורקים כל פריט שהגיע, או מזינים כמות לכל שורה" /> : (
        <div className="stack">
          {lines.map((l, i) => (
            <div key={`${l.productId}:${l.condition}:${i}`} className="dt-card">
              <div className="dt-card-top"><b>{l.name}</b>{l.condition === 'damaged' && <Badge tone="danger">פגום</Badge>}</div>
              <div className="row-gap">
                <button type="button" className="action-btn secondary inline small" disabled={posted} onClick={() => setEditQty(i)}>כמות: {qty(l.qtyMilli)}</button>
                <label className="row-gap small">עלות ₪
                  <input className="qty-input" disabled={posted} defaultValue={toShekelInput(l.unitCostAgorot)} inputMode="decimal" dir="ltr" aria-label="עלות ליחידה"
                    onBlur={(e) => { const a = parseShekels(e.target.value); if (a != null && a !== l.unitCostAgorot) change(lines.map((x, j) => (j === i ? { ...x, unitCostAgorot: a } : x))); }} />
                </label>
                <select value={l.condition} disabled={posted} aria-label="מצב" onChange={(e) => change(lines.map((x, j) => (j === i ? { ...x, condition: e.target.value as Line['condition'] } : x)))}>
                  <option value="ok">תקין</option><option value="damaged">פגום (לא למכירה)</option>
                </select>
                {!posted && <button type="button" className="icon-btn right" aria-label="הסרת שורה" onClick={() => change(lines.filter((_, j) => j !== i))}><Icon name="trash" size={18} /></button>}
              </div>
              <div className="dt-card-row"><span>{l.sku}</span><span className="money">{money(Math.round((l.qtyMilli * l.unitCostAgorot) / 1000))}</span></div>
            </div>
          ))}
        </div>
      )}

      {!posted && (
        <ActionBar>
          <button type="button" className="action-btn" disabled={!lines.length} onClick={() => post()}>קליטה למלאי</button>
          {dirty && <button type="button" className="action-btn secondary" onClick={save}>שמירה</button>}
        </ActionBar>
      )}

      {editQty != null && lines[editQty] && (
        <QtyModal line={lines[editQty]!} onClose={() => setEditQty(null)} onSave={(m) => { change(lines.map((x, j) => (j === editQty ? { ...x, qtyMilli: m } : x))); setEditQty(null); }} />
      )}
    </div>
  );
}

function QtyModal({ line, onClose, onSave }: { line: Line; onClose: () => void; onSave: (m: number) => void }) {
  const [v, setV] = useState(qty(line.qtyMilli));
  const ok = () => { const m = parseQty(v); if (!m) showError('כמות לא תקינה'); else onSave(m); };
  return <Modal title={line.name} onClose={onClose}><NumPad value={v} onChange={setV} decimals={3} onEnter={ok} enterLabel="שמירה" /></Modal>;
}
