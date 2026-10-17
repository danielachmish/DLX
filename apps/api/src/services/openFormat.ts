// קובץ במבנה אחיד (נספח ה', OPEN-01..OPEN-03) — טיוטה.
// ⚠ רוחבי השדות והסדר כאן נכתבו לפי הזיכרון של מפרט 1.31 ולא הושוו למסמך הרשמי. לפני הגשת רישום:
//   1. להשוות כל רשומה לטבלאות המפרט (IncomeTax_horaot_131.pdf).  2. להריץ בסימולטור של רשות המסים (T31).
// המבנה (מפרט שדות → כתיבה ברוחב קבוע → קידוד ISO-8859-8) בנוי כך שתיקון שדה הוא שינוי של שורה אחת.
import { DOC_TYPES, type DocType } from '@dlx/core';

type Kind = 'X' | 'N' | 'A' | 'Q'; // X טקסט · N מספר בלי סימן · A סכום עם סימן ו-2 ספרות אחרי הנקודה · Q כמות עם סימן ו-4 ספרות
interface Field { name: string; width: number; kind: Kind }
const f = (name: string, width: number, kind: Kind = 'X'): Field => ({ name, width, kind });

export const SPEC_VERSION = '1.31';
export const SPEC_CONSTANT = '&OF1.31&';

export const RECORDS: Record<string, Field[]> = {
  A100: [f('code', 4), f('recNo', 9, 'N'), f('vatId', 9, 'N'), f('primaryId', 15, 'N'), f('constant', 8), f('reserved', 50)],
  C100: [
    f('code', 4), f('recNo', 9, 'N'), f('vatId', 9, 'N'), f('docType', 3, 'N'), f('docNumber', 20), f('docDate', 8, 'N'), f('docTime', 4, 'N'),
    f('customerName', 50), f('customerStreet', 50), f('customerHouse', 10), f('customerCity', 30), f('customerZip', 8), f('customerCountry', 30),
    f('countryCode', 2), f('customerPhone', 15), f('customerVatId', 9, 'N'), f('valueDate', 8, 'N'), f('foreignAmount', 15, 'A'), f('currency', 3),
    f('amountBeforeDiscount', 15, 'A'), f('discount', 15, 'A'), f('amountAfterDiscountNoVat', 15, 'A'), f('vat', 15, 'A'), f('total', 15, 'A'),
    f('withholding', 12, 'A'), f('customerKey', 15), f('matchField', 10), f('cancelled', 1), f('docDateDup', 8, 'N'), f('branchId', 7), f('user', 9), f('linkField', 7, 'N'), f('reserved', 13),
  ],
  D110: [
    f('code', 4), f('recNo', 9, 'N'), f('vatId', 9, 'N'), f('docType', 3, 'N'), f('docNumber', 20), f('lineNo', 4, 'N'), f('baseDocType', 3, 'N'),
    f('baseDocNumber', 20), f('transactionType', 1, 'N'), f('itemCode', 20), f('description', 30), f('manufacturer', 50), f('serial', 30),
    f('unit', 20), f('qty', 17, 'Q'), f('unitPrice', 15, 'A'), f('lineDiscount', 15, 'A'), f('lineTotal', 15, 'A'), f('vatRate', 4, 'N'),
    f('branchId', 7), f('docDate', 8, 'N'), f('linkC100', 7, 'N'), f('baseBranch', 7), f('reserved', 21),
  ],
  D120: [
    f('code', 4), f('recNo', 9, 'N'), f('vatId', 9, 'N'), f('docType', 3, 'N'), f('docNumber', 20), f('lineNo', 4, 'N'), f('payMethod', 1, 'N'),
    f('bank', 10, 'N'), f('bankBranch', 10, 'N'), f('account', 15, 'N'), f('checkNumber', 10, 'N'), f('dueDate', 8, 'N'), f('amount', 15, 'A'),
    f('clearingCompany', 1, 'N'), f('cardName', 20), f('creditType', 1, 'N'), f('branchId', 7), f('docDate', 8, 'N'), f('linkC100', 7, 'N'), f('reserved', 60),
  ],
  M100: [
    f('code', 4), f('recNo', 9, 'N'), f('vatId', 9, 'N'), f('universalCode', 20), f('supplierCode', 20), f('itemCode', 20), f('name', 50),
    f('sortCode', 10), f('sortName', 30), f('unit', 20), f('openingQty', 12, 'Q'), f('totalIn', 12, 'Q'), f('totalOut', 12, 'Q'),
    f('costInPeriod', 10, 'A'), f('costOutPeriod', 10, 'A'), f('reserved', 50),
  ],
  Z900: [f('code', 4), f('recNo', 9, 'N'), f('vatId', 9, 'N'), f('primaryId', 15, 'N'), f('constant', 8), f('reserved', 15), f('totalRecords', 15, 'N'), f('reserved2', 50)],
};

