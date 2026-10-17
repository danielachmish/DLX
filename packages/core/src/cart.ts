// חישוב עגלה (POS-02): שורות, הנחות, מע"מ וסיכומים — אותו חישוב בקופה, בשרת ובמסמך.
// סכום הרכיבים תמיד שווה לסך העסקה (בלי סטיית עיגול): הנחת עגלה מפוזרת בשיטת השארית הגדולה,
// והמע"מ מחושב לכל שורה ואז מסוכם (כך גם הפירוט לפי שיעור תואם לשורות).
import { type Agorot, type QtyMilli, MoneyError, allocate, lineAmount, percentOf } from './money.js';
import { type TaxCategory, type TaxContext, splitGross, vatRateBp } from './vat.js';

export type LineKind = 'item' | 'deposit';

export interface CartLineInput {
  key: string;
  productId?: string | null;
  sku?: string | null;
  name: string;
  unitPrice: Agorot; // כולל מע"מ (D09)
  qtyMilli: QtyMilli;
  taxCategory: TaxCategory;
  discountAgorot?: Agorot; // הנחת שורה בסכום
  discountBp?: number; // או באחוזים (נקודות בסיס)
  kind?: LineKind;
  depositPerUnit?: Agorot; // חוק הפיקדון — נוצרת שורת פיקדון נפרדת (withDeposits)
}

export interface CartLine extends CartLineInput {
  kind: LineKind;
  gross: Agorot; // לפני הנחות
  lineDiscount: Agorot;
  cartDiscount: Agorot;
  total: Agorot; // אחרי כל ההנחות, כולל מע"מ
  rateBp: number;
  net: Agorot;
  vat: Agorot;
}

export interface RateBucket { rateBp: number; net: Agorot; vat: Agorot; total: Agorot }

export interface CartTotals {
  gross: Agorot;
  discount: Agorot;
  total: Agorot;
  net: Agorot;
  vat: Agorot;
  byRate: RateBucket[];
  itemCount: QtyMilli;
}

export interface CartInput {
  lines: CartLineInput[];
  cartDiscountAgorot?: Agorot;
  cartDiscountBp?: number;
}

export class CartError extends MoneyError {}

// שורת פיקדון לכל שורה עם depositPerUnit — לא מקבלת הנחת עגלה, ומחויבת במע"מ רגיל (לאמת, docs/decisions.md)
export function withDeposits(lines: CartLineInput[], depositCategory: TaxCategory = 'standard'): CartLineInput[] {
  const out: CartLineInput[] = [];
  for (const l of lines) {
    out.push(l);
    if (l.kind !== 'deposit' && l.depositPerUnit && l.depositPerUnit > 0) {
      out.push({
        key: `${l.key}:deposit`, productId: null, sku: null, name: `פיקדון — ${l.name}`, unitPrice: l.depositPerUnit,
        qtyMilli: l.qtyMilli, taxCategory: depositCategory, kind: 'deposit',
      });
    }
  }
  return out;
}

export function computeCart(input: CartInput, ctx: TaxContext): { lines: CartLine[]; totals: CartTotals } {
  const pre = input.lines.map((l) => {
    if (l.qtyMilli <= 0) throw new CartError(`כמות לא תקינה בשורה "${l.name}"`);
    if (l.unitPrice < 0) throw new CartError(`מחיר שלילי בשורה "${l.name}"`);
    const gross = lineAmount(l.unitPrice, l.qtyMilli);
    const lineDiscount = (l.discountAgorot ?? 0) + (l.discountBp ? percentOf(gross, l.discountBp) : 0);
    if (lineDiscount < 0 || lineDiscount > gross) throw new CartError(`הנחה לא תקינה בשורה "${l.name}"`);
    return { l, kind: l.kind ?? 'item', gross, lineDiscount, after: gross - lineDiscount };
  });

  const discountable = pre.map((p) => (p.kind === 'item' ? p.after : 0));
  const base = discountable.reduce((a, b) => a + b, 0);
  const cartDiscount = (input.cartDiscountAgorot ?? 0) + (input.cartDiscountBp ? percentOf(base, input.cartDiscountBp) : 0);
  if (cartDiscount < 0 || cartDiscount > base) throw new CartError('הנחת העגלה גדולה מסכום הפריטים');
  const shares = allocate(cartDiscount, discountable);

  const lines: CartLine[] = pre.map((p, i) => {
    const share = shares[i] ?? 0;
    const total = p.after - share;
    const rateBp = vatRateBp(p.l.taxCategory, ctx);
    const { net, vat } = splitGross(total, rateBp);
    return { ...p.l, kind: p.kind, gross: p.gross, lineDiscount: p.lineDiscount, cartDiscount: share, total, rateBp, net, vat };
  });

  const buckets = new Map<number, RateBucket>();
  for (const l of lines) {
    const b = buckets.get(l.rateBp) ?? { rateBp: l.rateBp, net: 0, vat: 0, total: 0 };
    b.net += l.net; b.vat += l.vat; b.total += l.total;
    buckets.set(l.rateBp, b);
  }
  const sum = (f: (l: CartLine) => number) => lines.reduce((a, l) => a + f(l), 0);
  const totals: CartTotals = {
    gross: sum((l) => l.gross),
    discount: sum((l) => l.lineDiscount + l.cartDiscount),
    total: sum((l) => l.total),
    net: sum((l) => l.net),
    vat: sum((l) => l.vat),
    byRate: [...buckets.values()].sort((a, b) => b.rateBp - a.rateBp),
    itemCount: lines.filter((l) => l.kind === 'item').reduce((a, l) => a + l.qtyMilli, 0),
  };
  return { lines, totals };
}
