// כסף ב-DLX: תמיד מספר שלם באגורות. אף פעם לא float על שקלים (ר' "קשרים והגבלות בסיס נתונים" באפיון).
// כמות: מספר שלם באלפיות יחידה (qtyMilli) — 1 יחידה = 1000, 0.250 ק"ג = 250 — כך שגם מוצר שקיל מדויק.

export type Agorot = number;
export type QtyMilli = number;

export const QTY_UNIT = 1000;
export const BP_100 = 10_000; // נקודות בסיס: 10,000 = 100%

export class MoneyError extends Error {}

export function assertAgorot(n: number, what = 'סכום'): Agorot {
  if (!Number.isSafeInteger(n)) throw new MoneyError(`${what} חייב להיות מספר שלם באגורות (קיבלנו ${n})`);
  return n;
}

// מחיר ליחידה × כמות באלפיות → סכום באגורות
export function lineAmount(unitPrice: Agorot, qtyMilli: QtyMilli): Agorot {
  assertAgorot(unitPrice, 'מחיר ליחידה');
  if (!Number.isSafeInteger(qtyMilli)) throw new MoneyError('כמות חייבת להיות שלמה באלפיות');
  return symmetricRound((unitPrice * qtyMilli) / QTY_UNIT);
}

// עיגול חצי-למעלה, סימטרי סביב אפס (−2.5 → −3) — כדי שזיכוי יהיה בדיוק ההפך של חיוב.
// המונה תמיד שלם והמכנה 1000 / 10,000, כך ש-.5 מיוצג במדויק ואין סטיית float.
export function symmetricRound(n: number): number {
  const s = Math.sign(n);
  return s * Math.round(Math.abs(n));
}

// אחוז בנקודות בסיס מתוך סכום (1250 = 12.5%)
export function percentOf(amount: Agorot, bp: number): Agorot {
  return symmetricRound((amount * bp) / BP_100);
}

// חלוקת סכום בין שורות לפי משקל, בלי לאבד אגורה (שיטת השארית הגדולה).
// משמש לפיזור הנחת עגלה על השורות — סכום החלקים תמיד שווה בדיוק לסכום.
export function allocate(total: Agorot, weights: number[]): Agorot[] {
  assertAgorot(total);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const sign = Math.sign(total) || 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (abs * w) / sum);
  const base = raw.map((r) => Math.floor(r));
  let rest = abs - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (rest <= 0) break;
    base[o.i]! += 1;
    rest -= 1;
  }
  return base.map((b) => b * sign);
}

// "12.5" / "12,5" / "₪1,234.50" → 1250 / 123450. לא מספר → null
export function parseShekels(input: string): Agorot | null {
  const s = String(input ?? '').replace(/[₪\s]/g, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const v = Number(i) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -v : v;
}

// "1.250" → 1250 (אלפיות). כמות שלמה "3" → 3000
export function parseQty(input: string): QtyMilli | null {
  const s = String(input ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{0,3})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  return Number(i) * QTY_UNIT + Number((f + '000').slice(0, 3));
}

// תצוגה: ₪ לפני המספר, תמיד עם אגורות (מסמכים וקופה), מינוס אמיתי
export function formatAgorot(a: Agorot | null | undefined): string {
  if (a == null || !Number.isFinite(a)) return '—';
  const abs = Math.abs(a);
  const text = (abs / 100).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${a < 0 ? '−' : ''}₪${text}`;
}

export function formatQty(q: QtyMilli): string {
  if (q % QTY_UNIT === 0) return String(q / QTY_UNIT);
  return (q / QTY_UNIT).toFixed(3).replace(/0+$/, '');
}
