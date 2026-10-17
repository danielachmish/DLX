// מצבי מסמך ועסקה (פרק 7 באפיון): כל מעבר מותר מוגדר כאן, והשרת בודק כל שינוי מצב מולו.
// מצב סופי (finalized / issued / posted / closed) לא חוזר אחורה — תיקון רק דרך מסמך / פעולה מקושרים.

export const MACHINES = {
  cart: { draft: ['awaiting_payment', 'cancelled'], awaiting_payment: ['draft', 'completed', 'cancelled'], completed: [], cancelled: [] },
  payment: {
    initiated: ['pending', 'captured', 'failed'], pending: ['captured', 'failed', 'voided'], captured: ['refunded_partial', 'refunded_full'],
    refunded_partial: ['refunded_partial', 'refunded_full'], failed: [], voided: [], refunded_full: [],
  },
  sale: { draft: ['payment_pending', 'cancelled'], payment_pending: ['finalized', 'exception', 'draft'], exception: ['finalized', 'cancelled'], finalized: [], cancelled: [] },
  document: { draft: ['issuing'], issuing: ['issued', 'issue_failed'], issue_failed: ['issuing'], issued: [] },
  purchase_order: { draft: ['approved', 'cancelled'], approved: ['ordered', 'cancelled'], ordered: ['partial', 'received', 'cancelled'], partial: ['partial', 'received', 'closed'], received: ['closed'], closed: [], cancelled: [] },
  goods_receipt: { draft: ['counting', 'posted'], counting: ['verified', 'draft'], verified: ['posted', 'counting'], posted: [] },
  inventory_count: { open: ['counted'], counted: ['reviewed', 'open'], reviewed: ['posted', 'counted'], posted: [] },
  cash_session: { opening: ['active'], active: ['closing'], closing: ['closed', 'active'], closed: [] },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type MachineName = keyof typeof MACHINES;
export type StateOf<M extends MachineName> = keyof (typeof MACHINES)[M] & string;

export class TransitionError extends Error {
  constructor(public machine: string, public from: string, public to: string) {
    super(`מעבר לא מותר: ${machine} ${from} → ${to}`);
  }
}

export function canTransition<M extends MachineName>(m: M, from: StateOf<M>, to: StateOf<M>): boolean {
  const next = (MACHINES[m] as Record<string, readonly string[]>)[from];
  return !!next && next.includes(to);
}

export function assertTransition<M extends MachineName>(m: M, from: StateOf<M>, to: StateOf<M>): void {
  if (!canTransition(m, from, to)) throw new TransitionError(m, from, to);
}

export function isFinal<M extends MachineName>(m: M, s: StateOf<M>): boolean {
  return ((MACHINES[m] as Record<string, readonly string[]>)[s] ?? []).length === 0;
}
