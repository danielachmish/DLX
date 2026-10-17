// עזרים למסכי המשרד: טווח תאריכים, CSV מקומי, הורדת base64, שגיאות שדות
import { useState } from 'react';
import { Field } from '../../components/ui';
import { ApiError, saveBlob } from '../../lib/api';
import { monthStartIL, todayIL } from '../../lib/format';
import { showToast } from '../../lib/toast';

export function useRange(from = monthStartIL(), to = todayIL()) {
  const [range, setRange] = useState({ from, to });
  return [range, setRange] as const;
}

export function RangeFields({ range, onChange }: { range: { from: string; to: string }; onChange: (r: { from: string; to: string }) => void }) {
  return (
    <>
      <Field label="מתאריך"><input type="date" value={range.from} max={range.to} onChange={(e) => onChange({ ...range, from: e.target.value })} /></Field>
      <Field label="עד תאריך"><input type="date" value={range.to} min={range.from} onChange={(e) => onChange({ ...range, to: e.target.value })} /></Field>
    </>
  );
}

// CSV בעברית לאקסל: UTF-8 עם BOM, הגנה מהזרקת נוסחאות
export function downloadCsv(filename: string, rows: unknown[][]) {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  saveBlob(new Blob(['﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), filename);
}

export function saveBase64(b64: string, filename: string, type = 'text/plain') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  saveBlob(new Blob([bytes], { type }), filename);
}

export const shekels = (a: number | null | undefined) => (a == null ? '' : (a / 100).toFixed(2));

// שגיאת שרת → הודעה כללית + שגיאות לפי שדה
export function apiErrors(e: unknown): { msg: string; fields: Record<string, string> } {
  if (e instanceof ApiError) return { msg: e.message, fields: e.fieldErrors ?? {} };
  return { msg: 'משהו השתבש', fields: {} };
}

export function toastError(e: unknown) { showToast(apiErrors(e).msg, undefined, 'error'); }
