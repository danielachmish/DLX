// כללי מכירה רגולטוריים בקופה (G-11, G-12 בסקירה): מוצר מוגבל בגיל ושעות מכירת אלכוהול.
import { ALCOHOL_BLOCK } from './rules.js';

export type Restriction = 'none' | 'age18' | 'alcohol' | 'tobacco';

export const RESTRICTION_LABEL: Record<Restriction, string> = {
  none: 'ללא', age18: 'מגיל 18', alcohol: 'אלכוהול (מגיל 18, לא בין 23:00 ל-06:00)', tobacco: 'טבק (מגיל 18)',
};

export const needsAgeCheck = (r: Restriction) => r !== 'none';

// השעה בישראל (בלי תלות באזור הזמן של השרת / המכשיר)
export function israelHour(at: Date): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(at);
  return Number(h);
}

export function israelDate(at: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return p; // YYYY-MM-DD
}

// null = מותר; אחרת — למה חסום
export function saleBlockReason(r: Restriction, at: Date): string | null {
  if (r !== 'alcohol') return null;
  const h = israelHour(at);
  const { fromHour, toHour } = ALCOHOL_BLOCK;
  const blocked = fromHour > toHour ? h >= fromHour || h < toHour : h >= fromHour && h < toHour;
  return blocked ? 'אסור למכור משקה משכר בחנות בין 23:00 ל-06:00' : null;
}

// מספר זהות / עוסק / ח"פ ישראלי — 9 ספרות עם ספרת ביקורת
export function isValidIsraeliId(raw: string): boolean {
  const s = String(raw ?? '').replace(/\D/g, '');
  if (s.length < 5 || s.length > 9) return false;
  const id = s.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(id[i]) * ((i % 2) + 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}
