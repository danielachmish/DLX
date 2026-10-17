// מתאמים לספקים חיצוניים (D04, INT-01, INT-02). הקוד העסקי לא תלוי בספק מסוים.
// mock — לפיתוח ובדיקות בלבד; ספק אמיתי ממומש באותו ממשק אחרי שייבחר.
import { randomInt, randomUUID } from 'node:crypto';

// ===== סליקה =====
export type ChargeStatus = 'captured' | 'failed' | 'pending';

export interface ChargeRequest { idempotencyKey: string; amount: number; installments?: number; reference: string }
export interface ChargeResult { status: ChargeStatus; providerRef: string; approvalCode?: string; last4?: string; brand?: string; failureReason?: string }

export interface PaymentProvider {
  name: string;
  charge(req: ChargeRequest): Promise<ChargeResult>;
  status(idempotencyKey: string): Promise<ChargeResult | null>;
  refund(providerRef: string, amount: number, idempotencyKey: string): Promise<{ ok: boolean; providerRef: string; failureReason?: string }>;
}

// ספק דמה דטרמיניסטי: סכום שמסתיים ב-13 אגורות נדחה; 99 אגורות — "אין תשובה" (pending), ואחרי שאילתת סטטוס מאושר.
// מפתח idempotency זהה מחזיר את אותה עסקה — כמו ספק אמיתי (PAY-02, T12).
export class MockPaymentProvider implements PaymentProvider {
  name = 'mock';
  private byKey = new Map<string, ChargeResult>();
  private refunds = new Map<string, { ok: boolean; providerRef: string }>();

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const prev = this.byKey.get(req.idempotencyKey);
    if (prev) return prev;
    const cents = req.amount % 100;
    const base = { providerRef: `MOCK-${randomUUID().slice(0, 8)}`, last4: String(randomInt(1000, 9999)), brand: 'visa' };
    const r: ChargeResult = cents === 13
      ? { ...base, status: 'failed', failureReason: 'העסקה סורבה על ידי חברת האשראי' }
      : cents === 99 ? { ...base, status: 'pending' } : { ...base, status: 'captured', approvalCode: String(randomInt(100000, 999999)) };
    this.byKey.set(req.idempotencyKey, r);
    return r;
  }

  async status(key: string): Promise<ChargeResult | null> {
    const r = this.byKey.get(key);
    if (r && r.status === 'pending') {
      const done: ChargeResult = { ...r, status: 'captured', approvalCode: String(randomInt(100000, 999999)) };
      this.byKey.set(key, done);
      return done;
    }
    return r ?? null;
  }

  async refund(providerRef: string, _amount: number, key: string) {
    const prev = this.refunds.get(key);
    if (prev) return prev;
    const r = { ok: true, providerRef: `MOCK-R-${providerRef.slice(5)}` };
    this.refunds.set(key, r);
    return r;
  }
}

// ===== חשבוניות ישראל — מספר הקצאה (API-02, API-03) =====
export interface AllocationDraft {
  issuerVatId: string; customerVatId: string; docCode: number; serial: number; date: string; netBeforeVat: number; vat: number; total: number;
}
export type AllocationResult = { status: 'approved'; allocationNumber: string; requestId: string } | { status: 'rejected' | 'failed'; reason: string; requestId: string; retryable: boolean };

export interface AllocationProvider { name: string; request(d: AllocationDraft): Promise<AllocationResult> }

// דמה: מאשר כל בקשה עם מספר בן 9 ספרות. מספר עוסק של לקוח שמתחיל ב-000 — נדחה (לבדיקות).
// חיבור אמיתי לשע"מ דורש רישום בית תוכנה ואישור אבטחת מידע (נספח שע"מ) — ר' docs/compliance.md.
export class MockAllocationProvider implements AllocationProvider {
  name = 'mock';
  async request(d: AllocationDraft): Promise<AllocationResult> {
    const requestId = randomUUID();
    if (d.customerVatId.startsWith('000')) return { status: 'rejected', reason: 'מספר העוסק של הלקוח לא נמצא במרשם', requestId, retryable: false };
    return { status: 'approved', allocationNumber: String(randomInt(100_000_000, 999_999_999)), requestId };
  }
}

export interface Providers { payments: PaymentProvider; allocation: AllocationProvider }

export const createProviders = (): Providers => ({ payments: new MockPaymentProvider(), allocation: new MockAllocationProvider() });
