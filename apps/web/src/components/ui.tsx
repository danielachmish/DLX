// רכיבים משותפים (מערכת העיצוב, הוסבו ל-TypeScript): שלד טעינה, מצב ריק, שגיאת טעינה, אריח מספר, לשוניות,
// פעולה ראשית, כותרת מסך, כסף, שדה, חלון. כל מסך בונה רק מאלה ומהטוקנים.
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { money } from '../lib/format';
import { edgeFades, cls } from '../lib/misc';
import { useSetPageHeader } from '../lib/pageHeader';
import { errorInfo } from '../lib/useLoad';
import Icon, { toneOf } from './Icon';

const LINES = ['w60', 'w80', 'w40', 'w80', 'w60', 'w30'];
export function Skeleton({ rows, variant = 'list' }: { rows?: number; variant?: 'list' | 'card' | 'counters' | 'text' }) {
  const label = 'בטעינה';
  if (variant === 'counters') {
    return <div className="skeleton-counters" role="status" aria-label={label}>{Array.from({ length: rows || 3 }, (_, i) => <div key={i} className="skeleton-card"><span className="skeleton-line w60" /><span className="skeleton-line w40 big" /></div>)}</div>;
  }
  if (variant === 'card' || variant === 'text') {
    const lines = Array.from({ length: rows || (variant === 'card' ? 5 : 3) }, (_, i) => <span key={i} className={'skeleton-line ' + LINES[i % LINES.length]} />);
    return variant === 'card'
      ? <div className="skeleton" role="status" aria-label={label}><div className="skeleton-card"><span className="skeleton-line w40 big" />{lines}</div></div>
      : <div className="skeleton text" role="status" aria-label={label}>{lines}</div>;
  }
  return <div className="skeleton" role="status" aria-label={label}>{Array.from({ length: rows || 3 }, (_, i) => <div key={i} className="skeleton-card"><span className="skeleton-line w60" /><span className="skeleton-line w40" /><span className="skeleton-line w80" /></div>)}</div>;
}

export interface EmptyAction { label: string; onClick: () => void; icon?: string; primary?: boolean }
export function EmptyState({ icon = 'inbox', title, text, action, tone, compact = false, children }: { icon?: string; title?: string; text?: string; action?: EmptyAction | null; tone?: 'ok' | 'warn' | 'info' | 'danger'; compact?: boolean; children?: ReactNode }) {
  const t = tone ?? (icon === 'check' ? 'ok' : undefined);
  const topic = !t && toneOf(icon);
  return (
    <div className={cls('empty-state', 'es', t, compact && 'compact')} role="status">
      <span className={'es-icon' + (topic ? ` t-${topic}` : '')} aria-hidden="true"><Icon name={icon} size={compact ? 24 : 30} stroke={icon === 'check' ? 2.6 : 2} /></span>
      {title && <b className="es-title">{title}</b>}
      {text && <span className="es-text">{text}</span>}
      {action && <button type="button" className={'action-btn inline ' + (action.primary ? '' : 'secondary')} onClick={action.onClick}>{action.icon && <Icon name={action.icon} size={18} />}{action.label}</button>}
      {children}
    </div>
  );
}

export function LoadError({ error, what = 'הנתונים', onRetry, compact = false }: { error: unknown; what?: string; onRetry?: () => void; compact?: boolean }) {
  const info = errorInfo(error, what);
  return <div className="load-error" role="alert"><EmptyState icon={info.offline ? 'offline' : 'alert'} tone={info.offline ? 'warn' : 'danger'} compact={compact} title={info.title} text={info.text} action={onRetry ? { label: 'נסו שוב', icon: 'refresh', onClick: onRetry, primary: true } : null} /></div>;
}

