// עובדים והרשאות (IAM-01, IAM-02): תפקיד, סניף, סיסמה לעבודה במשרד, PIN לקופה. השבתה מנתקת מיד.
import { ROLE_LABEL } from '@dlx/core';
import { type FormEvent, useState } from 'react';
import DataTable from '../../components/DataTable';
import Icon from '../../components/Icon';
import { Badge, Card, EmptyState, Field, LoadError, Modal, Skeleton, Switch } from '../../components/ui';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { showToast } from '../../lib/toast';
import { useLoad } from '../../lib/useLoad';
import { apiErrors } from './common';

const OFFICE = ['owner', 'manager', 'purchaser', 'accountant'];

export default function UserSettings() {
  const s = useSession();
  const { data, error, loading, reload } = useLoad<any[]>(() => api.get('/users'), []);
  const [edit, setEdit] = useState<any>(null);
  const branch = (id: string | null) => (id ? s?.branches.find((b) => b.id === id)?.name ?? '—' : 'כל הסניפים');
  if (!data && loading) return <Skeleton />;
  if (!data) return <LoadError error={error} what="העובדים" onRetry={reload} />;
  return (
    <Card title="עובדים" icon="users" actions={<button className="action-btn inline secondary" onClick={() => setEdit({})}><Icon name="userPlus" size={18} />עובד</button>}>
      <DataTable rows={data} rowKey={(u) => u.id} onRowClick={setEdit} empty={<EmptyState compact icon="users" title="אין עובדים" />} columns={[
        { key: 'name', label: 'שם', primary: true, render: (u) => <>{u.name}{!u.active && <> <Badge tone="danger">מושבת</Badge></>}</> },
        { key: 'role', label: 'תפקיד', render: (u) => ROLE_LABEL[u.role as keyof typeof ROLE_LABEL] ?? u.role },
        { key: 'branch', label: 'סניף', render: (u) => branch(u.branch_id) },
        { key: 'login', label: 'כניסה', render: (u) => <>{u.email && <Badge>סיסמה</Badge>} {u.has_pin && <Badge tone="teal">PIN</Badge>}</> },
      ]} />
      <p className="muted small mt">השבתת עובד או שינוי תפקיד מנתקים אותו מיד מכל המכשירים. עובד לא נמחק — הפעולות שלו נשארות ביומן.</p>
      {edit && <UserForm initial={edit} selfId={s?.user.id} branches={s?.branches ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </Card>
  );
}

function UserForm({ initial, selfId, branches, onClose, onSaved }: { initial: any; selfId?: string; branches: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const isNew = !initial.id;
  const [f, setF] = useState({ name: initial.name ?? '', role: initial.role ?? 'cashier', branchId: initial.branch_id ?? '', email: initial.email ?? '', password: '', pin: '', active: initial.active ?? true });
  const [err, setErr] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const office = OFFICE.includes(f.role);
  const self = initial.id === selfId;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (f.pin && !/^\d{4,8}$/.test(f.pin)) fe.pin = '4–8 ספרות';
    if (f.password && f.password.length < 8) fe.password = 'לפחות 8 תווים';
    if (f.password && !f.email) fe.email = 'כניסה בסיסמה דורשת אימייל';
    if (isNew && !f.password && !f.pin) fe.pin = 'צריך PIN או סיסמה';
    if (Object.keys(fe).length) { setErr(fe); return; }
    const body: any = { name: f.name, role: f.role, branchId: f.branchId || null, email: f.email || null };
    if (f.password) body.password = f.password;
    if (f.pin) body.pin = f.pin;
    if (!isNew) body.active = f.active;
    setBusy(true); setErr({}); setMsg('');
    try {
      if (isNew) await api.post('/users', body); else await api.put(`/users/${initial.id}`, body);
      showToast('נשמר'); onSaved();
    } catch (x) {
      const r = apiErrors(x);
      setMsg(r.msg);
      setErr({ ...r.fields, ...((x as any)?.code === 'pin_taken' ? { pin: 'ה-PIN כבר בשימוש אצל עובד אחר' } : {}) });
    } finally { setBusy(false); }
  };

  return (
    <Modal title={isNew ? 'עובד חדש' : f.name} onClose={onClose} size="wide">
      <form onSubmit={submit} className="stack">
        <div className="form-grid">
          <Field label="שם" error={err.name}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
          <Field label="תפקיד">
            <select value={f.role} disabled={self} onChange={(e) => setF({ ...f, role: e.target.value })}>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Field>
          <Field label="סניף"><select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">כל הסניפים</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <Field label={`PIN לקופה${isNew ? '' : ' (ריק = בלי שינוי)'}`} hint="4–8 ספרות, ייחודי לכל עובד" error={err.pin}>
            <input value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} inputMode="numeric" maxLength={8} dir="ltr" autoComplete="off" />
          </Field>
          {(office || f.email) && <>
            <Field label="אימייל (לכניסה מהמשרד)" error={err.email}><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} dir="ltr" /></Field>
            <Field label={isNew ? 'סיסמה' : 'סיסמה חדשה (ריק = בלי שינוי)'} error={err.password}><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} dir="ltr" autoComplete="new-password" /></Field>
          </>}
        </div>
        {!isNew && !self && <div className="check-row"><Switch label="פעיל" on={f.active} onChange={(v) => setF({ ...f, active: v })} />{f.active ? 'פעיל' : 'מושבת — לא יכול להיכנס'}</div>}
        {msg && <div className="dlg-err" role="alert">{msg}</div>}
        <div className="form-actions"><button className="action-btn" disabled={busy}>{busy ? 'שומר…' : 'שמירה'}</button><button type="button" className="action-btn ghost" onClick={onClose}>ביטול</button></div>
      </form>
    </Modal>
  );
}
