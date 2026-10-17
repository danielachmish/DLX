// מעטפת DLX: ניווט אחד, שלוש תצוגות (טלפון — סרגל תחתון · אייפד — Rail · מחשב — Sidebar).
// היעדים מסוננים לפי הרשאות התפקיד; בטלפון 4 הראשונים לתפקיד + "עוד".
import { useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Icon from './components/Icon';
import { Modal } from './components/ui';
import { useOnline } from './lib/misc';
import { usePageHeaderState } from './lib/pageHeader';
import { can, currentRegister, logout, ROLE_LABEL, type Session, useSession } from './lib/session';
import { useSystemInfo } from './lib/system';
import Login from './pages/Login';
import PublicDocument from './pages/PublicDocument';
import Dashboard from './pages/Dashboard';
import Pos from './pages/pos/Pos';
import Documents from './pages/Documents';
import DocumentView from './pages/DocumentView';
import Returns from './pages/Returns';
import Shifts from './pages/Shifts';
import Products from './pages/Products';
import ProductEdit from './pages/ProductEdit';
import Inventory from './pages/Inventory';
import CountView from './pages/CountView';
import Purchasing from './pages/Purchasing';
import PoView from './pages/PoView';
import ReceiptView from './pages/ReceiptView';
import Customers from './pages/Customers';
import CustomerView from './pages/CustomerView';
import Reports from './pages/Reports';
import Exports from './pages/Exports';
import Settings from './pages/Settings';

interface NavItem { path: string; label: string; short?: string; icon: string; perm: string | string[]; group: string }

export const NAV: NavItem[] = [
  { path: '/dashboard', label: 'לוח בקרה', short: 'בקרה', icon: 'home', perm: 'reports:sales', group: 'ניהול' },
  { path: '/pos', label: 'קופה', icon: 'cart', perm: 'pos:sell', group: 'מכירה' },
  { path: '/documents', label: 'מסמכים ומכירות', short: 'מסמכים', icon: 'receipt', perm: 'document:read', group: 'מכירה' },
  { path: '/returns', label: 'החזרות', icon: 'undo', perm: 'pos:refund', group: 'מכירה' },
  { path: '/shifts', label: 'משמרות וקופה', short: 'משמרות', icon: 'wallet', perm: 'pos:sell', group: 'מכירה' },
  { path: '/products', label: 'מוצרים ומחירים', short: 'מוצרים', icon: 'tag', perm: 'catalog:read', group: 'ניהול' },
  { path: '/inventory', label: 'מלאי וספירות', short: 'מלאי', icon: 'box', perm: 'stock:read', group: 'ניהול' },
  { path: '/purchasing', label: 'רכש וקליטה', short: 'רכש', icon: 'truck', perm: 'stock:read', group: 'ניהול' },
  { path: '/customers', label: 'לקוחות', icon: 'users', perm: 'customers:read', group: 'ניהול' },
  { path: '/reports', label: 'דוחות', icon: 'chart', perm: 'reports:sales', group: 'כספים' },
  { path: '/exports', label: 'ייצוא לרו"ח', short: 'ייצוא', icon: 'download', perm: 'tax:export', group: 'כספים' },
  { path: '/settings', label: 'הגדרות', icon: 'settings', perm: ['settings:write', 'users:write', 'audit:read'], group: 'מערכת' },
];

// סדר עדיפות בסרגל התחתון לפי תפקיד (UX: "רק הפעולות הנדרשות על המסך הראשי")
const MOBILE_FIRST: Record<string, string[]> = {
  cashier: ['/pos', '/documents', '/returns', '/shifts'],
  warehouse: ['/inventory', '/purchasing', '/products'],
  purchaser: ['/purchasing', '/inventory', '/products'],
  accountant: ['/reports', '/documents', '/exports'],
  manager: ['/dashboard', '/pos', '/inventory', '/products'],
  owner: ['/dashboard', '/pos', '/inventory', '/products'],
};

const allowed = (n: NavItem, s: Session) => (Array.isArray(n.perm) ? n.perm.some((p) => can(p, s)) : can(n.perm, s));

export function homePath(s: Session) {
  const first = MOBILE_FIRST[s.user.role]?.[0] ?? '/pos';
  return NAV.find((n) => n.path === first && allowed(n, s)) ? first : NAV.find((n) => allowed(n, s))?.path ?? '/settings';
}

export default function App() {
  const session = useSession();
  const loc = useLocation();
  if (loc.pathname.startsWith('/d/')) return <Routes><Route path="/d/:token" element={<PublicDocument />} /></Routes>;
  if (!session) return <Login />;
  return <Shell session={session} />;
}

function Shell({ session }: { session: Session }) {
  const nav = useNavigate();
  const loc = useLocation();
  const header = usePageHeaderState();
  const online = useOnline();
  const sys = useSystemInfo();
  const mode = session.tenant.documents_mode ?? 'shadow';
  const [more, setMore] = useState(false);
  const items = useMemo(() => NAV.filter((n) => allowed(n, session)), [session]);
  const mobile = useMemo(() => {
    const order = MOBILE_FIRST[session.user.role] ?? [];
    const first = order.map((p) => items.find((i) => i.path === p)).filter(Boolean) as NavItem[];
    return (first.length ? first : items).slice(0, 4);
  }, [items, session.user.role]);
  const active = (p: string) => loc.pathname === p || loc.pathname.startsWith(p + '/');
  const current = items.find((i) => active(i.path));
  const reg = currentRegister(session);
  const branch = session.branches.find((b) => b.id === (reg?.branch_id ?? session.user.branchId)) ?? session.branches[0];
  const pos = loc.pathname === '/pos';
  const go = (p: string) => { setMore(false); nav(p); };
  const groups = [...new Set(items.map((i) => i.group))];
  const initials = session.user.name.trim().slice(0, 1);

  return (
    <div className="app-shell has-bottom-nav">
      <nav className="app-nav" aria-label="ניווט ראשי">
        <div className="app-nav-logo">DLX <small>{session.tenant.trade_name || session.tenant.legal_name}</small></div>
        {groups.map((g, gi) => (
          <div key={g}>
            {gi > 0 && <div className="app-nav-sep" />}
            <div className="app-nav-group">{g}</div>
            {items.filter((i) => i.group === g).map((i) => (
              <button key={i.path} type="button" className={'nav-item' + (active(i.path) ? ' active' : '')} onClick={() => go(i.path)} aria-current={active(i.path) ? 'page' : undefined} title={i.label}>
                <Icon name={i.icon} size={20} /><span className="nav-label"><span className="nav-short">{i.short ?? i.label}</span><span className="nav-full">{i.label}</span></span>
              </button>
            ))}
          </div>
        ))}
        <div className="app-nav-user">
          <span className="avatar" aria-hidden="true">{initials}</span>
          <span className="app-nav-user-name">{session.user.name}<small>{ROLE_LABEL[session.user.role]}</small></span>
          <button type="button" className="logout-btn" onClick={logout} aria-label="יציאה" title="יציאה"><Icon name="logout" size={18} /></button>
        </div>
      </nav>

      <div className="app-main">
        <header className="top-bar">
          <div className="title-group">
            {header?.back && (
              <button type="button" className="back-btn" aria-label="חזרה" onClick={() => (header.onBack ? header.onBack() : nav(-1))}><Icon name="back" /></button>
            )}
            <div className="titles">
              <span className="title">{header?.title ?? current?.label ?? 'DLX'}</span>
              {header?.sub && <span className="sub">{header.sub}</span>}
            </div>
          </div>
          <div className="top-actions">
            {!online && <span className="ctx-pill offline-pill"><Icon name="offline" size={16} />אין חיבור</span>}
            {mode === 'training' && <span className="ctx-pill mode-pill training" title="סביבת תרגול — שום דבר כאן לא אמיתי"><Icon name="lamp" size={16} />תרגול</span>}
            {mode === 'shadow' && <span className="ctx-pill mode-pill" title="פיילוט — המסמכים אינם רשמיים"><Icon name="flag" size={16} />פיילוט</span>}
            {sys?.demoProviders && <span className="ctx-pill mode-pill training" title="סליקה / רשות המסים בספק דמה — לא לשימוש מול לקוחות">ספק דמה</span>}
            <span className="ctx-pill" title="סניף וקופה">
              <Icon name="store" size={16} /><b>{branch?.name}</b>{reg && can('pos:sell', session) ? ` · ${reg.name}` : ''}
            </span>
          </div>
        </header>
        <main className={'content' + (pos ? ' pos-mode' : '')}>
          <Routes>
            <Route path="/" element={<Navigate to={homePath(session)} replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/pos" element={<Pos />} />
            <Route path="/documents" element={<Documents />} />
            <Route path="/documents/:id" element={<DocumentView />} />
            <Route path="/returns" element={<Returns />} />
            <Route path="/shifts" element={<Shifts />} />
            <Route path="/products" element={<Products />} />
            <Route path="/products/new" element={<ProductEdit />} />
            <Route path="/products/:id" element={<ProductEdit />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/inventory/counts/:id" element={<CountView />} />
            <Route path="/purchasing" element={<Purchasing />} />
            <Route path="/purchasing/po/:id" element={<PoView />} />
            <Route path="/purchasing/receipts/:id" element={<ReceiptView />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/customers/:id" element={<CustomerView />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/exports" element={<Exports />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to={homePath(session)} replace />} />
          </Routes>
        </main>
      </div>

      <nav className="mobile-bottom-nav" aria-label="ניווט">
        {mobile.map((i) => (
          <button key={i.path} type="button" className={active(i.path) ? 'active' : ''} onClick={() => go(i.path)} aria-current={active(i.path) ? 'page' : undefined}>
            <Icon name={i.icon} size={20} />{i.short ?? i.label}
          </button>
        ))}
        <button type="button" className={more ? 'active' : ''} onClick={() => setMore(true)}><Icon name="more" size={20} />עוד</button>
      </nav>

      {more && (
        <Modal title="עוד" onClose={() => setMore(false)}>
          <div className="more-sheet">
            <div className="more-user">
              <span className="avatar">{initials}</span>
              <span className="more-user-name">{session.user.name}<small>{ROLE_LABEL[session.user.role]} · {session.tenant.trade_name || session.tenant.legal_name}</small></span>
              <button type="button" className="logout-btn" onClick={logout}><Icon name="logout" size={18} />יציאה</button>
            </div>
            <div className="more-grid">
              {items.map((i) => (
                <button key={i.path} type="button" className={'more-tile' + (active(i.path) ? ' active' : '')} onClick={() => go(i.path)}>
                  <Icon name={i.icon} size={24} /><span>{i.label}</span>
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
