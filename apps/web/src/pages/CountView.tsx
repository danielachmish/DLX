// ספירת מלאי (WF-05, INV-05, T27): סריקה רציפה בטלפון, הזנה ידנית, הפרשים, ואישור מנהל שמייצר תנועות התאמה
import { parseQty } from '@dlx/core';
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Icon from '../components/Icon';
import { ActionBar, Badge, Card, EmptyState, LoadError, Modal, PageHeader, Skeleton, StatCard, StatGrid, Tabs } from '../components/ui';
import NumPad from '../components/NumPad';
import { api, ApiError, qs } from '../lib/api';
import { askConfirm } from '../lib/dialogs';
import { dateTime, money, qty } from '../lib/format';
import { useBarcodeScanner } from '../lib/misc';
import { can } from '../lib/session';
import { showError, showToast } from '../lib/toast';
import { useLoad } from '../lib/useLoad';
import { COUNT_STATUS } from './office/shared';
import '../styles/office.css';

export default function CountView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: ic, error, loading, reload, setData } = useLoad(() => api.get(`/inventory-counts/${id}`), [id]);
  const [code, setCode] = useState('');
  const [filter, setFilter] = useState('all');
  const [edit, setEdit] = useState<any>(null);
  const [last, setLast] = useState<string>('');
  const inputRef = useRef<HTMLInputElement>(null);
  const editable = ic && (ic.status === 'open' || ic.status === 'counted');
  const manager = can('stock:approve');

  const putLines = async (lines: { productId: string; countedMilli: number }[], mode: 'add' | 'set') => {
    try { setData(await api.put(`/inventory-counts/${id}/lines`, { mode, lines })); return true; } catch (e) { showError(e); return false; }
  };

  // סריקה: כל סריקה מוסיפה את כמות הברקוד (קרטון = 12) או את המשקל מהמאזניים
  const scan = async (raw: string) => {
    const c = raw.trim();
    if (!c || !editable) return;
    setCode('');
    try {
      const r = await api.get(`/products/lookup${qs({ code: c, branchId: ic.branch_id })}`);
      if (await putLines([{ productId: r.product.id, countedMilli: r.qtyMilli }], 'add')) setLast(`${r.product.name} +${qty(r.qtyMilli)}`);
    } catch (e) {
      showError(e instanceof ApiError && e.status === 404 ? `לא נמצא מוצר לברקוד ${c}` : e);
    }
    inputRef.current?.focus();
  };
  useBarcodeScanner(scan, !!editable);

  const act = async (action: 'submit' | 'review' | 'reopen' | 'post') => {
    if (action === 'post') {
      const ok = await askConfirm({ title: 'לאשר את הספירה?', text: 'ההפרשים יירשמו כתנועות מלאי. אחרי אישור אי אפשר לערוך את הספירה.', confirmLabel: 'אישור ספירה' });
      if (!ok) return;
    }
    try { setData(await api.post(`/inventory-counts/${id}/${action}`)); showToast(action === 'post' ? 'הספירה אושרה והמלאי עודכן' : 'עודכן'); } catch (e) { showError(e); }
  };

  const lines = (ic?.lines ?? []) as any[];
  const counted = lines.filter((l) => l.counted_milli != null).length;
  const diffs = lines.filter((l) => l.diff_milli != null && l.diff_milli !== 0);
  const value = lines.some((l) => l.cost_agorot != null) ? diffs.reduce((a, l) => a + Math.round((l.diff_milli * (l.cost_agorot ?? 0)) / 1000), 0) : null;
  const shown = useMemo(() => lines.filter((l) => (filter === 'todo' ? l.counted_milli == null : filter === 'diff' ? l.diff_milli != null && l.diff_milli !== 0 : true)), [lines, filter]);

  if (loading && !ic) return <><PageHeader title="ספירה" back /><Skeleton variant="card" /></>;
  if (error && !ic) return <><PageHeader title="ספירה" back /><LoadError error={error} what="הספירה" onRetry={reload} /></>;
  const st = COUNT_STATUS[ic.status];

  return (
    <div className="stack">
      <PageHeader title={`ספירה ${ic.number}`} sub={`${ic.branch_name} · ${ic.scope ?? ''} · ${st?.label ?? ic.status}`} onBack={() => nav('/inventory')} />
      <StatGrid>
        <StatCard label="נספרו" value={`${counted} / ${lines.length}`} icon="list" tone={counted === lines.length ? 'ok' : 'warn'} />
        <StatCard label="שורות עם הפרש" value={diffs.length} icon="alert" tone={diffs.length ? 'warn' : 'ok'} />
        {value != null && <StatCard label="שווי ההפרש" value={money(value)} icon="coins" tone={value < 0 ? 'danger' : 'teal'} />}
        <StatCard label="צילום יתרה" value={dateTime(ic.snapshot_at)} icon="clock" />
      </StatGrid>
      <div className="count-progress" aria-hidden="true"><span style={{ width: `${lines.length ? (counted / lines.length) * 100 : 0}%` }} /></div>

      {editable && (
        <Card title="סריקה" icon="scan">
          <form className="scan-box" onSubmit={(e) => { e.preventDefault(); scan(code); }}>
            <input ref={inputRef} value={code} onChange={(e) => setCode(e.target.value)} placeholder="סריקה או הקלדת ברקוד" inputMode="numeric" autoFocus aria-label="ברקוד" />
            <button className="action-btn inline">הוספה</button>
          </form>
          {last && <p className="muted small mt"><Icon name="check" size={14} /> נוסף: {last}</p>}
        </Card>
      )}

      <Tabs variant="seg" label="סינון" value={filter} onChange={setFilter} items={[
        { key: 'all', label: `הכל (${lines.length})` }, { key: 'todo', label: `לא נספרו (${lines.length - counted})` }, { key: 'diff', label: `הפרשים (${diffs.length})` },
      ]} />
      {shown.length === 0 ? <EmptyState icon="check" title={filter === 'todo' ? 'הכל נספר' : filter === 'diff' ? 'אין הפרשים' : 'אין שורות'} /> : (
        <div className="stack">
          {shown.map((l) => (
            <button key={l.id} type="button" className="dt-card" disabled={!editable} onClick={() => setEdit(l)}>
              <div className="dt-card-top"><b>{l.name}</b>
                {l.counted_milli == null ? <Badge>לא נספר</Badge> : l.diff_milli === 0 ? <Badge tone="ok">תואם</Badge> : <Badge tone={l.diff_milli < 0 ? 'danger' : 'info'}>{l.diff_milli > 0 ? '+' : ''}{qty(l.diff_milli)}</Badge>}
              </div>
              <div className="dt-card-row"><span>צפוי</span><span>{qty(l.expected_milli)}</span></div>
              <div className="dt-card-row"><span>נספר</span><span>{l.counted_milli == null ? '—' : qty(l.counted_milli)}</span></div>
              <div className="dt-card-row"><span>מק"ט / ברקוד</span><span>{l.sku}{l.barcode ? ` · ${l.barcode}` : ''}</span></div>
            </button>
          ))}
        </div>
      )}

      <ActionBar>
        {ic.status === 'open' && <button type="button" className="action-btn" onClick={() => act('submit')}>סיום ספירה</button>}
        {ic.status === 'counted' && manager && <button type="button" className="action-btn" onClick={() => act('review')}>סימון כנבדקה</button>}
        {ic.status === 'counted' && <button type="button" className="action-btn secondary" onClick={() => act('reopen')}>חזרה לספירה</button>}
        {ic.status === 'reviewed' && manager && <button type="button" className="action-btn" onClick={() => act('post')}>אישור ועדכון מלאי</button>}
        {ic.status === 'reviewed' && manager && <button type="button" className="action-btn secondary" onClick={() => act('reopen')}>החזרה לבדיקה</button>}
        {ic.status === 'counted' && !manager && <span className="muted small">ממתין לבדיקה ואישור של מנהל</span>}
        {ic.status === 'posted' && <span className="muted small"><Icon name="check" size={14} /> אושרה {dateTime(ic.posted_at)}</span>}
      </ActionBar>

      {edit && <CountEdit line={edit} onClose={() => setEdit(null)} onSave={async (m) => { if (await putLines([{ productId: edit.product_id, countedMilli: m }], 'set')) setEdit(null); }} />}
    </div>
  );
}

function CountEdit({ line, onClose, onSave }: { line: any; onClose: () => void; onSave: (milli: number) => void }) {
  const [v, setV] = useState(line.counted_milli != null ? qty(line.counted_milli) : '');
  const save = () => { const m = parseQty(v || '0'); if (m == null) showError('כמות לא תקינה'); else onSave(m); };
  return (
    <Modal title={line.name} onClose={onClose}>
      <p className="muted small flush">צפוי: {qty(line.expected_milli)} · הכמות שנספרה בפועל:</p>
      <NumPad value={v} onChange={setV} decimals={3} onEnter={save} enterLabel="שמירה" />
    </Modal>
  );
}
