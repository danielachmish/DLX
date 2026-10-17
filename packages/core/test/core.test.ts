import { describe, expect, it } from 'vitest';
import {
  allocate, allocationRequired, assertDocAllowed, assertTransition, canTransition, cashLimitError, cashRound, computeCart,
  discountAllowed, formatAgorot, gtinCheckDigit, internalBarcode, isValidGtin, isValidIsraeliId, lineAmount, maxCashAllowed,
  parseQty, parseScaleBarcode, parseShekels, posSaleDocType, printMark, refundForLine, saleBlockReason, splitGross,
  tenderState, valueOn, VAT_RATE_BP, vatRateBp, withDeposits, type TaxContext,
} from '../src/index.js';

const ctx: TaxContext = { date: '2026-10-17', status: 'murshe', zone: 'regular' };

describe('money', () => {
  it('multiplies price by milli-quantity with symmetric half-up rounding', () => {
    expect(lineAmount(1990, 3000)).toBe(5970);
    expect(lineAmount(3490, 250)).toBe(873); // 872.5 → 873
    expect(lineAmount(1, 500)).toBe(1);
  });
  it('allocates without losing an agora', () => {
    const parts = allocate(1000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(parts).toEqual([334, 333, 333]);
    expect(allocate(-100, [3, 1])).toEqual([-75, -25]);
  });
  it('parses shekels and quantities', () => {
    expect(parseShekels('12.5')).toBe(1250);
    expect(parseShekels('₪1,234.50')).toBe(123450);
    expect(parseShekels('12,5')).toBe(1250);
    expect(parseShekels('abc')).toBeNull();
    expect(parseQty('0.250')).toBe(250);
    expect(parseQty('3')).toBe(3000);
  });
  it('formats with agorot', () => {
    expect(formatAgorot(152279)).toBe('₪1,522.79');
    expect(formatAgorot(-500)).toBe('−₪5.00');
  });
});

describe('vat', () => {
  it('uses the rate in force on the document date (T09)', () => {
    expect(valueOn(VAT_RATE_BP, '2024-12-31')).toBe(1700);
    expect(valueOn(VAT_RATE_BP, '2025-01-01')).toBe(1800);
  });
  it('extracts VAT so that net + vat = gross', () => {
    const { net, vat } = splitGross(11800, 1800);
    expect(vat).toBe(1800);
    expect(net + vat).toBe(11800);
    const odd = splitGross(999, 1800);
    expect(odd.net + odd.vat).toBe(999);
  });
  it('zero-rates produce, Eilat and exempt dealers (DOC-04)', () => {
    expect(vatRateBp('zero', ctx)).toBe(0);
    expect(vatRateBp('standard', { ...ctx, zone: 'eilat' })).toBe(0);
    expect(vatRateBp('standard', { ...ctx, status: 'patur' })).toBe(0);
    expect(vatRateBp('standard', ctx)).toBe(1800);
  });
});

describe('cart', () => {
  it('sums lines, discounts and VAT consistently (POS-02)', () => {
    const { lines, totals } = computeCart({
      lines: [
        { key: 'a', name: 'חלב', unitPrice: 690, qtyMilli: 2000, taxCategory: 'standard' },
        { key: 'b', name: 'עגבניות', unitPrice: 990, qtyMilli: 1250, taxCategory: 'zero' },
        { key: 'c', name: 'חולצה', unitPrice: 8990, qtyMilli: 1000, taxCategory: 'standard', discountBp: 1000 },
      ],
      cartDiscountAgorot: 500,
    }, ctx);
    expect(totals.total).toBe(lines.reduce((a, l) => a + l.total, 0));
    expect(totals.net + totals.vat).toBe(totals.total);
    expect(totals.gross - totals.discount).toBe(totals.total);
    expect(lines[2]!.lineDiscount).toBe(899);
    expect(totals.byRate.map((b) => b.rateBp)).toEqual([1800, 0]);
    expect(totals.byRate.reduce((a, b) => a + b.total, 0)).toBe(totals.total);
  });
  it('rejects a cart discount larger than the items', () => {
    expect(() => computeCart({ lines: [{ key: 'a', name: 'x', unitPrice: 100, qtyMilli: 1000, taxCategory: 'standard' }], cartDiscountAgorot: 101 }, ctx)).toThrow();
  });
  it('adds deposit lines that do not get cart discount (G-13)', () => {
    const lines = withDeposits([{ key: 'a', name: 'קולה', unitPrice: 790, qtyMilli: 6000, taxCategory: 'standard', depositPerUnit: 30 }]);
    expect(lines).toHaveLength(2);
    const { lines: out } = computeCart({ lines, cartDiscountBp: 1000 }, ctx);
    expect(out[1]!.kind).toBe('deposit');
    expect(out[1]!.total).toBe(180);
    expect(out[1]!.cartDiscount).toBe(0);
  });
});

describe('payments', () => {
  it('rounds cash to 10 agorot', () => {
    expect(cashRound(1234)).toBe(1230);
    expect(cashRound(1235)).toBe(1240);
    expect(cashRound(1240)).toBe(1240);
  });
  it('gives change from cash only and records rounding', () => {
    const s = tenderState(9997, [{ method: 'cash', amount: 10000 }]);
    expect(s.settled).toBe(true);
    expect(s.rounding).toBe(3);
    expect(s.change).toBe(0);
    const s2 = tenderState(9997, [{ method: 'cash', amount: 20000 }]);
    expect(s2.change).toBe(10000);
  });
  it('handles split payment (T11) and blocks card over balance', () => {
    const s = tenderState(15000, [{ method: 'card', amount: 10000 }, { method: 'cash', amount: 5000 }]);
    expect(s.settled).toBe(true);
    expect(s.change).toBe(0);
    const p = tenderState(15000, [{ method: 'card', amount: 10000 }]);
    expect(p.settled).toBe(false);
    expect(p.remaining).toBe(5000);
    expect(() => tenderState(15000, [{ method: 'card', amount: 15001 }])).toThrow();
  });
  it('card exact payment needs no rounding', () => {
    const s = tenderState(9997, [{ method: 'card', amount: 9997 }]);
    expect(s.settled).toBe(true);
    expect(s.rounding).toBe(0);
  });
  it('applies the cash-law cap (T38)', () => {
    expect(maxCashAllowed(5_999_00, '2026-10-17')).toBeNull();
    expect(maxCashAllowed(8_000_00, '2026-10-17')).toBe(800_00);
    expect(cashLimitError(8_000_00, 900_00, '2026-10-17')).toMatch(/מזומן/);
    expect(cashLimitError(8_000_00, 800_00, '2026-10-17')).toBeNull();
  });
});

describe('documents', () => {
  it('blocks tax invoices for an exempt dealer (QA-07)', () => {
    expect(() => assertDocAllowed('tax_invoice_receipt', 'patur')).toThrow();
    expect(() => assertDocAllowed('receipt', 'patur')).not.toThrow();
    expect(posSaleDocType('patur')).toBe('receipt');
    expect(posSaleDocType('company')).toBe('tax_invoice_receipt');
  });
  it('requires an allocation number only above the dated threshold for B2B (QA-09)', () => {
    const base = { type: 'tax_invoice' as const, issuerStatus: 'murshe' as const, customerVatId: '515555555' };
    expect(allocationRequired({ ...base, date: '2026-10-17', netBeforeVat: 5_000_00 })).toBe(true);
    expect(allocationRequired({ ...base, date: '2026-10-17', netBeforeVat: 4_999_99 })).toBe(false);
    expect(allocationRequired({ ...base, date: '2026-05-31', netBeforeVat: 5_000_00 })).toBe(false);
    expect(allocationRequired({ ...base, customerVatId: null, date: '2026-10-17', netBeforeVat: 50_000_00 })).toBe(false);
    expect(allocationRequired({ ...base, type: 'credit_invoice', date: '2026-10-17', netBeforeVat: 50_000_00 })).toBe(false);
  });
  it('marks original then copy', () => {
    expect(printMark(0)).toBe('מקור');
    expect(printMark(1)).toBe('העתק נאמן למקור');
  });
});

describe('states', () => {
  it('never leaves a final state', () => {
    expect(canTransition('document', 'issued', 'draft')).toBe(false);
    expect(() => assertTransition('sale', 'finalized', 'cancelled')).toThrow();
    expect(canTransition('cash_session', 'active', 'closing')).toBe(true);
  });
});

describe('compliance', () => {
  it('blocks alcohol 23:00–06:00 Israel time (G-11)', () => {
    expect(saleBlockReason('alcohol', new Date('2026-10-17T20:30:00Z'))).toMatch(/23:00/); // 23:30 בישראל
    expect(saleBlockReason('alcohol', new Date('2026-10-17T09:00:00Z'))).toBeNull();
    expect(saleBlockReason('tobacco', new Date('2026-10-17T21:00:00Z'))).toBeNull();
  });
  it('validates Israeli IDs', () => {
    expect(isValidIsraeliId('000000018')).toBe(true);
    expect(isValidIsraeliId('123456782')).toBe(true);
    expect(isValidIsraeliId('123456789')).toBe(false);
  });
});

describe('barcodes', () => {
  it('validates GTIN and builds internal codes', () => {
    expect(isValidGtin('7290000066318')).toBe(gtinCheckDigit('729000006631') === 8);
    const c = internalBarcode(42);
    expect(c).toHaveLength(13);
    expect(isValidGtin(c)).toBe(true);
  });
  it('reads scale weight barcodes (G-17)', () => {
    const code = '2' + '0' + '12345' + '01250';
    const full = code + gtinCheckDigit(code);
    expect(parseScaleBarcode(full)).toEqual({ itemCode: '12345', qtyMilli: 1250 });
  });
});

describe('returns', () => {
  it('never refunds more than was paid (T15, T16)', () => {
    const line = { lineId: 'l', qtyMilli: 5000, total: 1000, returnedQtyMilli: 0, returnedTotal: 0 };
    expect(refundForLine(line, 2000)).toBe(400);
    const after = { ...line, returnedQtyMilli: 2000, returnedTotal: 400 };
    expect(refundForLine(after, 3000)).toBe(600);
    expect(() => refundForLine(after, 4000)).toThrow();
  });
});

describe('permissions', () => {
  it('limits cashier discounts (T19)', () => {
    expect(discountAllowed('cashier', 1000)).toBe(true);
    expect(discountAllowed('cashier', 4000)).toBe(false);
    expect(discountAllowed('manager', 4000)).toBe(true);
    expect(discountAllowed('warehouse', 100)).toBe(false);
  });
});
