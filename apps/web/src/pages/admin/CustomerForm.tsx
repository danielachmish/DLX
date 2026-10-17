// טופס לקוח (חדש / עריכה). מסגרת אשראי — רק למורשה (customers:credit)
import { isValidIsraeliId, parseShekels } from '@dlx/core';
import { type FormEvent, useState } from 'react';
import { Field, Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { can } from '../../lib/session';
import { apiErrors, shekels } from './common';

export default function CustomerForm({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved: (c: any) => void }) {
  const [f, setF] = useState({
    name: initial?.name ?? '', kind: initial?.kind ?? 'private', taxId: initial?.tax_id ?? '', phone: initial?.phone ?? '', email: initial?.email ?? '',
    address: initial?.address ?? '', credit: shekels(initial?.credit_limit_agorot ?? 0), notes: initial?.notes ?? '',
  });
  const [err, setErr] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const mayCredit = can('customers:credit');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!f.name.trim()) fe.name = 'חובה';
    if (f.taxId && !isValidIsraeliId(f.taxId)) fe.taxId = 'מספר לא תקין';
    const credit = f.credit ? parseShekels(f.credit) : 0;
    if (credit == null || credit < 0) fe.creditLimitAgorot = 'סכום לא תקין';
    if (Object.keys(fe).length) { setErr(fe); return; }
    const body: any = {
      name: f.name.trim(), kind: f.kind, taxId: f.taxId || null, phone: f.phone || null, email: f.email || '', address: f.address || null, notes: f.notes || null,
    };
    if (mayCredit) body.creditLimitAgorot = credit;
    setBusy(true); setMsg(''); setErr({});
    try {
      onSaved(initial ? await api.put(`/customers/${initial.id}`, body) : await api.post('/customers', body));
    } catch (x) { const { msg: m, fields } = apiErrors(x); setMsg(m); setErr(fields); } finally { setBusy(false); }
  };

  return (
    <Modal title={initial ? 'עריכת לקוח' : 'לקוח חדש'} onClose={onClose} size="wide">
      <form onSubmit={submit} className="stack">
        <div className="form-grid">
          <Field label="שם" error={err.name}><input value={f.name} onChange={set('name')} required /></Field>
          <Field label="סוג">
            <select value={f.kind} onChange={set('kind')}><option value="private">פרטי</option><option value="business">עסקי</option></select>
          </Field>
          <Field label={f.kind === 'business' ? 'ע.מ. / ח.פ.' : 'ת.ז. (לא חובה)'} hint={f.kind === 'business' ? 'נדרש לחשבונית מס ולמספר הקצאה' : undefined} error={err.taxId}>
            <input value={f.taxId} onChange={set('taxId')} inputMode="numeric" dir="ltr" />
          </Field>
          <Field label="טלפון"><input value={f.phone} onChange={set('phone')} inputMode="tel" dir="ltr" /></Field>
          <Field label="אימייל" error={err.email}><input type="email" value={f.email} onChange={set('email')} dir="ltr" /></Field>
          <Field label="כתובת"><input value={f.address} onChange={set('address')} /></Field>
          {mayCredit && <Field label="מסגרת אשראי (₪)" hint="0 = בלי הקפה" error={err.creditLimitAgorot}><input value={f.credit} onChange={set('credit')} inputMode="decimal" dir="ltr" /></Field>}
          <Field label="הערות" wide><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
        </div>
        {msg && <div className="dlg-err" role="alert">{msg}</div>}
        <div className="form-actions">
          <button className="action-btn" disabled={busy}>{busy ? 'שומר…' : 'שמירה'}</button>
          <button type="button" className="action-btn ghost" onClick={onClose}>ביטול</button>
        </div>
      </form>
    </Modal>
  );
}
