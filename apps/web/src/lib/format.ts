// תצוגה בלבד. כסף מגיע מהשרת באגורות (מספר שלם). בקופה ובמסמכים — תמיד עם אגורות (D-01 בסקירה).
import { formatAgorot, formatQty } from '@dlx/core';

export const money = (a: number | null | undefined) => formatAgorot(a ?? null);
export const moneyShort = (a: number | null | undefined) => {
  if (a == null) return '—';
  const n = a / 100;
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1e6) return `${sign}₪${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${sign}₪${Math.round(abs / 1000)}K`;
  return `${sign}₪${Math.round(abs).toLocaleString('he-IL')}`;
};
export const qty = (m: number | null | undefined) => (m == null ? '—' : formatQty(m));
export const toShekelInput = (a: number | null | undefined) => (a == null ? '' : (a / 100).toFixed(2));

const TZ = 'Asia/Jerusalem';
export function dateTime(v: string | null | undefined) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('he-IL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export function dateOnly(v: string | null | undefined) {
  if (!v) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split('-').reverse().join('.');
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('he-IL', { timeZone: TZ });
}
export function timeOnly(v: string | null | undefined) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}
export const todayIL = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
export function daysAgoIL(n: number) {
  const d = new Date(Date.now() - n * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}
export const monthStartIL = () => `${todayIL().slice(0, 8)}01`;

export const DOC_TITLE: Record<string, string> = {
  tax_invoice: 'חשבונית מס', tax_invoice_receipt: 'חשבונית מס / קבלה', credit_invoice: 'חשבונית מס זיכוי', receipt: 'קבלה',
  deal_invoice: 'חשבונית עסקה', delivery_note: 'תעודת משלוח', return_note: 'תעודת החזרה',
};
export const PAY_LABEL: Record<string, string> = {
  cash: 'מזומן', card: 'אשראי', check: 'שיק', transfer: 'העברה בנקאית', bit: 'ביט / אפליקציה', credit_note: 'שובר זיכוי', customer_account: 'הקפה',
};
