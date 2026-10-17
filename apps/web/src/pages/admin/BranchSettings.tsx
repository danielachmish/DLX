// סניפים וקופות (TEN-02). אזור מס "אילת" — מכירת טובין בשיעור אפס (לאמת תנאים מול יועץ מס)
import { type FormEvent, useState } from 'react';
import DataTable from '../../components/DataTable';
import Icon from '../../components/Icon';
import { Badge, Card, EmptyState, Field, LoadError, Modal, Skeleton, Switch } from '../../components/ui';
import { api } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { useLoad } from '../../lib/useLoad';
import { apiErrors } from './common';

export default function BranchSettings() {
  const b = useLoad<any[]>(() => api.get('/branches'), []);
  const r = useLoad<any[]>(() => api.get('/registers'), []);
  const [editB, setEditB] = useState<any>(null);
  const [editR, setEditR] = useState<any>(null);
  const branchName = (id: string) => b.data?.find((x) => x.id === id)?.name ?? '—';
  if ((!b.data && b.loading) || (!r.data && r.loading)) return <Skeleton />;
  if (!b.data || !r.data) return <LoadError error={b.error ?? r.error} what="הסניפים" onRetry={() => { b.reload(); r.reload(); }} />;
  return (
    <div className="stack">
      <Card title="סניפים" icon="store" actions={<button className="action-btn inline secondary" onClick={() => setEditB({})}><Icon name="plus" size={18} />סניף</button>}>
        <DataTable rows={b.data} rowKey={(x) => x.id} onRowClick={setEditB} empty={<EmptyState compact icon="store" title="אין סניפים" />} columns={[
          { key: 'name', label: 'שם', primary: true, render: (x) => <>{x.name}{!x.active && <> <Badge>לא פעיל</Badge></>}</> },
          { key: 'addr', label: 'כתובת', render: (x) => x.address || '—' },
          { key: 'zone', label: 'אזור מס', render: (x) => (x.tax_zone === 'eilat' ? <Badge tone="info">אילת</Badge> : 'רגיל') },
        ]} />
      </Card>
      <Card title="קופות" icon="cart" actions={<button className="action-btn inline secondary" onClick={() => setEditR({ branch_id: b.data![0]?.id })}><Icon name="plus" size={18} />קופה</button>}>
        <DataTable rows={r.data} rowKey={(x) => x.id} onRowClick={setEditR} empty={<EmptyState compact icon="cart" title="אין קופות" />} columns={[
          { key: 'name', label: 'קופה', primary: true, render: (x) => <>{x.name} <span className="muted small">({x.code})</span>{!x.active && <> <Badge>לא פעילה</Badge></>}</> },
          { key: 'br', label: 'סניף', render: (x) => branchName(x.branch_id) },
        ]} />
      </Card>
      {editB && <BranchForm initial={editB} onClose={() => setEditB(null)} onSaved={() => { setEditB(null); b.reload(); }} />}
      {editR && <RegisterForm initial={editR} branches={b.data} onClose={() => setEditR(null)} onSaved={() => { setEditR(null); r.reload(); }} />}
    </div>
  );
}

function BranchForm({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: initial.name ?? '', address: initial.address ?? '', taxZone: initial.tax_zone ?? 'regular', active: initial.active ?? true });
  const [msg, setMsg] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const body = { ...f, address: f.address || null };
      if (initial.id) await api.put(`/branches/${initial.id}`, body); else await api.post('/branches', body);
      showToast('הסניף נשמר'); onSaved();
    } catch (x) { setMsg(apiErrors(x).msg); }
  };
  return (
    <Modal title={initial.id ? 'עריכת סניף' : 'סניף חדש'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <Field label="שם"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="כתובת" hint="מופיעה על המסמכים של הסניף"><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label="אזור מס">
          <select value={f.taxZone} onChange={(e) => setF({ ...f, taxZone: e.target.value })}><option value="regular">רגיל</option><option value="eilat">אילת (פטור ממע"מ על טובין)</option></select>
        </Field>
        {f.taxZone === 'eilat' && <div className="notice"><Icon name="alert" size={18} />באזור אילת מכירת טובין לתושבים מחויבת בשיעור אפס. התנאים המדויקים — לאמת מול יועץ מס לפני הפעלה.</div>}
        <div className="check-row"><Switch label="פעיל" on={f.active} onChange={(v) => setF({ ...f, active: v })} />פעיל</div>
        {msg && <div className="dlg-err" role="alert">{msg}</div>}
        <div className="form-actions"><button className="action-btn">שמירה</button><button type="button" className="action-btn ghost" onClick={onClose}>ביטול</button></div>
      </form>
    </Modal>
  );
}

function RegisterForm({ initial, branches, onClose, onSaved }: { initial: any; branches: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ branchId: initial.branch_id ?? branches[0]?.id, code: initial.code ?? '', name: initial.name ?? '', active: initial.active ?? true });
  const [err, setErr] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (initial.id) await api.put(`/registers/${initial.id}`, f); else await api.post('/registers', f);
      showToast('הקופה נשמרה'); onSaved();
    } catch (x) { const r = apiErrors(x); setMsg(r.msg); setErr(r.fields); }
  };
  return (
    <Modal title={initial.id ? 'עריכת קופה' : 'קופה חדשה'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <Field label="סניף"><select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>{branches.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <div className="form-grid">
          <Field label="קוד" hint="ספרות / אותיות, עד 10" error={err.code}><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} dir="ltr" required /></Field>
          <Field label="שם"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        </div>
        <div className="check-row"><Switch label="פעילה" on={f.active} onChange={(v) => setF({ ...f, active: v })} />פעילה</div>
        {msg && <div className="dlg-err" role="alert">{msg}</div>}
        <div className="form-actions"><button className="action-btn">שמירה</button><button type="button" className="action-btn ghost" onClick={onClose}>ביטול</button></div>
      </form>
    </Modal>
  );
}
