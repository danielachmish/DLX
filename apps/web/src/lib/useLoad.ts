// טעינה אחידה למסך: טוען (שלד) · שגיאה (LoadError) · ריק (EmptyState) · מוכן. שגיאת שרת אף פעם לא נראית כמו "אין נתונים".
import { useCallback, useEffect, useRef, useState } from 'react';

export function errorInfo(error: any, what = 'הנתונים') {
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const offline = !error?.serverError && (!online || !!error?.offline);
  if (offline) return { offline: true, title: `אין חיבור — ${what} לא נטענו`, text: 'כשהחיבור יחזור — לחצו "נסו שוב".' };
  const msg = typeof error === 'string' ? error : error?.message;
  const hebrew = !error?.serverError && !!msg && /[֐-׿]/.test(msg);
  return { offline: false, title: `לא הצלחנו לטעון את ${what}`, text: hebrew ? msg : 'משהו השתבש. נסו שוב בעוד רגע.' };
}

export function loadPhase<T>({ data, error, loading }: { data: T | undefined; error: unknown; loading: boolean }, isEmpty: (d: T) => boolean = (d: any) => d == null || (Array.isArray(d) && d.length === 0)) {
  const has = data !== undefined;
  if (!has && loading) return 'loading' as const;
  if (!has && error) return 'error' as const;
  if (!has) return 'loading' as const;
  return isEmpty(data as T) ? ('empty' as const) : ('ready' as const);
}

export function useLoad<T = any>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data: T | undefined; error: any; loading: boolean }>({ data: undefined, error: null, loading: true });
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(() => {
    const my = ++seq.current;
    setState((s) => ({ ...s, error: null, loading: true }));
    return Promise.resolve().then(() => fnRef.current()).then(
      (data) => { if (my === seq.current) setState({ data, error: null, loading: false }); return data; },
      (error) => { if (my === seq.current) setState((s) => ({ ...s, error, loading: false })); });
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); return () => { seq.current += 1; }; }, deps);
  const setData = useCallback((d: T | ((p: T | undefined) => T)) => setState((s) => ({ ...s, data: typeof d === 'function' ? (d as any)(s.data) : d })), []);
  return { ...state, reload, setData };
}
