// תפקידים והרשאות (IAM-01, IAM-04). הבדיקה תמיד בשרת. הממשק משתמש באותה טבלה רק כדי להסתיר כפתורים.

export const PERMISSIONS = [
  'catalog:read', 'catalog:write', 'costs:read',
  'purchase:write', 'inventory:receive', 'inventory:approve',
  'stock:read', 'stock:count', 'stock:approve',
  'pos:sell', 'pos:discount', 'pos:discount_override', 'pos:price_override', 'pos:refund', 'pos:refund_no_receipt',
  'cash:manage', 'cash:approve_variance',
  'customers:read', 'customers:write', 'customers:credit',
  'document:read', 'document:issue', 'document:send',
  'reports:sales', 'reports:profit', 'tax:export',
  'settings:write', 'users:write', 'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type Role = 'owner' | 'manager' | 'cashier' | 'warehouse' | 'purchaser' | 'accountant';

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'בעל העסק', manager: 'מנהל סניף', cashier: 'קופאי', warehouse: 'מחסנאי', purchaser: 'קניין', accountant: 'מנהל חשבונות / רו"ח',
};

const ALL_PERMS = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL_PERMS,
  manager: ALL_PERMS.filter((p) => !['users:write', 'settings:write', 'tax:export'].includes(p)),
  cashier: ['catalog:read', 'stock:read', 'pos:sell', 'pos:discount', 'pos:refund', 'customers:read', 'customers:write', 'document:read', 'document:send'],
  warehouse: ['catalog:read', 'stock:read', 'stock:count', 'inventory:receive'],
  purchaser: ['catalog:read', 'catalog:write', 'costs:read', 'purchase:write', 'inventory:receive', 'stock:read'],
  accountant: ['catalog:read', 'costs:read', 'stock:read', 'customers:read', 'document:read', 'reports:sales', 'reports:profit', 'tax:export', 'audit:read'],
};

export const can = (role: Role, p: Permission) => ROLE_PERMISSIONS[role].includes(p);

// PRI-03: הנחה שקופאי רשאי לתת בלי אישור מנהל (נקודות בסיס). מעל זה — pos:discount_override
export const DISCOUNT_LIMIT_BP: Partial<Record<Role, number>> = { cashier: 1000 };

export function discountAllowed(role: Role, bp: number): boolean {
  if (can(role, 'pos:discount_override')) return true;
  if (!can(role, 'pos:discount')) return bp === 0;
  return bp <= (DISCOUNT_LIMIT_BP[role] ?? 0);
}
