// כללים רגולטוריים עם תאריכי תחולה (ACC-05, FIN-01, API-01). ערכים כאן — לא בקוד קשיח במקומות אחרים.
// כל ערך חייב אימות מול המקור הרשמי לפני ייצור (docs/decisions.md, "ספים ותאריכים").
// עדכון חקיקה = שורה חדשה עם from עתידי; שורות קיימות לא משתנים, כך שמסמכי עבר לא מושפעים (QA-08).

export type IsoDate = string; // YYYY-MM-DD

export interface Dated<T> { from: IsoDate; value: T }

export function valueOn<T>(table: readonly Dated<T>[], date: IsoDate): T {
  let hit: Dated<T> | undefined;
  for (const row of table) if (row.from <= date && (!hit || row.from > hit.from)) hit = row;
  if (!hit) throw new Error(`אין ערך בתוקף לתאריך ${date}`);
  return hit.value;
}

// שיעור מע"מ בנקודות בסיס (1800 = 18%)
export const VAT_RATE_BP: readonly Dated<number>[] = [
  { from: '2015-10-01', value: 1700 },
  { from: '2025-01-01', value: 1800 },
];

// חשבוניות ישראל: סף מספר הקצאה — סכום לפני מע"מ, באגורות
export const ALLOCATION_THRESHOLD_AGOROT: readonly Dated<number>[] = [
  { from: '2024-05-05', value: 25_000_00 },
  { from: '2025-01-01', value: 20_000_00 },
  { from: '2026-01-01', value: 10_000_00 },
  { from: '2026-06-01', value: 5_000_00 },
];

// חוק לצמצום השימוש במזומן — עסקה שעוסק צד לה: מעל הסף, מזומן עד 10% מהמחיר
export const CASH_LIMIT_BUSINESS_AGOROT: readonly Dated<number>[] = [{ from: '2022-08-01', value: 6_000_00 }];
export const CASH_LIMIT_PRIVATE_AGOROT: readonly Dated<number>[] = [{ from: '2022-08-01', value: 15_000_00 }];
export const CASH_LIMIT_TOURIST_AGOROT: readonly Dated<number>[] = [{ from: '2022-08-01', value: 55_000_00 }];
export const CASH_LIMIT_SHARE_BP = 1000; // 10%

// חוק הפיקדון על מכלי משקה
export const BOTTLE_DEPOSIT_AGOROT: readonly Dated<number>[] = [{ from: '2001-10-01', value: 30 }];

// שעות שבהן אסור למכור אלכוהול בחנות (שעון ישראל), [from, to)
export const ALCOHOL_BLOCK = { fromHour: 23, toHour: 6 } as const;

export const RETENTION_YEARS = 7;
