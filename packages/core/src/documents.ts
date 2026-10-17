// סוגי מסמכים (FIS-01, DOC-04, D16): מה מותר לכל סוג עסק, ברירת המחדל בקופה, וחובת מספר הקצאה.
// הקודים — לפי טבלת סוגי המסמכים של המבנה האחיד (לאמת מול מפרט 1.31). מטריצה לאישור רו"ח: docs/decisions.md.
import type { Agorot } from './money.js';
import { ALLOCATION_THRESHOLD_AGOROT, type IsoDate, valueOn } from './rules.js';
import type { TaxStatus } from './vat.js';

export type DocType = 'tax_invoice' | 'tax_invoice_receipt' | 'credit_invoice' | 'receipt' | 'deal_invoice' | 'delivery_note' | 'return_note';

export interface DocTypeInfo {
  code: number;
  title: string;
  fiscal: boolean; // מסמך שנכנס למבנה האחיד ולספרים
  carriesVat: boolean; // מסמך מס (305/320/330)
  isCredit: boolean;
  hasPayment: boolean; // כולל תיעוד תקבול
  allowed: readonly TaxStatus[];
}

const ALL: readonly TaxStatus[] = ['murshe', 'company', 'patur'];
const VAT_REG: readonly TaxStatus[] = ['murshe', 'company'];

export const DOC_TYPES: Record<DocType, DocTypeInfo> = {
  tax_invoice: { code: 305, title: 'חשבונית מס', fiscal: true, carriesVat: true, isCredit: false, hasPayment: false, allowed: VAT_REG },
  tax_invoice_receipt: { code: 320, title: 'חשבונית מס / קבלה', fiscal: true, carriesVat: true, isCredit: false, hasPayment: true, allowed: VAT_REG },
  credit_invoice: { code: 330, title: 'חשבונית מס זיכוי', fiscal: true, carriesVat: true, isCredit: true, hasPayment: false, allowed: VAT_REG },
  receipt: { code: 400, title: 'קבלה', fiscal: true, carriesVat: false, isCredit: false, hasPayment: true, allowed: ALL },
  deal_invoice: { code: 300, title: 'חשבונית עסקה', fiscal: true, carriesVat: false, isCredit: false, hasPayment: false, allowed: ALL },
  delivery_note: { code: 200, title: 'תעודת משלוח', fiscal: true, carriesVat: false, isCredit: false, hasPayment: false, allowed: ALL },
  return_note: { code: 210, title: 'תעודת החזרה', fiscal: true, carriesVat: false, isCredit: true, hasPayment: false, allowed: ALL },
};

export const docTypeByCode = (code: number): DocType | undefined =>
  (Object.keys(DOC_TYPES) as DocType[]).find((t) => DOC_TYPES[t].code === code);

export class DocumentRuleError extends Error {}

// QA-07: עסק שאינו רשאי — חסום, גם ב-API
export function assertDocAllowed(type: DocType, status: TaxStatus): void {
  if (!DOC_TYPES[type].allowed.includes(status)) {
    throw new DocumentRuleError(`${DOC_TYPES[type].title} אינה מותרת ל${STATUS_LABEL[status]}`);
  }
}

export const STATUS_LABEL: Record<TaxStatus, string> = { murshe: 'עוסק מורשה', company: 'חברה', patur: 'עוסק פטור' };

// מסמך המכירה בקופה (מכירה ששולמה במלואה)
export function posSaleDocType(status: TaxStatus): DocType {
  return status === 'patur' ? 'receipt' : 'tax_invoice_receipt';
}

// מסמך ההחזר בקופה
export function posReturnDocType(status: TaxStatus): DocType {
  return status === 'patur' ? 'return_note' : 'credit_invoice';
}

export interface AllocationQuery {
  date: IsoDate;
  type: DocType;
  issuerStatus: TaxStatus;
  customerVatId?: string | null; // מספר עוסק של הלקוח (רק לקוח עסקי)
  netBeforeVat: Agorot;
}

// חשבוניות ישראל (API-01, QA-09): מספר הקצאה נדרש לחשבונית מס ללקוח עסקי מעל הסף (לפני מע"מ).
// זיכוי — לא (לאמת). הסף משתנה לפי תאריך המסמך.
export function allocationRequired(q: AllocationQuery): boolean {
  const info = DOC_TYPES[q.type];
  if (!info.carriesVat || info.isCredit) return false;
  if (q.issuerStatus === 'patur') return false;
  if (!q.customerVatId) return false;
  return Math.abs(q.netBeforeVat) >= valueOn(ALLOCATION_THRESHOLD_AGOROT, q.date);
}

export const allocationThreshold = (date: IsoDate) => valueOn(ALLOCATION_THRESHOLD_AGOROT, date);

// FIS-05: הדפסה ראשונה = "מקור", כל הדפסה אחריה = "העתק נאמן למקור"
export const printMark = (printCount: number) => (printCount === 0 ? 'מקור' : 'העתק נאמן למקור');
