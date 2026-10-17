// מקלדת מספרים לקופה (D-03): כמות, מחיר, מזומן שהתקבל. עובד גם עם מקלדת פיזית (ספרות, נקודה, Backspace, Enter).
import { useEffect } from 'react';
import Icon from './Icon';

export default function NumPad({ value, onChange, onEnter, decimals = 2, enterLabel = 'אישור' }: { value: string; onChange: (v: string) => void; onEnter?: () => void; decimals?: number; enterLabel?: string }) {
  const press = (k: string) => {
    if (k === 'back') return onChange(value.slice(0, -1));
    if (k === 'clear') return onChange('');
    if (k === '.') { if (decimals === 0 || value.includes('.')) return; return onChange((value || '0') + '.'); }
    const [, frac = ''] = value.split('.');
    if (value.includes('.') && frac.length >= decimals) return;
    if (value === '0') return onChange(k);
    onChange(value + k);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === '.' || e.key === ',') { e.preventDefault(); press('.'); }
      else if (e.key === 'Backspace') { e.preventDefault(); press('back'); }
      else if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3'];
  return (
    <div>
      <div className="numpad-display" aria-live="polite">{value || '0'}</div>
      <div className="numpad">
        {keys.map((k) => <button key={k} type="button" onClick={() => press(k)}>{k}</button>)}
        <button type="button" onClick={() => press('.')} disabled={decimals === 0} aria-label="נקודה">.</button>
        <button type="button" onClick={() => press('0')}>0</button>
        <button type="button" onClick={() => press('back')} aria-label="מחיקה"><Icon name="backspace" /></button>
      </div>
      {onEnter && <button type="button" className="action-btn" onClick={onEnter}>{enterLabel}</button>}
    </div>
  );
}