function fmt(field: Field, v: unknown): string {
  const w = field.width;
  if (field.kind === 'X') return String(v ?? '').replace(/[\r\n]/g, ' ').slice(0, w).padEnd(w, ' ');
  if (field.kind === 'N') return String(Math.trunc(Math.abs(Number(v ?? 0)))).slice(-w).padStart(w, '0');
  // A: סכום באגורות → סימן + ספרות (2 אחרונות = אגורות). Q: כמות באלפיות → 4 ספרות אחרי הנקודה
  const n = Number(v ?? 0);
  const digits = field.kind === 'Q' ? String(Math.abs(n) * 10) : String(Math.abs(n));
  return (n < 0 ? '-' : '+') + digits.slice(-(w - 1)).padStart(w - 1, '0');
}

export function record(code: string, values: Record<string, unknown>): string {
  const spec = RECORDS[code];
  if (!spec) throw new Error(`רשומה לא מוכרת ${code}`);
  return spec.map((field) => fmt(field, field.name === 'code' ? code : values[field.name])).join('');
}

export const recordWidth = (code: string) => RECORDS[code]!.reduce((a, x) => a + x.width, 0);

// ISO-8859-8: אותיות עבריות U+05D0..U+05EA → 0xE0..0xFA. תו שאין לו ייצוג → '?'
export function encodeIso88598(s: string): Buffer {
  const out = Buffer.alloc(s.length);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) out[i] = code;
    else if (code >= 0x05d0 && code <= 0x05ea) out[i] = code - 0x05d0 + 0xe0;
    else out[i] = 0x3f;
  }
  return out;
}

const ymd = (d: string | Date) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10)).replace(/-/g, '');
const hm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(':', '');

const PAY_CODE: Record<string, number> = { cash: 1, check: 2, card: 3, transfer: 4, credit_note: 6, bit: 9, customer_account: 9 };

export interface OpenFormatInput {
  tenant: { tax_id: string; legal_name: string; address?: string | null };
  from: string; to: string; primaryId: string; software: { name: string; version: string; registration: string; vendorVatId: string; vendorName: string };
  documents: any[]; items: any[];
}

