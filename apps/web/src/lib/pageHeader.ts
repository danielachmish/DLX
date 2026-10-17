// כותרת מסך בפס העליון (מערכת העיצוב): מסך פנימי מודיע מה לכתוב בפס, והפס מצויר ב-App.
import { useEffect, useRef, useState } from 'react';

export interface Header { title: string; sub?: string; back?: boolean; onBack?: (() => void) | null }
let entries: { h: Header | null; at: number }[] = [];
let current: Header | null = null;
let listeners: ((h: Header | null) => void)[] = [];
let seq = 0;

function apply() {
  const top = entries.filter((e) => e.h).sort((a, b) => b.at - a.at)[0];
  current = top?.h ?? null;
  listeners.forEach((l) => l(current));
}

export function usePageHeaderState() {
  const [h, setH] = useState(current);
  useEffect(() => { listeners.push(setH); setH(current); return () => { listeners = listeners.filter((l) => l !== setH); }; }, []);
  return h;
}

export function useSetPageHeader(title: string | null, sub?: string, back = false, onBack: (() => void) | null = null) {
  const entry = useRef<{ h: Header | null; at: number }>({ h: null, at: 0 });
  const backFn = useRef(onBack);
  backFn.current = onBack;
  useEffect(() => {
    entry.current.h = title ? { title, sub, back: back || !!onBack, onBack: onBack ? () => backFn.current?.() : null } : null;
    entry.current.at = ++seq;
    if (!entries.includes(entry.current)) entries.push(entry.current);
    apply();
  }, [title, sub, back, !!onBack]);
  useEffect(() => () => { entries = entries.filter((e) => e !== entry.current); apply(); }, []);
}
