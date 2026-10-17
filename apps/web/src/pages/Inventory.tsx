// מלאי (S12, INV-01..INV-07): יתרות לפי סניף, יומן תנועות, ספירות, התאמה והעברה בין סניפים
import { parseQty } from '@dlx/core';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable';
import Icon from '../components/Icon';
import { Badge, Card, EmptyState, Field, LoadError, Modal, PageHeader, Skeleton, Tabs } from '../components/ui';
import { api, qs } from '../lib/api';
import { dateTime, money, qty } from '../lib/format';
import { useSavedState } from '../lib/misc';
import { can, useSession } from '../lib/session';
import { showError, showToast } from '../lib/toast';
import { loadPhase, useLoad } from '../lib/useLoad';
import { BranchSelect, COUNT_STATUS, defaultBranch, LOCATION_LABEL, type PickedProduct, ProductPicker, SOURCE_LABEL, UNIT_LABEL } from './office/shared';
import '../styles/office.css';

export default function Inventory() {
  const [sp] = useSearchParams();
  const [tab, setTab] = useSavedState('invTab', 'stock');
  // הגעה מ"מלאי נמוך" בלוח הבקרה — תמיד ליתרות
  useEffect(() => { if (sp.get('low')) setTab('stock'); }, []);
  const tabs = [
    { key: 'stock', label: 'יתרות', icon: 'box' },
    { key: 'moves', label: 'תנועות', icon: 'history' },
    { key: 'counts', label: 'ספירות', icon: 'list' },
    ...(can('stock:approve') ? [{ key: 'adjust', label: 'התאמה והעברה', icon: 'swap' }] : []),
  ];
  return (
    <div>
      <PageHeader sub="היתרה היא תמיד סכום התנועות — אין עריכה ישירה של מלאי" />
      <Tabs items={tabs} value={tab} onChange={setTab} />
      {tab === 'stock' && <StockTab initialLow={sp.get('low') === '1'} />}
      {tab === 'moves' && <MovesTab />}
      {tab === 'counts' && <CountsTab />}
      {tab === 'adjust' && <AdjustTab />}
    </div>
  );
}

function StockTab({ initialLow }: { initialLow: boolean }) {
  const s = useSession();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [low, setLow] = useState(initialLow);
  const [branchId, setBranchId] = useState(s?.user.branchId ?? '');
  const costs = can('costs:read');
  const list = useLoad(() => api.get(`/stock/availability${qs({ q: q.trim() || undefined, low: low || undefined, branchId: branchId || undefined, limit: 500 })}`), [q, low, branchId]);
  const phase = loadPhase(list);
  const multi = (s?.branches.length ?? 0) > 1 && !branchId;
  return (
    <>
      <div className="toolbar">
        <div className="search-box grow flush"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder='חיפוש מוצר לפי שם או מק"ט' aria-label="חיפוש" /></div>
        <BranchSelect value={branchId} onChange={setBranchId} />
        <button type="button" className={'chip-f' + (low ? ' on' : '')} onClick={() => setLow(!low)} aria-pressed={low}>מלאי נמוך בלבד</button>
      </div>
      {phase === 'loading' && <Skeleton rows={6} />}
      {phase === 'error' && <LoadError error={list.error} what="יתרות המלאי" onRetry={list.reload} />}
      {phase === 'empty' && (low ? <EmptyState icon="check" title="אין מוצרים מתחת למינימום" /> : <EmptyState icon="box" title="אין מוצרים עם ניהול מלאי" action={{ label: 'למוצרים', onClick: () => nav('/products') }} />)}
      {phase === 'ready' && (
        <DataTable rows={list.data} rowKey={(r: any) => `${r.product_id}:${r.branch_id}`} onRowClick={(r: any) => nav(`/products/${r.product_id}`)} columns={[
          { key: 'name', label: 'מוצר', primary: true, value: (r: any) => r.name },
          { key: 'sku', label: 'מק"ט', muted: true, value: (r: any) => r.sku },
          ...(multi ? [{ key: 'branch', label: 'סניף', value: (r: any) => r.branch_name }] : []),
          { key: 'status', label: 'מצב', render: (r: any) => (r.on_hand < 0 ? <Badge tone="danger">שלילי</Badge> : r.on_hand <= r.min_stock_milli ? <Badge tone="warn">נמוך</Badge> : <Badge tone="ok">תקין</Badge>) },
          { key: 'damaged', label: 'פגום', num: true, hideOnCard: true, render: (r: any) => (r.damaged ? qty(r.damaged) : '—') },
          ...(costs ? [{ key: 'value', label: 'שווי', num: true, hideOnCard: true, value: (r: any) => (r.on_hand * r.cost_agorot) / 1000, render: (r: any) => money(Math.round((r.on_hand * r.cost_agorot) / 1000)) }] : []),
          { key: 'on_hand', label: 'במלאי', num: true, value: (r: any) => r.on_hand, render: (r: any) => `${qty(r.on_hand)} ${UNIT_LABEL[r.unit_measure] ?? ''}` },
        ]} />
      )}
    </>
  );
}

