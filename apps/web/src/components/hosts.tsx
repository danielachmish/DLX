// מצויר פעם אחת ב-main: חלונות שאלה והודעות צפות — כך שאפשר לשאול / להודיע מכל מקום
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { answerDialog, cancelDialog, type DialogState, onDialog } from '../lib/dialogs';
import { onToast, type Toast } from '../lib/toast';
import Icon from './Icon';

export function DialogHost() {
  const [d, setD] = useState<DialogState | null>(null);
  useEffect(() => onDialog(setD), []);
  if (!d) return null;
  return <Dialog key={d.id} d={d} />;
}

function Dialog({ d }: { d: DialogState }) {
  const [value, setValue] = useState(d.initial || '');
  const [err, setErr] = useState('');
  const first = useRef<any>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancelDialog(d.id); } };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); try { before?.focus?.(); } catch { /* */ } };
  }, [d.id]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (d.required && !v) { setErr('צריך למלא כאן משהו'); return; }
    const bad = d.validate?.(v);
    if (bad) { setErr(bad); return; }
    answerDialog(d.id, v);
  };
  const icon = d.icon || (d.danger ? 'alert' : d.kind === 'text' ? 'edit' : 'help');
  const titleId = `dlg-t-${d.id}`;
  return (
    <div className="modal-backdrop center-wide dlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) cancelDialog(d.id); }}>
      <div className={'modal-sheet dlg' + (d.danger ? ' danger' : '')} role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dlg-head">
          <span className="dlg-icon" aria-hidden="true"><Icon name={icon} size={22} /></span>
          <div><h3 className="dlg-title" id={titleId}>{d.title}</h3>{d.text && <p className="dlg-text">{d.text}</p>}</div>
        </div>
        {d.kind === 'confirm' && (
          <div className="dlg-actions">
            <button type="button" ref={d.danger ? null : first} className={'action-btn' + (d.danger ? ' danger' : '')} onClick={() => answerDialog(d.id, true)}>{d.confirmLabel}</button>
            <button type="button" ref={d.danger ? first : null} className="action-btn ghost" onClick={() => cancelDialog(d.id)}>{d.cancelLabel}</button>
          </div>
        )}
        {d.kind === 'text' && (
          <form onSubmit={submit} noValidate>
            <label className="dlg-field">
              {d.label && <span>{d.label}</span>}
              {d.multiline
                ? <textarea ref={first} rows={3} value={value} placeholder={d.placeholder} onChange={(e) => { setValue(e.target.value); setErr(''); }} />
                : <input ref={first} type={d.type || 'text'} inputMode={d.inputMode} value={value} placeholder={d.placeholder} autoComplete="off" onChange={(e) => { setValue(e.target.value); setErr(''); }} />}
            </label>
            {err && <div className="dlg-err" role="alert">{err}</div>}
            <div className="dlg-actions">
              <button type="submit" className={'action-btn' + (d.danger ? ' danger' : '')}>{d.confirmLabel}</button>
              <button type="button" className="action-btn ghost" onClick={() => cancelDialog(d.id)}>{d.cancelLabel}</button>
            </div>
          </form>
        )}
        {d.kind === 'choice' && (
          <div className="dlg-choices">
            {d.options!.map((o, i) => <button key={o.value} type="button" ref={i === 0 ? first : null} className={'action-btn' + (o.danger ? ' danger-soft' : o.primary || i === 0 ? '' : ' secondary')} onClick={() => answerDialog(d.id, o.value)}>{o.label}</button>)}
            <button type="button" className="action-btn ghost" onClick={() => cancelDialog(d.id)}>{d.cancelLabel}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ToastStack() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => onToast((t) => {
    setToasts((p) => [...p, t]);
    setTimeout(() => setToasts((p) => p.filter((x) => x.id !== t.id)), t.action ? 6000 : t.tone === 'error' ? 6000 : 3500);
  }), []);
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}>
          <span>{t.text}</span>
          {t.action && <button className="toast-action" onClick={() => { t.action!.onClick(); setToasts((p) => p.filter((x) => x.id !== t.id)); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
