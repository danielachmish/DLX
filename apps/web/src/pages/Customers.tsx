// לקוחות (CRM-01): חיפוש לפי שם / טלפון / מספר זהות, יתרה ומסגרת
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DataTable from '../components/DataTable';
import Icon from '../components/Icon';
import { Badge, EmptyState, LoadError, Money, PageHeader, Skeleton } from '../components/ui';
import { api, qs } from '../lib/api';
import { useLoad } from '../lib/useLoad';
import { can } from '../lib/session';
import { showToast } from '../lib/toast';
import CustomerForm from './admin/CustomerForm';
import '../styles/admin.css';

export default function Customers() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [adding, setAdding] = useState(false);
  const { data, error, loading, reload } = useLoad<any[]>(() => api.get('/customers' + qs({ q: term, limit: 200 })), [term]);

  return (
    <div>
      <PageHeader sub="לקוחות רשומים, יתרות חוב ומסגרות אשראי"
        actions={can('customers:write') && <button className="action-btn inline" onClick={() => setAdding(true)}><Icon name="userPlus" size={18} />לקוח חדש</button>} />
      <form className="search-box" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי שם, טלפון או ת.ז. / ע.מ." aria-label="חיפוש לקוח" />
        <button className="icon-btn" aria-label="חיפוש"><Icon name="search" /></button>
      </form>
      {!data && loading ? <Skeleton /> : !data && error ? <LoadError error={error} what="הלקוחות" onRetry={reload} /> : (
        <DataTable rows={data ?? []} rowKey={(r) => r.id} onRowClick={(r) => nav(`/customers/${r.id}`)}
          empty={term
            ? <EmptyState icon="search" title={`לא נמצא "${term}"`} action={{ label: 'ניקוי חיפוש', onClick: () => { setQ(''); setTerm(''); } }} />
            : <EmptyState icon="users" title="אין עדיין לקוחות" text="לקוח רשום נדרש להקפה, לחשבונית מס ללקוח עסקי ולהיסטוריית קניות" />}
          columns={[
            { key: 'name', label: 'שם', primary: true, value: (r) => r.name, render: (r) => <>{r.name}{!r.active && <> <Badge>לא פעיל</Badge></>}</> },
            { key: 'kind', label: 'סוג', render: (r) => <Badge tone={r.kind === 'business' ? 'info' : undefined}>{r.kind === 'business' ? 'עסקי' : 'פרטי'}</Badge> },
            { key: 'phone', label: 'טלפון', render: (r) => <span dir="ltr">{r.phone || '—'}</span> },
            { key: 'tax_id', label: 'ת.ז. / ע.מ.', muted: true, render: (r) => r.tax_id || '—' },
            { key: 'credit', label: 'מסגרת', num: true, hideOnCard: true, value: (r) => r.credit_limit_agorot, render: (r) => (r.credit_limit_agorot ? <Money a={r.credit_limit_agorot} /> : '—') },
            { key: 'balance', label: 'יתרת חוב', num: true, value: (r) => r.balance_agorot, render: (r) => <span className={r.balance_agorot > 0 ? 'money neg' : 'money'}><Money a={r.balance_agorot} /></span> },
          ]} />
      )}
      {adding && <CustomerForm onClose={() => setAdding(false)} onSaved={(c) => { setAdding(false); showToast('הלקוח נשמר'); nav(`/customers/${c.id}`); }} />}
    </div>
  );
}
