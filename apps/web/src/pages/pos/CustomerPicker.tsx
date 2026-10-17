// שיוך לקוח למכירה: חיפוש לפי שם / טלפון / ת.ז., או יצירה מהירה (CRM-01: איסוף מינימלי)
import { type FormEvent, useEffect, useState } from 'react';
import Icon from '../../components/Icon';
import { EmptyState, Field, Modal, Money } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { showError } from '../../lib/toast';

export default function CustomerPicker({ onPick, onClose }: { onPick: (c: any) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  useEffect(() => {
    const t = setTimeout(() => { api.get(`/customers${qs({ q, limit: 20 })}`).then(setRows).catch(() => setRows([])); }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try { onPick(await api.post('/customers', { name: name.trim(), phone: phone.trim() || null })); } catch (x) { showError(x); }
  };

  return (
    <Modal title="לקוח למכירה" onClose={onClose}>
      {!creating ? (
        <>
          <div className="search-box"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="שם, טלפון או ת.ז." /></div>
          <div className="pos-results">
            {rows?.map((c) => (
              <button key={c.id} type="button" className="pos-result" onClick={() => onPick(c)}>
                <span><b>{c.name}</b> <span className="muted small">{c.phone ?? ''}{c.tax_id ? ` · ${c.tax_id}` : ''}</span></span>
                {c.balance_agorot ? <Money a={c.balance_agorot} /> : null}
              </button>
            ))}
            {rows && rows.length === 0 && <EmptyState compact icon="users" title="לא נמצא לקוח" />}
          </div>
          <button type="button" className="action-btn secondary" onClick={() => { setCreating(true); setName(/\d/.test(q) ? '' : q); setPhone(/\d/.test(q) ? q : ''); }}>
            <Icon name="userPlus" size={18} /> לקוח חדש
          </button>
        </>
      ) : (
        <form onSubmit={create} className="stack">
          <Field label="שם"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label="טלפון"><input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" dir="ltr" /></Field>
          <div className="form-actions">
            <button className="action-btn" disabled={!name.trim()}>שמירה ושיוך</button>
            <button type="button" className="action-btn ghost" onClick={() => setCreating(false)}>חזרה</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
