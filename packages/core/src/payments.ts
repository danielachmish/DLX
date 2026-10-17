// תשלומים בקופה (POS-03, PAY-05): פיצול אמצעים, עודף, עיגול מזומן ומגבלת מזומן.
// העיגול חל רק על החלק שמשולם במזומן; המסמך נשאר בסכום המדויק (G-08 בסקירה).
import type { Agorot } from './money.js';
import { percentOf } from './money.js';
import {
  CASH_LIMIT_BUSINESS_AGOROT, CASH_LIMIT_PRIVATE_AGOROT, CASH_LIMIT_SHARE_BP, CASH_LIMIT_TOURIST_AGOROT,
  type IsoDate, valueOn,
} from './rules.js';

export type PaymentMethod = 'cash' | 'card' | 'check' | 'transfer' | 'bit' | 'credit_note' | 'customer_account';

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  cash: 'מזומן', card: 'אשראי', check: 'שיק', transfer: 'העברה בנקאית', bit: 'ביט / אפליקציה',
  credit_note: 'שובר זיכוי', customer_account: 'הקפה',
};

// עיגול ל-10 אגורות, 5 ומעלה למעלה (1,234 → 1,230 · 1,235 → 1,240)
export function cashRound(a: Agorot): Agorot {
  const sign = Math.sign(a) || 1;
  const abs = Math.abs(a);
  return sign * (Math.floor(abs / 10) * 10 + (abs % 10 >= 5 ? 10 : 0));
}

export interface Tender { method: PaymentMethod; amount: Agorot }

export interface TenderState {
  due: Agorot; // סך המסמך
  applied: Agorot; // מה שנזקף לעסקה (בלי עודף)
  remaining: Agorot; // כמה עוד צריך לשלם (מדויק)
  remainingCash: Agorot; // כמה צריך אם משלמים את היתרה במזומן (מעוגל)
  change: Agorot; // עודף ללקוח
  rounding: Agorot; // הפרש עיגול (חיובי = הלקוח שילם יותר מהמדויק)
  settled: boolean;
}

// tenders בסדר שבו התקבלו. עודף רק ממזומן; אמצעי אחר לא יכול לעבור את היתרה.
export function tenderState(due: Agorot, tenders: Tender[]): TenderState {
  let paid = 0;
  let cash = 0;
  for (const t of tenders) {
    if (t.amount <= 0) throw new Error('סכום תשלום חייב להיות חיובי');
    if (t.method !== 'cash' && paid + t.amount > due) throw new Error(`${PAYMENT_LABEL[t.method]}: הסכום גדול מהיתרה`);
    paid += t.amount;
    if (t.method === 'cash') cash += t.amount;
  }
  const nonCash = paid - cash;
  const cashDueExact = Math.max(0, due - nonCash);
  const cashDue = cash > 0 ? cashRound(cashDueExact) : cashDueExact;
  const settled = cash >= cashDue && nonCash <= due;
  const rounding = settled && cash > 0 ? cashDue - cashDueExact : 0;
  const change = settled ? cash - cashDue : 0;
  const remaining = Math.max(0, due - paid);
  return {
    due, applied: settled ? due + rounding : paid, remaining: settled ? 0 : remaining,
    remainingCash: settled ? 0 : Math.max(0, cashRound(cashDueExact) - cash), change, rounding, settled,
  };
}

export type Counterparty = 'consumer' | 'business' | 'tourist';

// חוק לצמצום השימוש במזומן: בעסקה שמחירה הכולל מעל הסף, מותר מזומן עד 10% מהמחיר.
// מחזיר את המקסימום המותר במזומן, ו-null כשאין מגבלה.
export function maxCashAllowed(total: Agorot, date: IsoDate, party: Counterparty = 'consumer'): Agorot | null {
  // מכירה בחנות: העוסק תמיד צד לעסקה → סף העוסק; תייר — סף נפרד (לאמת)
  const limit = party === 'tourist' ? valueOn(CASH_LIMIT_TOURIST_AGOROT, date) : valueOn(CASH_LIMIT_BUSINESS_AGOROT, date);
  if (total < limit) return null;
  return percentOf(total, CASH_LIMIT_SHARE_BP);
}

export const privateCashLimit = (date: IsoDate) => valueOn(CASH_LIMIT_PRIVATE_AGOROT, date);

export function cashLimitError(total: Agorot, cash: Agorot, date: IsoDate, party: Counterparty = 'consumer'): string | null {
  const max = maxCashAllowed(total, date, party);
  if (max == null || cash <= max) return null;
  return `לפי חוק צמצום השימוש במזומן מותר לקבל במזומן עד ${(max / 100).toLocaleString('he-IL')} ₪ בעסקה הזו`;
}
