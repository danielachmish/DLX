// לפני מכירה: בחירת קופה למכשיר ופתיחת משמרת עם קופה קטנה (CSH-01).
// החלפת קופה טוענת מחדש את המסך — useSession לא מתעדכן כשמשתנה רק הקופה במכשיר.
import { parseShekels } from '@dlx/core';
import { useState } from 'react';
import Icon from '../../components/Icon';
import NumPad from '../../components/NumPad';
import { Card, Field } from '../../components/ui';
import { api } from '../../lib/api';
import { showError, showToast } from '../../lib/toast';
import { type Session, setRegisterId } from '../../lib/session';

export function RegisterPicker({ session, value }: { session: Session; value: string | null }) {
  const regs = session.registers.filter((r) => !session.user.branchId || r.branch_id === session.user.branchId);
  if (regs.length < 2) return null;
  return (
    <Field label="הקופה של המכשיר הזה">
      <select value={value ?? ''} onChange={(e) => { setRegisterId(e.target.value); window.location.reload(); }}>
        {regs.map((r) => <option key={r.id} value={r.id}>{r.name} ({session.branches.find((b) => b.id === r.branch_id)?.name})</option>)}
      </select>
    </Field>
  );
}

export default function ShiftGate({ session, registerId, onOpened }: { session: Session; registerId: string; onOpened: () => void }) {
  const [float, setFloat] = useState('');
  const [busy, setBusy] = useState(false);
  const open = async () => {
    const amount = parseShekels(float || '0');
    if (amount === null) return showError(new Error('סכום לא תקין'));
    setBusy(true);
    try {
      await api.post('/cash-sessions/open', { registerId, openingFloatAgorot: amount });
      showToast('המשמרת נפתחה');
      onOpened();
    } catch (e) { showError(e); } finally { setBusy(false); }
  };
  return (
    <div className="page-narrow pos-gate">
      <Card title="פתיחת משמרת" icon="wallet">
        <p className="section-sub">אין משמרת פתוחה בקופה הזו. ספרו את הכסף שבמגירה (קופה קטנה) ופתחו משמרת.</p>
        <RegisterPicker session={session} value={registerId} />
        <div className="mt">
          <NumPad value={float} onChange={setFloat} onEnter={open} enterLabel={busy ? 'פותח…' : 'פתיחת משמרת'} />
        </div>
        <p className="muted small mt"><Icon name="clock" size={14} /> בסוף היום סוגרים את המשמרת במסך "משמרות" ומקבלים דוח Z.</p>
      </Card>
    </div>
  );
}
