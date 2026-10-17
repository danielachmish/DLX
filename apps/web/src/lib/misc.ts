import { useEffect, useRef, useState } from 'react';

// באיזה קצה של שורת לשוניות יש עוד לשוניות מוסתרות (RTL: לפי ערך מוחלט)
export function edgeFades(scrollLeft: number, scrollWidth: number, clientWidth: number, slack = 2) {
  const max = scrollWidth - clientWidth;
  if (max <= slack) return { start: false, end: false };
  const pos = Math.abs(scrollLeft);
  return { start: pos > slack, end: pos < max - slack };
}

// בחירה במסך (לשונית / מסנן) שנשמרת ברענון — רק במכשיר הזה
export function useSavedState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = sessionStorage.getItem(`dlx:${key}`); return s ? (JSON.parse(s) as T) : initial; } catch { return initial; }
  });
  const set = (x: T) => { setV(x); try { sessionStorage.setItem(`dlx:${key}`, JSON.stringify(x)); } catch { /* */ } };
  return [v, set];
}

export function useOnline() {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const up = () => setOn(true); const down = () => setOn(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return on;
}

// סורק ברקוד במצב HID (D10): מקליד מהר ומסיים ב-Enter. מזהה רצף מהיר גם כשהפוקוס לא בשדה,
// כך שסריקה תמיד מגיעה לקופה (UX-02). לא מפריע להקלדה רגילה בשדות טקסט.
export function useBarcodeScanner(onScan: (code: string) => void, enabled = true) {
  const buf = useRef('');
  const last = useRef(0);
  const cb = useRef(onScan);
  cb.current = onScan;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (inField) return; // בשדה — השדה עצמו מטפל (Enter)
      const now = performance.now();
      if (now - last.current > 60) buf.current = '';
      last.current = now;
      if (e.key === 'Enter') {
        if (buf.current.length >= 4) { e.preventDefault(); cb.current(buf.current); }
        buf.current = '';
        return;
      }
      if (e.key.length === 1 && /[0-9A-Za-z]/.test(e.key)) buf.current += e.key;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

// הדפסה של HTML מהשרת (קבלה 80mm / A4) דרך iframe נסתר — עובד בכל דפדפן, כולל ספארי באייפד
export function printHtml(html: string) {
  const f = document.createElement('iframe');
  f.style.position = 'fixed'; f.style.width = '0'; f.style.height = '0'; f.style.border = '0'; f.style.inset = 'auto 0 0 auto';
  document.body.appendChild(f);
  const d = f.contentDocument!;
  d.open(); d.write(html); d.close();
  const go = () => { try { f.contentWindow!.focus(); f.contentWindow!.print(); } finally { setTimeout(() => f.remove(), 60_000); } };
  if (d.readyState === 'complete') setTimeout(go, 150); else f.onload = () => setTimeout(go, 150);
}

export const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');
