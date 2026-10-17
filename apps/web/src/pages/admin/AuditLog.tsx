// יומן ביקורת (IAM-05, NFR-10): כל פעולה רגישה, ובדיקת שרשרת ה-hash — שינוי ישיר ב-DB מתגלה
import { useEffect, useState } from 'react';
import DataTable from '../../components/DataTable';
import Icon from '../../components/Icon';
import { Badge, Card, EmptyState, Field, LoadError, Skeleton } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { toastError } from './common';

const ACTIONS: Record<string, string> = {
  '': 'הכל', 'auth.': 'כניסות', 'sale.': 'מכירות', 'return.': 'החזרות', 'document.': 'מסמכים', 'payment.': 'תשלומים', 'cash.': 'קופה ומשמרות',
  'stock.': 'מלאי', 'count.': 'ספירות', 'product.': 'מוצרים', 'price.': 'מחירים', 'user.': 'עובדים', 'settings.': 'הגדרות', 'permission.': 'ניסיונות חסומים', 'export.': 'ייצוא',
};

export default function AuditLog() {
  const [action, setAction] = useState('');
  const [rows, setRows] = useState<any[] | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState(false);
  const [chain, setChain] = useState<any>(null);

  const load = async (before?: number) => {
    setError(null);
    try {
      const r = await api.get<any[]>('/audit' + qs({ limit: 100, before, action }));
      setRows((p) => (before ? [...(p ?? []), ...r] : r));
      setMore(r.length === 100);
    } catch (e) { setError(e); if (!before) setRows(undefined); }
  };
  useEffect(() => { setRows(undefined); load(); }, [action]);
  const verify = async () => { try { setChain(await api.get('/audit/verify')); } catch (e) { toastError(e); } };

  return (
    <div className="stack">
      <Card title="שלמות היומן" icon="shield" actions={<button className="action-btn inline secondary" onClick={verify}><Icon name="shield" size={18} />בדיקה</button>}>
        {chain ? (chain.ok
          ? <p className="chain-ok flush"><Icon name="check" size={16} /> השרשרת תקינה — {chain.count} רשומות, אף אחת לא שונתה או נמחקה.</p>
          : <p className="chain-bad flush"><Icon name="alert" size={16} /> השרשרת שבורה ברשומה {chain.brokenAt}. מישהו שינה את היומן ישירות — צריך לבדוק מיד.</p>)
          : <p className="muted small flush">כל רשומה ביומן חתומה על הקודמת. הבדיקה מגלה שינוי או מחיקה שנעשו ישירות במסד הנתונים.</p>}
      </Card>
      <Field label="סוג פעולה">
        <select value={action} onChange={(e) => setAction(e.target.value)}>{Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </Field>
      {rows === undefined && !error ? <Skeleton /> : rows === undefined ? <LoadError error={error} what="היומן" onRetry={() => load()} /> : (
        <>
          <DataTable rows={rows} rowKey={(r) => String(r.id)} empty={<EmptyState icon="history" title="אין פעולות" />} columns={[
            { key: 'at', label: 'זמן', primary: true, render: (r) => dateTime(r.created_at) },
            { key: 'who', label: 'עובד', render: (r) => r.actor_name ?? '—' },
            { key: 'act', label: 'פעולה', render: (r) => <>{r.action} {r.result !== 'ok' && <Badge tone="danger">{r.result === 'denied' ? 'נחסם' : r.result}</Badge>}</> },
            { key: 'det', label: 'פרטים', hideOnCard: true, render: (r) => <span className="audit-details" title={JSON.stringify(r.details)}>{JSON.stringify(r.details)}</span> },
          ]} />
          {more && <button className="action-btn secondary" onClick={() => load(rows[rows.length - 1]?.id)}>עוד</button>}
        </>
      )}
    </div>
  );
}
