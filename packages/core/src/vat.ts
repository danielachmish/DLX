// מע"מ (D09): המחיר לצרכן כולל מע"מ, והמע"מ מחולץ ממנו. עוסק פטור — אין מע"מ בכלל.
import { type Agorot, BP_100, symmetricRound } from './money.js';
import { type IsoDate, VAT_RATE_BP, valueOn } from './rules.js';

export type TaxStatus = 'murshe' | 'company' | 'patur';
// standard — מע"מ רגיל · zero — שיעור אפס (פירות וירקות טריים) · exempt — פטור
export type TaxCategory = 'standard' | 'zero' | 'exempt';
// eilat — אזור אילת: מכירת טובין בשיעור אפס (לאמת את התנאים מול יועץ מס)
export type TaxZone = 'regular' | 'eilat';

export interface TaxContext { date: IsoDate; status: TaxStatus; zone: TaxZone }

export const chargesVat = (status: TaxStatus) => status !== 'patur';

export function vatRateBp(category: TaxCategory, ctx: TaxContext): number {
  if (!chargesVat(ctx.status)) return 0;
  if (category !== 'standard') return 0;
  if (ctx.zone === 'eilat') return 0;
  return valueOn(VAT_RATE_BP, ctx.date);
}

// מחיר כולל → { נטו, מע"מ }. המע"מ מעוגל לאגורה, הנטו הוא השארית — כך שנטו + מע"מ = כולל תמיד
export function splitGross(gross: Agorot, rateBp: number): { net: Agorot; vat: Agorot } {
  if (rateBp === 0) return { net: gross, vat: 0 };
  const vat = symmetricRound((gross * rateBp) / (BP_100 + rateBp));
  return { net: gross - vat, vat };
}

// נטו → כולל (לחשבונית ספק / מחירון B2B)
export function grossFromNet(net: Agorot, rateBp: number): Agorot {
  return net + symmetricRound((net * rateBp) / BP_100);
}

export const formatRate = (bp: number) => `${(bp / 100).toLocaleString('he-IL', { maximumFractionDigits: 2 })}%`;