function MovesTab() {
  const s = useSession();
  const [branchId, setBranchId] = useState(s?.user.branchId ?? '');
  const [sourceType, setSourceType] = useState('');
  const [picked, setPicked] = useState<PickedProduct | null>(null);
  const list = useLoad(() => api.get(`/stock/movements${qs({ branchId: branchId || undefined, sourceType: sourceType || undefined, productId: picked?.id, limit: 300 })}`), [branchId, sourceType, picked?.id]);
  const phase = loadPhase(list);
  return (
    <>
      <div className="toolbar">
        <div className="grow">{picked ? <span className="chip-f on">{picked.name} <button type="button" className="icon-btn plain" aria-label="ניקוי" onClick={() => setPicked(null)}><Icon name="x" size={14} /></button></span> : <ProductPicker onPick={setPicked} placeholder="סינון לפי מוצר" />}</div>
        <BranchSelect value={branchId} onChange={setBranchId} />
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value)} aria-label="סוג תנועה">
          <option value="">כל סוגי התנועות</option>
          {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {phase === 'loading' && <Skeleton rows={6} />}
      {phase === 'error' && <LoadError error={list.error} what="התנועות" onRetry={list.reload} />}
      {phase === 'empty' && <EmptyState icon="history" title="אין תנועות לסינון הזה" />}
      {phase === 'ready' && (
        <DataTable rows={list.data} rowKey={(m: any) => String(m.id)} columns={[
          { key: 'name', label: 'מוצר', primary: true, value: (m: any) => m.name },
          { key: 'at', label: 'מתי', render: (m: any) => dateTime(m.created_at) },
          { key: 'src', label: 'סוג', render: (m: any) => <Badge tone={m.qty_delta_milli > 0 ? 'ok' : undefined}>{SOURCE_LABEL[m.source_type] ?? m.source_type}</Badge> },
          { key: 'loc', label: 'מיקום', render: (m: any) => LOCATION_LABEL[m.location] ?? m.location, hideOnCard: true },
          { key: 'branch', label: 'סניף', value: (m: any) => m.branch_name, hideOnCard: true },
          { key: 'who', label: 'מי', render: (m: any) => m.actor_name ?? '—', hideOnCard: true },
          { key: 'reason', label: 'סיבה', render: (m: any) => m.reason ?? '—', muted: true },
          { key: 'qty', label: 'כמות', num: true, render: (m: any) => `${m.qty_delta_milli > 0 ? '+' : ''}${qty(m.qty_delta_milli)}` },
        ]} />
      )}
    </>
  );
}

function CountsTab() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const list = useLoad(() => api.get('/inventory-counts'), []);
  const phase = loadPhase(list);
  const canCount = can('stock:count');
  return (
    <>
      {canCount && <div className="toolbar"><span className="grow muted small">ספירה שומרת את היתרה הצפויה ברגע הפתיחה. מכירות בזמן הספירה לא נדרסות.</span>
        <button type="button" className="action-btn inline" onClick={() => setOpen(true)}><Icon name="plus" size={18} />ספירה חדשה</button></div>}
      {phase === 'loading' && <Skeleton rows={4} />}
      {phase === 'error' && <LoadError error={list.error} what="הספירות" onRetry={list.reload} />}
      {phase === 'empty' && <EmptyState icon="list" title="עוד לא נפתחו ספירות" action={canCount ? { label: 'ספירה חדשה', onClick: () => setOpen(true), primary: true } : null} />}
      {phase === 'ready' && (
        <DataTable rows={list.data} rowKey={(c: any) => c.id} onRowClick={(c: any) => nav(`/inventory/counts/${c.id}`)} columns={[
          { key: 'number', label: 'ספירה', primary: true, value: (c: any) => c.number, render: (c: any) => `ספירה ${c.number}` },
          { key: 'status', label: 'סטטוס', render: (c: any) => <Badge tone={COUNT_STATUS[c.status]?.tone}>{COUNT_STATUS[c.status]?.label ?? c.status}</Badge> },
          { key: 'branch', label: 'סניף', value: (c: any) => c.branch_name },
          { key: 'scope', label: 'היקף', render: (c: any) => c.scope ?? '—', muted: true },
          { key: 'at', label: 'נפתחה', render: (c: any) => dateTime(c.created_at), hideOnCard: true },
          { key: 'progress', label: 'נספרו', num: true, render: (c: any) => `${c.counted} / ${c.lines}` },
        ]} />
      )}
      {open && <NewCountModal onClose={() => setOpen(false)} onDone={(id) => nav(`/inventory/counts/${id}`)} />}
    </>
  );
}

function NewCountModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const s = useSession();
  const [branchId, setBranchId] = useState(defaultBranch(s));
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const cats = useLoad(() => api.get('/categories'), []);
  const go = async () => {
    setBusy(true);
    try { const r = await api.post('/inventory-counts', { branchId, category: category || undefined }); onDone(r.id); } catch (e) { showError(e); setBusy(false); }
  };
  return (
    <Modal title="ספירה חדשה" onClose={onClose} footer={<><button type="button" className="action-btn" disabled={busy || !branchId} onClick={go}>פתיחת ספירה</button><button type="button" className="action-btn ghost" onClick={onClose}>ביטול</button></>}>
      <div className="stack">
        <Field label="סניף"><BranchSelect value={branchId} onChange={setBranchId} allowAll={false} /></Field>
        <Field label="היקף" hint="ריק = כל המוצרים עם ניהול מלאי">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">ספירה מלאה</option>
            {(cats.data ?? []).map((c: any) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

interface Line { product: PickedProduct; qty: string }

function LinesEditor({ lines, setLines, signed = false }: { lines: Line[]; setLines: (l: Line[]) => void; signed?: boolean }) {
  return (
    <div className="line-editor">
      <ProductPicker onPick={(p) => { if (!lines.some((l) => l.product.id === p.id)) setLines([...lines, { product: p, qty: signed ? '-1' : '1' }]); }} />
      {lines.map((l, i) => (
        <div key={l.product.id} className="line-row">
          <span className="nm">{l.product.name}<small>{l.product.sku}</small></span>
          <input className="qty-input" value={l.qty} inputMode="decimal" aria-label="כמות" dir="ltr"
            onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
          <span className="cost muted small">{signed ? 'חיובי = הוספה, שלילי = הורדה' : ''}</span>
          <button type="button" className="icon-btn" aria-label="הסרה" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Icon name="trash" size={18} /></button>
        </div>
      ))}
    </div>
  );
}

const signedQty = (v: string) => {
  const t = v.trim();
  const neg = t.startsWith('-');
  const q = parseQty(neg ? t.slice(1) : t.replace(/^\+/, ''));
  return q == null ? null : neg ? -q : q;
};

function AdjustTab() {
  const s = useSession();
  const [branchId, setBranchId] = useState(defaultBranch(s));
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('sale');
  const [lines, setLines] = useState<Line[]>([]);
  const [from, setFrom] = useState(defaultBranch(s));
  const [to, setTo] = useState(s?.branches.find((b) => b.id !== defaultBranch(s))?.id ?? '');
  const [tLines, setTLines] = useState<Line[]>([]);

  const adjust = async () => {
    const out = lines.map((l) => ({ productId: l.product.id, qtyDeltaMilli: signedQty(l.qty), location }));
    if (out.some((l) => !l.qtyDeltaMilli)) { showError('כמות לא תקינה'); return; }
    if (reason.trim().length < 2) { showError('צריך סיבה להתאמה'); return; }
    try { await api.post('/stock/adjustments', { branchId, reason: reason.trim(), lines: out }); showToast('ההתאמה נרשמה'); setLines([]); setReason(''); } catch (e) { showError(e); }
  };
  const transfer = async () => {
    const out = tLines.map((l) => ({ productId: l.product.id, qtyMilli: parseQty(l.qty) }));
    if (out.some((l) => !l.qtyMilli)) { showError('כמות לא תקינה'); return; }
    try { await api.post('/stock/transfers', { fromBranchId: from, toBranchId: to, lines: out }); showToast('ההעברה נרשמה'); setTLines([]); } catch (e) { showError(e); }
  };
  const multi = (s?.branches.length ?? 0) > 1;

  return (
    <div className="split">
      <Card title="התאמת מלאי" icon="edit">
        <p className="section-sub">רק עם סיבה (פחת, גניבה, תיקון טעות). כל התאמה נרשמת ביומן הביקורת.</p>
        <div className="stack">
          <div className="form-grid">
            <Field label="סניף"><BranchSelect value={branchId} onChange={setBranchId} allowAll={false} /></Field>
            <Field label="מיקום"><select value={location} onChange={(e) => setLocation(e.target.value)}><option value="sale">למכירה</option><option value="damaged">פגום</option></select></Field>
          </div>
          <Field label="סיבה"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="למשל: פחת — פג תוקף" /></Field>
          <LinesEditor lines={lines} setLines={setLines} signed />
          <div className="form-actions"><button type="button" className="action-btn" disabled={!lines.length} onClick={adjust}>רישום התאמה</button></div>
        </div>
      </Card>
      {multi && (
        <Card title="העברה בין סניפים" icon="truck">
          <div className="stack">
            <div className="form-grid">
              <Field label="מסניף"><BranchSelect value={from} onChange={setFrom} allowAll={false} /></Field>
              <Field label="לסניף"><select value={to} onChange={(e) => setTo(e.target.value)}>{s!.branches.filter((b) => b.id !== from).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            </div>
            <LinesEditor lines={tLines} setLines={setTLines} />
            <div className="form-actions"><button type="button" className="action-btn" disabled={!tLines.length || !to || from === to} onClick={transfer}>רישום העברה</button></div>
          </div>
        </Card>
      )}
    </div>
  );
}
