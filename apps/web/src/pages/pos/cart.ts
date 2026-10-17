// עגלת הקופה במכשיר: שורות, חישוב מקומי מיידי (אותה פונקציה של השרת), ושמירה ב-localStorage לכל קופה
// כך שרענון / ניתוק לא מאבדים את העגלה (D08). המחיר הסופי תמיד נקבע בשרת בזמן התשלום.
import { type CartLineInput, computeCart, israelDate, type TaxCategory, withDeposits } from '@dlx/core';
import type { Session } from '../../lib/session';

export interface PosLine {
  key: string;
  productId: string;
  sku: string | null;
  name: string;
  unitPrice: number;
  qtyMilli: number;
  taxCategory: TaxCategory;
  depositPerUnit: number;
  restriction: string;
  soldByWeight: boolean;
  unitMeasure: string;
  barcode?: string | null; // ברקוד מחיר ממאזניים — נשלח לשרת כדי שיאמת את המחיר
  fixedPrice?: boolean;
  discountBp?: number;
}

export interface CartState {
  lines: PosLine[];
  cartDiscountBp: number;
  customer: { id: string; name: string; phone?: string | null; kind?: string } | null;
  pendingSaleId?: string | null;
}

export const emptyCart = (): CartState => ({ lines: [], cartDiscountBp: 0, customer: null, pendingSaleId: null });

const key = (registerId: string) => `dlx_cart_${registerId}`;

export function loadCart(registerId: string): CartState {
  try {
    const s = localStorage.getItem(key(registerId));
    return s ? { ...emptyCart(), ...(JSON.parse(s) as CartState) } : emptyCart();
  } catch { return emptyCart(); }
}

export function saveCart(registerId: string, c: CartState) {
  try { localStorage.setItem(key(registerId), JSON.stringify(c)); } catch { /* מצב פרטי */ }
}

// מוצר מה-API (lookup / pos/products / products) → שורה
export function lineFromProduct(p: any, opts: { unitPrice?: number; qtyMilli?: number; barcode?: string | null; fixedPrice?: boolean } = {}): PosLine {
  return {
    key: `${p.id}:${Date.now()}:${Math.random().toString(16).slice(2, 6)}`,
    productId: p.id, sku: p.sku ?? null, name: p.name,
    unitPrice: opts.unitPrice ?? p.unit_price ?? p.price_agorot,
    qtyMilli: opts.qtyMilli ?? 1000,
    taxCategory: p.tax_category ?? 'standard', depositPerUnit: p.deposit_agorot ?? 0, restriction: p.restriction ?? 'none',
    soldByWeight: !!p.sold_by_weight, unitMeasure: p.unit_measure ?? 'unit',
    barcode: opts.fixedPrice ? opts.barcode ?? null : null, fixedPrice: !!opts.fixedPrice,
  };
}

// אותו מוצר בלי מחיר מאזניים — מאחדים כמות; מוצר שקיל / מחיר קבוע — שורה חדשה
export function addLine(c: CartState, l: PosLine): { cart: CartState; key: string } {
  if (!l.soldByWeight && !l.fixedPrice) {
    const same = c.lines.find((x) => x.productId === l.productId && !x.fixedPrice && !x.discountBp && x.unitPrice === l.unitPrice);
    if (same) {
      return { cart: { ...c, lines: c.lines.map((x) => (x === same ? { ...x, qtyMilli: x.qtyMilli + l.qtyMilli } : x)) }, key: same.key };
    }
  }
  return { cart: { ...c, lines: [...c.lines, l] }, key: l.key };
}

export function computeLocal(c: CartState, s: Session, branchId: string | null) {
  const zone = (s.branches.find((b) => b.id === branchId)?.tax_zone ?? 'regular') as 'regular' | 'eilat';
  const lines: CartLineInput[] = c.lines.map((l) => ({
    key: l.key, productId: l.productId, sku: l.sku, name: l.name, unitPrice: l.unitPrice, qtyMilli: l.qtyMilli,
    taxCategory: l.taxCategory, discountBp: l.discountBp || undefined, depositPerUnit: l.depositPerUnit,
  }));
  try {
    return computeCart({ lines: withDeposits(lines), cartDiscountBp: c.cartDiscountBp || undefined }, { date: israelDate(new Date()), status: s.tenant.tax_status, zone });
  } catch {
    return computeCart({ lines: withDeposits(lines) }, { date: israelDate(new Date()), status: s.tenant.tax_status, zone });
  }
}

export const restricted = (c: CartState) => c.lines.some((l) => l.restriction && l.restriction !== 'none');

// מוצרים אחרונים — אריחים מהירים, לכל קופה
const RECENT = (r: string) => `dlx_recent_${r}`;
export function loadRecent(registerId: string): any[] {
  try { return JSON.parse(localStorage.getItem(RECENT(registerId)) ?? '[]'); } catch { return []; }
}
export function pushRecent(registerId: string, p: any) {
  const slim = {
    id: p.id, sku: p.sku, name: p.name, price_agorot: p.unit_price ?? p.price_agorot, tax_category: p.tax_category, deposit_agorot: p.deposit_agorot,
    restriction: p.restriction, sold_by_weight: p.sold_by_weight, unit_measure: p.unit_measure,
  };
  const list = [slim, ...loadRecent(registerId).filter((x) => x.id !== p.id)].slice(0, 12);
  try { localStorage.setItem(RECENT(registerId), JSON.stringify(list)); } catch { /* */ }
}
