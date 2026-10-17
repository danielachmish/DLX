// החזרות (RET-01, RET-02, T15, T16): אי אפשר להחזיר יותר ממה שנמכר, בניכוי החזרות קודמות.
// הסכום המוחזר לכל יחידה הוא החלק היחסי של סך השורה (אחרי הנחות), כך שהחזרת כל השורה = בדיוק מה ששולם.
import { type Agorot, type QtyMilli, symmetricRound } from './money.js';

export interface SoldLine { lineId: string; qtyMilli: QtyMilli; total: Agorot; returnedQtyMilli: QtyMilli; returnedTotal: Agorot }

export const returnableQty = (l: SoldLine): QtyMilli => l.qtyMilli - l.returnedQtyMilli;

export class ReturnError extends Error {}

export function refundForLine(l: SoldLine, qtyMilli: QtyMilli): Agorot {
  if (qtyMilli <= 0) throw new ReturnError('כמות להחזרה חייבת להיות חיובית');
  const left = returnableQty(l);
  if (qtyMilli > left) throw new ReturnError(`אפשר להחזיר עד ${left / 1000} יחידות מהשורה הזו`);
  // היחידות האחרונות שנשארו לוקחות את כל היתרה — אין אגורה אבודה
  if (qtyMilli === left) return l.total - l.returnedTotal;
  return symmetricRound((l.total * qtyMilli) / l.qtyMilli);
}

// תקנות הגנת הצרכן (מדיניות החזרת טובין): ברירת מחדל 14 יום, אם העסק לא פרסם מדיניות אחרת (לאמת)
export const DEFAULT_RETURN_DAYS = 14;

export function withinReturnWindow(soldAt: Date, at: Date, days = DEFAULT_RETURN_DAYS): boolean {
  return at.getTime() - soldAt.getTime() <= days * 24 * 3600 * 1000;
}