export function StatGrid({ children }: { children: ReactNode }) { return <div className="stat-grid">{children}</div>; }
export function StatCard({ label, value, sub, icon, tone, onClick, active = false }: { label: string; value?: ReactNode; sub?: ReactNode; icon?: string; tone?: 'ok' | 'warn' | 'info' | 'danger' | 'teal'; onClick?: () => void; active?: boolean }) {
  const inner = <><span className="stat-label">{icon && <Icon name={icon} size={16} />}{label}</span>{value === undefined ? <span className="skeleton-line" aria-label="בטעינה" /> : <b className="stat-value">{value}</b>}{sub && <span className="stat-sub">{sub}</span>}</>;
  const c = cls('stat-card', tone, active && 'on');
  return onClick ? <button type="button" className={c} onClick={onClick} aria-pressed={active}>{inner}</button> : <div className={c}>{inner}</div>;
}

export interface TabItem { key: string; label: string; icon?: string; count?: number }
export function Tabs({ items, value, onChange, variant = 'pills', label }: { items: TabItem[]; value: string; onChange: (k: string) => void; variant?: 'pills' | 'seg'; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  useLayoutEffect(() => { try { ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch { /* */ } }, [value, items.length]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setFade(edgeFades(el.scrollLeft, el.scrollWidth, el.clientWidth));
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { el.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, [items.length]);
  return (
    <div ref={ref} className={cls('tabs', variant === 'seg' && 'seg', fade.start && 'fade-s', fade.end && 'fade-e')} role="tablist" aria-label={label}>
      {items.map((t) => <button key={t.key} type="button" role="tab" aria-selected={t.key === value} className={t.key === value ? 'on' : ''} onClick={() => onChange(t.key)}>{t.icon && <Icon name={t.icon} size={16} />}{t.label}{!!t.count && t.count > 0 && <span className="nav-badge">{t.count}</span>}</button>)}
    </div>
  );
}

export function ActionBar({ children }: { children: ReactNode }) { return <div className="action-bar">{children}</div>; }

// כותרת המסך בפס העליון; בתוך התוכן רק שורת הסבר ופעולות משניות
export function PageHeader({ title, sub, back = false, onBack = null, actions, text }: { title?: string; sub?: string; back?: boolean; onBack?: (() => void) | null; actions?: ReactNode; text?: ReactNode }) {
  useSetPageHeader(title ?? null, title ? sub : undefined, back, onBack);
  const line = text ?? (title ? null : sub);
  if (!line && !actions) return null;
  return <div className="page-head">{line && <div className="page-head-sub">{line}</div>}{actions && <div className="page-head-actions">{actions}</div>}</div>;
}

export function Money({ a, className }: { a: number | null | undefined; className?: string }) {
  return <span className={cls('money', (a ?? 0) < 0 && 'neg', className)}>{money(a)}</span>;
}

export function Badge({ tone, children }: { tone?: 'ok' | 'warn' | 'info' | 'danger' | 'credit' | 'teal'; children: ReactNode }) {
  return <span className={cls('badge', tone)}>{children}</span>;
}

export function Field({ label, hint, error, wide, children }: { label: string; hint?: string; error?: string; wide?: boolean; children: ReactNode }) {
  return <label className={cls('field', wide && 'wide')}><span>{label}</span>{children}{hint && <small className="hint">{hint}</small>}{error && <small className="err">{error}</small>}</label>;
}

export function Card({ title, icon, children, actions, className }: { title?: ReactNode; icon?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cls('card', className)}>
      {(title || actions) && <div className="page-head head-tight">
        {title && <h2 className="card-title flush">{icon && <Icon name={icon} size={18} />}{title}</h2>}
        {actions && <div className="page-head-actions">{actions}</div>}
      </div>}
      {children}
    </section>
  );
}

// חלון: גיליון תחתון בטלפון, חלון באמצע מ-700px. Esc / רקע = סגירה
export function Modal({ title, onClose, children, size = 'normal', footer }: { title: string; onClose: () => void; children: ReactNode; size?: 'normal' | 'wide' | 'xwide'; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop center-wide" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cls('modal-sheet', size !== 'normal' && size)} role="dialog" aria-modal="true" aria-label={title}>
        <div className="page-head head-tight">
          <h3 className="flush">{title}</h3>
          <button type="button" className="icon-btn plain" aria-label="סגירה" onClick={onClose}><Icon name="x" /></button>
        </div>
        {children}
        {footer && <div className="form-actions">{footer}</div>}
      </div>
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={cls('switch', on && 'on')} onClick={() => onChange(!on)} />;
}
