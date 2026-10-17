// מוצרים (S08, PRD-01..PRD-08): חיפוש וסריקה, קטגוריות, ייבוא CSV ומדבקות מדף (O-06, G-14)
import { RESTRICTION_LABEL, type Restriction } from '@dlx/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DataTable from '../components/DataTable';
import Icon from '../components/Icon';
import { Badge, EmptyState, LoadError, Modal, PageHeader, Skeleton, Tabs } from '../components/ui';
import { api, ApiError, qs } from '../lib/api';
import { askConfirm } from '../lib/dialogs';
import { money } from '../lib/format';
import { printHtml, useBarcodeScanner, useSavedState } from '../lib/misc';
import { can } from '../lib/session';
import { showError, showToast } from '../lib/toast';
import { loadPhase, useLoad } from '../lib/useLoad';
import { parseCsv } from './office/csv';
import { esc, printPage, TAX_LABEL } from './office/shared';
import '../styles/office.css';

export default function Products() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [cat, setCat] = useSavedState('prodCat', '');
  const [status, setStatus] = useSavedState('prodStatus', 'active');
  const [importing, setImporting] = useState(false);
  const [labels, setLabels] = useState(false);
  const cats = useLoad(() => api.get('/categories'), []);
  const list = useLoad(() => api.get(`/products${qs({ q: q.trim() || undefined, category: cat || undefined, status, limit: 300 })}`), [q, cat, status]);
  const phase = loadPhase(list);
  const write = can('catalog:write');

  // סריקה מכל מקום במסך — קפיצה לכרטיס המוצר
  useBarcodeScanner(async (code) => {
    try {
      const r = await api.get(`/products/lookup${qs({ code })}`);
      nav(`/products/${r.product.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && write) {
        if (await askConfirm({ title: `לא נמצא מוצר לברקוד ${code}`, text: 'ליצור מוצר חדש עם הברקוד הזה?', confirmLabel: 'מוצר חדש' })) nav(`/products/new?barcode=${encodeURIComponent(code)}`);
      } else showError(e);
    }
  });

  return (
    <div>
      <PageHeader sub="קטלוג, מחירים וברקודים" actions={<>
        {can('catalog:read') && <button type="button" className="action-btn secondary inline" onClick={() => setLabels(true)}><Icon name="printer" size={18} />מדבקות מדף</button>}
        {write && <button type="button" className="action-btn secondary inline" onClick={() => setImporting(true)}><Icon name="upload" size={18} />ייבוא</button>}
        {write && <button type="button" className="action-btn inline" onClick={() => nav('/products/new')}><Icon name="plus" size={18} />מוצר חדש</button>}
      </>} />
      <div className="search-box">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder='חיפוש לפי שם, מק"ט או ברקוד (אפשר גם לסרוק)' aria-label="חיפוש מוצר" />
      </div>
      <div className="toolbar">
        <div className="chips grow">
          <button type="button" className={'chip-f' + (!cat ? ' on' : '')} onClick={() => setCat('')}>הכל</button>
          {(cats.data ?? []).map((c: any) => <button key={c.id} type="button" className={'chip-f' + (cat === c.name ? ' on' : '')} onClick={() => setCat(c.name)}>{c.name}</button>)}
        </div>
        <Tabs variant="seg" label="סטטוס" value={status} onChange={setStatus} items={[{ key: 'active', label: 'פעילים' }, { key: 'archived', label: 'בארכיון' }, { key: 'all', label: 'הכל' }]} />
      </div>
      {phase === 'loading' && <Skeleton rows={6} />}
      {phase === 'error' && <LoadError error={list.error} what="המוצרים" onRetry={list.reload} />}
      {phase === 'empty' && (q || cat
        ? <EmptyState icon="search" title={`לא נמצאו מוצרים${q ? ` ל"${q}"` : ''}`} action={{ label: 'ניקוי חיפוש', onClick: () => { setQ(''); setCat(''); } }} />
        : <EmptyState icon="tag" title="עוד אין מוצרים" text="אפשר להוסיף מוצר אחד או לייבא רשימה מקובץ" action={write ? { label: 'מוצר חדש', onClick: () => nav('/products/new'), primary: true } : null} />)}
      {phase === 'ready' && (
        <DataTable rows={list.data} rowKey={(p: any) => p.id} onRowClick={(p: any) => nav(`/products/${p.id}`)} columns={[
          { key: 'name', label: 'מוצר', primary: true, value: (p: any) => p.name, render: (p: any) => <span>{p.name}{p.status === 'archived' && <> <Badge>בארכיון</Badge></>}</span> },
          { key: 'sku', label: 'מק"ט', value: (p: any) => p.sku, muted: true },
          { key: 'category', label: 'קטגוריה', value: (p: any) => p.category ?? '', render: (p: any) => p.category ?? '—' },
          { key: 'tax', label: 'מע"מ', render: (p: any) => <Badge tone={p.tax_category === 'standard' ? undefined : 'info'}>{TAX_LABEL[p.tax_category]}</Badge>, hideOnCard: true },
          { key: 'restriction', label: 'הגבלה', render: (p: any) => (p.restriction === 'none' ? '—' : <Badge tone="warn">{RESTRICTION_LABEL[p.restriction as Restriction].split(' (')[0]}</Badge>) },
          { key: 'price', label: 'מחיר', num: true, value: (p: any) => p.price_agorot, render: (p: any) => money(p.price_agorot) },
        ]} />
      )}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => { setImporting(false); list.reload(); cats.reload(); }} />}
      {labels && <LabelsModal onClose={() => setLabels(false)} />}
    </div>
  );
}

const SAMPLE = 'sku,name,price,cost,barcode,category,taxCategory\n1001,חלב 3% 1 ליטר,6.90,4.80,7290004131074,מוצרי חלב,standard\n3001,עגבניות,9.90,5.50,,פירות וירקות,zero';

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [report, setReport] = useState<any>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const rows = text.trim() ? parseCsv(text) : [];
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await api.post('/products/import', { rows, dryRun });
      setReport(r);
      if (dryRun) setChecked(true);
      else { showToast(`נוספו ${r.created} מוצרים${r.failed ? `, ${r.failed} שורות נכשלו` : ''}`); if (!r.failed) onDone(); }
    } catch (e) { showError(e); } finally { setBusy(false); }
  };
  const onFile = async (f: File | undefined) => { if (f) { setText(await f.text()); setChecked(false); setReport(null); } };
  return (
    <Modal title="ייבוא מוצרים מקובץ" size="wide" onClose={onClose} footer={<>
      {!checked && <button type="button" className="action-btn" disabled={!rows.length || busy} onClick={() => run(true)}>בדיקת הקובץ ({rows.length} שורות)</button>}
      {checked && <button type="button" className="action-btn" disabled={busy || !report?.report?.some((r: any) => r.ok)} onClick={() => run(false)}>ייבוא השורות התקינות</button>}
      <button type="button" className="action-btn ghost" onClick={onClose}>סגירה</button>
    </>}>
      <p className="section-sub">עמודות: sku, name, price, cost, barcode, category, taxCategory (standard / zero / exempt). מחיר בשקלים, כולל מע"מ. שורה לא תקינה לא נוצרת.</p>
      <div className="row-gap mb">
        <label className="action-btn secondary inline"><Icon name="upload" size={18} />בחירת קובץ CSV<input type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => onFile(e.target.files?.[0])} /></label>
        <button type="button" className="action-btn ghost inline" onClick={() => { setText(SAMPLE); setChecked(false); setReport(null); }}>דוגמה</button>
      </div>
      <textarea className="csv-text" value={text} onChange={(e) => { setText(e.target.value); setChecked(false); setReport(null); }} placeholder="או הדביקו כאן את תוכן הקובץ" aria-label="תוכן CSV" />
      {report && (
        <div className="mt">
          <p><b>{report.report.filter((r: any) => r.ok).length}</b> תקינות · <b>{report.failed}</b> עם שגיאה</p>
          <div className="report-list">
            {report.report.filter((r: any) => !r.ok).map((r: any) => <div key={r.row} className="bad">שורה {r.row} ({r.sku || 'בלי מק"ט'}): {r.error}</div>)}
          </div>
        </div>
      )}
    </Modal>
  );
}

// G-14: מחיר ליחידת מידה על המדבקה, כשמוגדר בסיס ("ל-100 גרם") וכמות באריזה
function unitPrice(l: any) {
  if (!l.unit_price_basis || !l.unit_price_factor_milli) return '';
  return `${money(Math.round((l.new_price * 1000) / l.unit_price_factor_milli))} ${l.unit_price_basis}`;
}

function LabelsModal({ onClose }: { onClose: () => void }) {
  const { data, error, loading, reload } = useLoad(() => api.get('/labels/pending'), []);
  const phase = loadPhase({ data, error, loading });
  const print = async () => {
    const rows = data as any[];
    const body = `<div class="grid">${rows.map((l) => `<div class="lbl"><div class="nm">${esc(l.name)}</div><div class="pr">${esc(money(l.new_price))}</div>${unitPrice(l) ? `<div class="up">${esc(unitPrice(l))}</div>` : ''}<div class="bc">${esc(l.barcode ?? l.sku)}</div></div>`).join('')}</div>`;
    printHtml(printPage('מדבקות מדף', body, '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}.lbl{border:1px solid #000;border-radius:2mm;padding:3mm;break-inside:avoid}.nm{font-weight:600}.pr{font-size:20pt;font-weight:800;direction:ltr;text-align:right}.up{font-size:9pt}.bc{font-family:monospace;font-size:9pt;letter-spacing:1px}'));
    try {
      await api.post('/labels/printed', { productIds: [...new Set(rows.map((l) => l.product_id))] });
      showToast('המדבקות סומנו כהודפסו');
      reload();
    } catch (e) { showError(e); }
  };
  return (
    <Modal title="מדבקות מדף שממתינות להדפסה" size="wide" onClose={onClose} footer={<>
      <button type="button" className="action-btn" disabled={!data?.length} onClick={print}><Icon name="printer" size={18} />הדפסה וסימון</button>
      <button type="button" className="action-btn ghost" onClick={onClose}>סגירה</button>
    </>}>
      <p className="section-sub">מוצרים שהמחיר שלהם השתנה. מחיר על המדף שלא תואם לקופה — הלקוח משלם את הנמוך מביניהם.</p>
      {phase === 'loading' && <Skeleton variant="text" />}
      {phase === 'error' && <LoadError error={error} what="המדבקות" onRetry={reload} compact />}
      {phase === 'empty' && <EmptyState compact icon="check" title="כל המדבקות מעודכנות" />}
      {phase === 'ready' && (
        <ul className="list-plain">
          {(data as any[]).map((l) => <li key={l.id}><span>{l.name} <small className="muted">{unitPrice(l)}</small></span><span className="money">{money(l.new_price)}</span></li>)}
        </ul>
      )}
    </Modal>
  );
}
