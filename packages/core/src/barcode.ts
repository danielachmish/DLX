// ברקודים (PRD-02, PRD-05, G-17): בדיקת ספרת ביקורת EAN/UPC, וברקוד משקל/מחיר ממאזניים (קידומת 2).
import type { Agorot, QtyMilli } from './money.js';

export function gtinCheckDigit(body: string): number {
  let sum = 0;
  const digits = body.split('').reverse();
  digits.forEach((c, i) => { sum += Number(c) * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10;
}

export function isValidGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  return gtinCheckDigit(code.slice(0, -1)) === Number(code.slice(-1));
}

export function normalizeBarcode(raw: string): string {
  return String(raw ?? '').trim().replace(/\s+/g, '');
}

// ברקוד מאזניים EAN-13: 2 + ספרת סוג + 5 ספרות קוד פריט + 5 ספרות ערך + ביקורת.
// סוג 0–4: הערך הוא משקל בגרמים · 5–9: הערך הוא מחיר באגורות. לפי הגדרות המאזניים בחנות — ניתן לשינוי.
export interface ScaleBarcodeConfig { prefix: string; weightTypes: string; priceTypes: string }
export const DEFAULT_SCALE: ScaleBarcodeConfig = { prefix: '2', weightTypes: '01234', priceTypes: '56789' };

export type ScaleRead = { itemCode: string; qtyMilli: QtyMilli; price?: never } | { itemCode: string; price: Agorot; qtyMilli?: never };

export function parseScaleBarcode(code: string, cfg: ScaleBarcodeConfig = DEFAULT_SCALE): ScaleRead | null {
  if (!/^\d{13}$/.test(code) || !code.startsWith(cfg.prefix) || !isValidGtin(code)) return null;
  const type = code[1]!;
  const itemCode = code.slice(2, 7);
  const value = Number(code.slice(7, 12));
  if (cfg.weightTypes.includes(type)) return { itemCode, qtyMilli: value }; // גרם = אלפית ק"ג
  if (cfg.priceTypes.includes(type)) return { itemCode, price: value };
  return null;
}

// ברקוד פנימי למוצר בלי ברקוד יצרן (INV-09): 29 + 10 ספרות רצות + ביקורת
export function internalBarcode(seq: number): string {
  const body = '29' + String(seq).padStart(10, '0');
  return body + gtinCheckDigit(body);
}