export function buildOpenFormat(input: OpenFormatInput) {
  const vatId = input.tenant.tax_id;
  const lines: string[] = [];
  const counts: Record<string, number> = {};
  let rec = 0;
  const push = (code: string, v: Record<string, unknown>) => {
    rec++;
    counts[code] = (counts[code] ?? 0) + 1;
    lines.push(record(code, { recNo: rec, vatId, ...v }));
    return rec;
  };
  push('A100', { primaryId: input.primaryId, constant: SPEC_CONSTANT });
  for (const d of input.documents) {
    const info = DOC_TYPES[d.doc_type as DocType];
    const sign = info.isCredit ? -1 : 1;
    const t = d.totals;
    const link = push('C100', {
      docType: info.code, docNumber: String(d.serial), docDate: ymd(d.tax_date), docTime: hm(d.issued_at), customerName: d.customer?.name ?? '',
      customerStreet: d.customer?.address ?? '', customerPhone: d.customer?.phone ?? '', customerVatId: d.customer?.taxId ?? 0, valueDate: ymd(d.tax_date),
      amountBeforeDiscount: sign * (t.net + (t.discount ?? 0)), discount: sign * (t.discount ?? 0), amountAfterDiscountNoVat: sign * t.net, vat: sign * t.vat,
      total: sign * t.total, cancelled: '', docDateDup: ymd(d.tax_date), branchId: d.branch_code ?? '', user: '', linkField: 0,
    });
    (d.lines as any[]).forEach((l, i) => push('D110', {
      docType: info.code, docNumber: String(d.serial), lineNo: i + 1, transactionType: 1, itemCode: l.sku ?? '', description: l.name, unit: 'יחידה',
      qty: sign * l.qtyMilli, unitPrice: l.rateBp ? Math.round((l.unitPrice * 10000) / (10000 + l.rateBp)) : l.unitPrice, lineDiscount: sign * (l.discount ?? 0),
      lineTotal: sign * l.net, vatRate: l.rateBp, docDate: ymd(d.tax_date), linkC100: link,
    }));
    (d.payments as any[]).forEach((p, i) => push('D120', {
      docType: info.code, docNumber: String(d.serial), lineNo: i + 1, payMethod: PAY_CODE[p.method] ?? 9, checkNumber: p.checkNumber ?? 0,
      dueDate: p.checkDate ? ymd(p.checkDate) : ymd(d.tax_date), amount: sign * p.amount, docDate: ymd(d.tax_date), linkC100: link,
    }));
  }
  for (const it of input.items) {
    push('M100', { itemCode: it.sku, universalCode: it.barcode ?? '', name: it.name, unit: it.unit_measure, openingQty: it.opening_milli, totalIn: it.in_milli, totalOut: it.out_milli });
  }
  push('Z900', { primaryId: input.primaryId, constant: SPEC_CONSTANT, totalRecords: rec + 1 });

  const ini = [
    ['A000', `${''.padEnd(5)}${String(rec).padStart(15, '0')}${vatId.padStart(9, '0')}${input.primaryId.padStart(15, '0')}${SPEC_CONSTANT}`
      + `${input.software.registration.padEnd(8).slice(0, 8)}${input.software.name.padEnd(20).slice(0, 20)}${input.software.version.padEnd(20).slice(0, 20)}`
      + `${input.software.vendorVatId.padStart(9, '0')}${input.software.vendorName.padEnd(20).slice(0, 20)}2`
      + `${''.padEnd(50)}1${'0'}${''.padEnd(9, '0')}${''.padEnd(9, '0')}${''.padEnd(10)}${input.tenant.legal_name.padEnd(50).slice(0, 50)}`
      + `${(input.tenant.address ?? '').padEnd(50).slice(0, 50)}${''.padEnd(10)}${''.padEnd(30)}${''.padEnd(8)}${input.from.slice(0, 4)}`
      + `${ymd(input.from)}${ymd(input.to)}${ymd(new Date())}${hm(new Date().toISOString())}0${'1'}${''.padEnd(20)}${''.padEnd(3)}ILS0${''.padEnd(46)}`],
    ...Object.entries(counts).map(([code, n]) => [code, String(n).padStart(15, '0')]),
  ].map(([code, rest]) => `${code}${rest}`);

  return {
    bkmvdata: encodeIso88598(lines.join('\r\n') + '\r\n'),
    ini: encodeIso88598(ini.join('\r\n') + '\r\n'),
    counts, totalRecords: rec,
    path: `OPENFRMT/${vatId.slice(0, 8)}.${input.from.slice(2, 4)}/${ymd(new Date()).slice(4)}${hm(new Date().toISOString())}`,
    warning: 'טיוטה — רוחבי השדות לא אומתו מול מפרט 1.31 ולא נבדקו בסימולטור. אסור להגיש לרשות המסים לפני אימות.',
  };
}
