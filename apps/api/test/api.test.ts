// בדיקות קבלה מול Postgres אמיתי (פרק 12 באפיון, פרק 14 במדריך המשפטי). כל בדיקה מסומנת בקוד התרחיש.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECORDS, recordWidth } from '../src/services/openFormat.js';
import { APP_URL, type App, client, login, makeApp, pinLogin, resetDb, seedDemo } from './helpers.js';

let app: App;
let owner: ReturnType<typeof client>;
let cashier: ReturnType<typeof client>;
let ownerSession: any;
let demo: Awaited<ReturnType<typeof seedDemo>>;
let registerId: string;
let register2Id: string;
let sessionId: string;
const prod = (sku: string) => demo.products.find((p: any) => p.sku === sku);

beforeAll(async () => {
  await resetDb();
  app = await makeApp();
  demo = await seedDemo(app);
  ownerSession = await login(app, 'demo', 'owner@demo.co.il', 'demo1234');
  owner = client(app, ownerSession.token);
  const cs = await pinLogin(app, 'demo', '1234');
  cashier = client(app, cs.token);
  registerId = ownerSession.registers.find((r: any) => r.code === '01').id;
  register2Id = ownerSession.registers.find((r: any) => r.code === '02').id;
}, 60_000);

afterAll(async () => { await app?.close(); });

async function sell(c: ReturnType<typeof client>, lines: any[], tenders: any[], extra: any = {}, reg = registerId) {
  const s = await c.post('/v1/sales', { registerId: reg, lines, ...extra }, true);
  if (s.status !== 200) return { create: s };
  const f = await c.post(`/v1/sales/${s.body.id}/finalize`, { tenders }, true);
  return { create: s, finalize: f };
}

describe('auth & isolation', () => {
  it('logs in with password and PIN, wrong PIN is rejected', async () => {
    expect(ownerSession.user.role).toBe('owner');
    const bad = await app.inject({ method: 'POST', url: '/v1/auth/pin', payload: { slug: 'demo', pin: '0000' } });
    expect(bad.statusCode).toBe(401);
  });

  it('T21 / QA-19: another business cannot read data, even by id', async () => {
    const other = await app.inject({
      method: 'POST', url: '/v1/auth/signup',
      payload: { business: { slug: 'other-shop', legalName: 'חנות אחרת', taxId: '300000007', taxStatus: 'patur' }, branch: { name: 'ראשי' }, owner: { name: 'בעלים', email: 'o@other.co.il', password: 'password1' } },
    });
    expect(other.statusCode).toBe(200);
    const o = client(app, other.json().token);
    const list = await o.get('/v1/products');
    expect(list.body).toHaveLength(0);
    const byId = await o.get(`/v1/products/${prod('1001').id}`);
    expect(byId.status).toBe(404);
  });

  it('RLS holds at the DB level for the app role even without a tenant filter', async () => {
    const c = new pg.Client({ connectionString: APP_URL });
    await c.connect();
    const r = await c.query('SELECT COUNT(*)::int AS n FROM products');
    expect(r.rows[0].n).toBe(0); // בלי app.tenant_id — אפס שורות
    await c.end();
  });

  it('T20: cashier sees no cost and cannot export; the denial is audited', async () => {
    const p = await cashier.get(`/v1/products/${prod('1001').id}`);
    expect(p.body.cost_agorot).toBeUndefined();
    const ex = await cashier.get('/v1/exports/accountant.csv?from=2026-01-01&to=2026-12-31');
    expect(ex.status).toBe(403);
    const audit = await owner.get('/v1/audit?action=permission.denied');
    expect(audit.body.length).toBeGreaterThan(0);
  });
});

describe('POS sale', () => {
  it('requires an open shift', async () => {
    const r = await cashier.post('/v1/sales', { registerId, lines: [{ productId: prod('1001').id, qtyMilli: 1000 }] }, true);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('no_session');
  });

  it('opens shifts', async () => {
    const r = await cashier.post('/v1/cash-sessions/open', { registerId, openingFloatAgorot: 50000 });
    expect(r.status).toBe(200);
    sessionId = r.body.session.id;
    const dup = await cashier.post('/v1/cash-sessions/open', { registerId, openingFloatAgorot: 0 });
    expect(dup.status).toBe(409);
    expect((await owner.post('/v1/cash-sessions/open', { registerId: register2Id, openingFloatAgorot: 0 })).status).toBe(200);
  });

  it('T01: sells with server prices, VAT split, cash change and rounding; issues 320 #1', async () => {
    const before = (await owner.get(`/v1/products/${prod('1001').id}`)).body.stock[0].on_hand;
    const { create, finalize } = await sell(cashier,
      [{ productId: prod('1001').id, qtyMilli: 2000, unitPriceAgorot: 1 /* ניסיון לשנות מחיר — נחסם */ }], []);
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('approval_required');

    const ok = await sell(cashier, [{ productId: prod('1001').id, qtyMilli: 2000 }, { productId: prod('3001').id, qtyMilli: 1253 }], [{ method: 'cash', amountAgorot: 5000 }]);
    expect(ok.finalize!.status).toBe(200);
    const sale = ok.finalize!.body.sale;
    // חלב 2×6.90 = 13.80 (18%) · עגבניות 1.253×9.90 = 12.40 (0%) → 26.20
    expect(sale.total_agorot).toBe(1380 + 1240);
    expect(sale.vat_agorot).toBe(Math.round((1380 * 1800) / 11800));
    expect(ok.finalize!.body.change_agorot).toBe(5000 - 2620);
    expect(ok.finalize!.body.document.doc_type).toBe('tax_invoice_receipt');
    expect(Number(ok.finalize!.body.document.serial)).toBe(1);
    const after = (await owner.get(`/v1/products/${prod('1001').id}`)).body.stock[0].on_hand;
    expect(before - after).toBe(2000);
  });

  it('QA-01 / T25: two registers finalizing at once never share a document number', async () => {
    const [a, b] = await Promise.all([
      sell(cashier, [{ productId: prod('5001').id, qtyMilli: 1000 }], [{ method: 'cash', amountAgorot: 1190 }]),
      sell(owner, [{ productId: prod('5002').id, qtyMilli: 1000 }], [{ method: 'cash', amountAgorot: 590 }], {}, register2Id),
    ]);
    expect(a.finalize!.status).toBe(200);
    expect(b.finalize!.status).toBe(200);
    expect(a.finalize!.body.document.serial).not.toBe(b.finalize!.body.document.serial);
  });

  it('T12 / QA-02: card timeout then retry with same key — one charge only', async () => {
    // סכום שמסתיים ב-99 אגורות: ספק הדמה לא עונה בפעם הראשונה (pending)
    const s = await owner.post('/v1/sales', { registerId: register2Id, lines: [{ productId: prod('5003').id, qtyMilli: 1000, unitPriceAgorot: 4099 }] }, true);
    expect(s.status).toBe(200);
    const key = 'card-key-0001-abc';
    const p1 = await owner.post(`/v1/sales/${s.body.id}/payments`, { method: 'card', amountAgorot: 4099 }, key);
    expect(p1.body.payment.status).toBe('pending');
    const blocked = await owner.post(`/v1/sales/${s.body.id}/finalize`, { tenders: [] }, true);
    expect(blocked.body.code).toBe('payment_in_progress');
    const p2 = await owner.post(`/v1/sales/${s.body.id}/payments`, { method: 'card', amountAgorot: 4099 }, key);
    expect(p2.body.payment.id).toBe(p1.body.payment.id);
    expect(p2.body.payment.status).toBe('captured');
    const f = await owner.post(`/v1/sales/${s.body.id}/finalize`, { tenders: [] }, true);
    expect(f.status).toBe(200);
    expect(f.body.sale.payments.filter((p: any) => p.method === 'card')).toHaveLength(1);
  });

  it('T13: a declined card leaves the sale unpaid; finalize refuses', async () => {
    // סכום שמסתיים ב-13 אגורות — ספק הדמה דוחה
    const s = await owner.post('/v1/sales', { registerId: register2Id, lines: [{ productId: prod('8002').id, qtyMilli: 1000, unitPriceAgorot: 2913 }] }, true);
    expect(s.status).toBe(200);
    const p = await owner.post(`/v1/sales/${s.body.id}/payments`, { method: 'card', amountAgorot: 2913 }, true);
    expect(p.body.payment.status).toBe('failed');
    const f = await owner.post(`/v1/sales/${s.body.id}/finalize`, { tenders: [] }, true);
    expect(f.status).toBe(422);
    expect(f.body.code).toBe('not_settled');
    const cancel = await owner.post(`/v1/sales/${s.body.id}/cancel`, { reason: 'כרטיס סורב' });
    expect(cancel.body.sale.status).toBe('cancelled');
  });

  it('T19: cashier discount over the limit needs a manager PIN', async () => {
    const line = [{ productId: prod('8001').id, qtyMilli: 1000, discountBp: 4000 }];
    const r = await cashier.post('/v1/sales', { registerId, lines: line }, true);
    expect(r.status).toBe(403);
    const ok = await cashier.post('/v1/sales', { registerId, lines: line, approverPin: '9999' }, true);
    expect(ok.status).toBe(200);
    expect(ok.body.discount_approved_by).toBeTruthy();
    await cashier.post(`/v1/sales/${ok.body.id}/cancel`, { reason: 'בדיקה' });
  });

  it('G-11/G-12: age-restricted products need an ID check', async () => {
    const r = await cashier.post('/v1/sales', { registerId, lines: [{ productId: prod('7001').id, qtyMilli: 1000 }] }, true);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('age_check');
  });

  it('G-13: deposit line added automatically', async () => {
    const r = await sell(cashier, [{ productId: prod('4002').id, qtyMilli: 2000 }], [{ method: 'cash', amountAgorot: 900 }]);
    const lines = r.finalize!.body.sale.lines;
    expect(lines.map((l: any) => l.kind)).toEqual(['item', 'deposit']);
    expect(lines[1].total_agorot).toBe(60);
  });

  it('T38: cash-law cap on a large sale', async () => {
    // מחיר של ₪8,000 (מנהל רשאי לשנות מחיר) — מעל סף ₪6,000, אז מזומן מותר עד 10%
    const r = await sell(owner, [{ productId: prod('8001').id, qtyMilli: 1000, unitPriceAgorot: 8_000_00 }], [{ method: 'cash', amountAgorot: 8_000_00 }], {}, register2Id);
    expect(r.finalize!.status).toBe(422);
    expect(r.finalize!.body.code).toBe('cash_limit');
    await owner.post(`/v1/sales/${r.create.body.id}/cancel`, { reason: 'מגבלת מזומן' });
  });

  it('D07 / T02: no negative stock by default', async () => {
    const r = await sell(cashier, [{ productId: prod('6001').id, qtyMilli: 49_000 }], [{ method: 'cash', amountAgorot: 49 * 4990 }]);
    expect(r.finalize!.status).toBe(409);
    expect(r.finalize!.body.code).toBe('out_of_stock');
    await cashier.post(`/v1/sales/${r.create.body.id}/cancel`, { reason: 'אין מלאי' });
  });

  it('finalize replay with the same key returns the same document', async () => {
    const s = await cashier.post('/v1/sales', { registerId, lines: [{ productId: prod('2001').id, qtyMilli: 1000 }] }, true);
    const body = { tenders: [{ method: 'cash', amountAgorot: 790 }] };
    const f1 = await cashier.post(`/v1/sales/${s.body.id}/finalize`, body, 'fin-key-123456');
    const f2 = await cashier.post(`/v1/sales/${s.body.id}/finalize`, body, 'fin-key-123456');
    expect(f2.body.document.serial).toBe(f1.body.document.serial);
  });
});

describe('documents', () => {
  let docId: string;
  it('FIS-05 / T14: first print is the original, then copies', async () => {
    const list = await owner.get('/v1/documents?type=tax_invoice_receipt');
    docId = list.body.at(-1).id;
    const p1 = await owner.post(`/v1/documents/${docId}/print`, { format: '80mm' });
    const p2 = await owner.post(`/v1/documents/${docId}/print`, { format: 'a4' });
    expect(p1.body.mark).toBe('מקור');
    expect(p2.body.mark).toBe('העתק נאמן למקור');
    expect(p1.body.html).toContain('חשבונית מס / קבלה');
    // מצב פיילוט (ברירת מחדל): כל מסמך מסומן כלא רשמי
    expect(p1.body.html).toContain('פיילוט — לא מסמך רשמי');
  });

  it('QA-03 / T24: issued documents and movements cannot be changed or deleted, even directly in the DB', async () => {
    const c = new pg.Client({ connectionString: APP_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [ownerSession.tenant.id]);
    await expect(c.query('UPDATE documents SET total_agorot = 1 WHERE id = $1', [docId])).rejects.toThrow(/DLX_IMMUTABLE/);
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [ownerSession.tenant.id]);
    await expect(c.query('DELETE FROM documents WHERE id = $1', [docId])).rejects.toThrow(/DLX_IMMUTABLE/);
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [ownerSession.tenant.id]);
    await expect(c.query('DELETE FROM stock_movements')).rejects.toThrow(/DLX_IMMUTABLE/);
    await c.query('ROLLBACK');
    await c.end();
    const d = await owner.get(`/v1/documents/${docId}`);
    expect(d.body.hash_ok).toBe(true);
  });

  it('public link shows the document without login', async () => {
    const l = await owner.post(`/v1/documents/${docId}/link`);
    const r = await app.inject({ method: 'GET', url: l.body.apiUrl });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('העתק נאמן למקור');
    expect((await app.inject({ method: 'GET', url: '/v1/public/documents/short' })).statusCode).toBe(404);
  });

  it('pilot: switching to official documents is owner-only, needs registration and exact confirmation', async () => {
    const cur = await owner.get('/v1/settings/documents-mode');
    expect(cur.body.documents_mode).toBe('shadow');
    const mgr = client(app, (await login(app, 'demo', 'manager@demo.co.il', 'demo1234')).token);
    expect((await mgr.put('/v1/settings/documents-mode', { mode: 'live' })).status).toBe(403);
    const noConfirm = await owner.put('/v1/settings/documents-mode', { mode: 'live', confirm: 'כן' });
    expect(noConfirm.body.code).toBe('confirm');
    const ok = await owner.put('/v1/settings/documents-mode', { mode: 'live', confirm: 'אני מאשר שהתוכנה רשומה ושרו"ח אישר את המסמכים' });
    expect(ok.body.documents_mode).toBe('live');
  });

  it('QA-09: B2B tax invoice above the threshold gets an allocation number', async () => {
    const cust = (await owner.get('/v1/customers?q=כהן')).body[0];
    const big = await owner.post('/v1/documents', { type: 'tax_invoice', customerId: cust.id, lines: [{ name: 'ייעוץ', qtyMilli: 1000, unitPriceAgorot: 11_800_00 }], postToAccount: false }, true);
    expect(big.status).toBe(200);
    expect(big.body.allocation_number).toMatch(/^\d{9}$/);
    const small = await owner.post('/v1/documents', { type: 'tax_invoice', customerId: cust.id, lines: [{ name: 'שירות', qtyMilli: 1000, unitPriceAgorot: 1180_00 }], postToAccount: false }, true);
    expect(small.body.allocation_status).toBe('not_required');
  });
});

describe('pilot tools', () => {
  it('creates a training copy: same products and PINs, documents marked as training, no real stock', async () => {
    const r = await owner.post('/v1/settings/training');
    expect(r.status).toBe(200);
    expect(r.body.slug).toBe('demo-train');
    const again = await owner.post('/v1/settings/training');
    expect(again.body.id).toBe(r.body.id);
    const tc = await pinLogin(app, 'demo-train', '1234');
    expect(tc.tenant.slug).toBe('demo-train');
    const t = client(app, tc.token);
    const products = await t.get('/v1/products');
    expect(products.body.length).toBe(demo.products.length);
    await t.post('/v1/cash-sessions/open', { registerId: tc.registers[0].id, openingFloatAgorot: 0 });
    const milk = products.body.find((p: any) => p.sku === '1001');
    const s = await sell(t, [{ productId: milk.id, qtyMilli: 1000 }], [{ method: 'cash', amountAgorot: 690 }], {}, tc.registers[0].id);
    expect(s.finalize!.status).toBe(200);
    const pr = await t.post(`/v1/documents/${s.finalize!.body.document.id}/print`, { format: '80mm' });
    expect(pr.body.html).toContain('תרגול');
    expect((await t.put('/v1/settings/documents-mode', { mode: 'live', confirm: 'x' })).status).toBe(403); // קופאי
    // העסק האמיתי לא הושפע: אין מכירה בתרגול ברשימה שלו
    const real = await owner.get('/v1/sales?limit=500');
    expect(real.body.some((x: any) => x.id === s.create.body.id)).toBe(false);
  });

  it('imports customers with opening balances and products with opening stock', async () => {
    const dry = await owner.post('/v1/customers/import', { dryRun: true, rows: [{ name: 'לקוח מיובא', phone: '050-0000001', balance: '150.50' }, { name: '' }] });
    expect(dry.body.failed).toBe(1);
    const imp = await owner.post('/v1/customers/import', { rows: [{ name: 'לקוח מיובא', phone: '050-0000001', balance: '150.50', kind: 'עסקי', taxId: '512345679' }] });
    expect(imp.body.created).toBe(1);
    const found = (await owner.get('/v1/customers?q=לקוח מיובא')).body[0];
    expect(found.balance_agorot).toBe(15050);
    const pi = await owner.post('/v1/products/import', { branchId: demo.branchId, rows: [{ sku: 'IMP1', name: 'מוצר מיובא', price: '12.90', stock: '7' }] });
    expect(pi.body.created).toBe(1);
    const p = (await owner.get('/v1/products?q=IMP1')).body[0];
    expect((await owner.get(`/v1/products/${p.id}`)).body.stock[0].on_hand).toBe(7000);
  });

  it('system info tells the UI which providers are connected', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/system/info' });
    expect(r.json().paymentIntegrated).toBe(true); // בבדיקות: ספק דמה
    expect(r.json().softwareRegistered).toBe(true);
  });
});

describe('returns', () => {
  it('T15 / T16 / QA-13: partial return linked to the original, never more than sold', async () => {
    const r = await sell(cashier, [{ productId: prod('1003').id, qtyMilli: 5000 }], [{ method: 'cash', amountAgorot: 1950 }]);
    const sale = r.finalize!.body.sale;
    const line = sale.lines[0];
    const ret = await cashier.post('/v1/returns', { saleId: sale.id, registerId, reason: 'לקוח החזיר', lines: [{ saleLineId: line.id, qtyMilli: 2000 }] }, true);
    expect(ret.status).toBe(200);
    expect(ret.body.total_agorot).toBe(780);
    expect(ret.body.document.doc_type).toBe('credit_invoice');
    const credit = await owner.get(`/v1/documents/${ret.body.document.id}`);
    expect(credit.body.original_document_id).toBe(sale.document_id);
    const tooMuch = await cashier.post('/v1/returns', { saleId: sale.id, registerId, reason: 'עוד', lines: [{ saleLineId: line.id, qtyMilli: 4000 }] }, true);
    expect(tooMuch.status).toBe(422);
  });

  it('G-06: refund as a store voucher, then pay with it', async () => {
    const r = await sell(cashier, [{ productId: prod('5005').id, qtyMilli: 1000 }], [{ method: 'cash', amountAgorot: 1890 }]);
    const sale = r.finalize!.body.sale;
    const ret = await cashier.post('/v1/returns', { saleId: sale.id, registerId, reason: 'החלפה', refundMethod: 'credit_note', lines: [{ saleLineId: sale.lines[0].id, qtyMilli: 1000 }] }, true);
    expect(ret.body.voucher.amount_agorot).toBe(1890);
    const pay = await sell(cashier, [{ productId: prod('5002').id, qtyMilli: 1000 }], [{ method: 'credit_note', amountAgorot: 590, voucherCode: ret.body.voucher.code }]);
    expect(pay.finalize!.status).toBe(200);
    const v = await cashier.get(`/v1/vouchers/${ret.body.voucher.code}`);
    expect(v.body.balance_agorot).toBe(1300);
  });
});

describe('customers', () => {
  it('CRM-03 / CRM-04: sale on account within the limit, then a receipt reduces the balance', async () => {
    const cust = (await owner.get('/v1/customers?q=כהן')).body[0];
    const before = (await owner.get(`/v1/customers/${cust.id}`)).body.balance_agorot;
    const r = await sell(owner, [{ productId: prod('5004').id, qtyMilli: 2000 }], [{ method: 'customer_account', amountAgorot: 3380 }], { customerId: cust.id }, register2Id);
    expect(r.finalize!.status).toBe(200);
    const mid = (await owner.get(`/v1/customers/${cust.id}`)).body.balance_agorot;
    expect(mid - before).toBe(3380);
    const pay = await owner.post(`/v1/customers/${cust.id}/payments`, { method: 'transfer', amountAgorot: 3380 }, true);
    expect(pay.body.document.doc_type).toBe('receipt');
    expect(pay.body.balance_agorot).toBe(before);
  });
});

describe('stock', () => {
  it('T27: count posts the difference from the snapshot, sales after it are kept', async () => {
    const pid = prod('6002').id;
    const branchId = demo.branchId;
    const ic = await owner.post('/v1/inventory-counts', { branchId, productIds: [pid] });
    const expected = ic.body.lines[0].expected_milli;
    await sell(cashier, [{ productId: pid, qtyMilli: 1000 }], [{ method: 'cash', amountAgorot: 1190 }]);
    await owner.put(`/v1/inventory-counts/${ic.body.id}/lines`, { lines: [{ productId: pid, countedMilli: expected - 3000 }] });
    await owner.post(`/v1/inventory-counts/${ic.body.id}/submit`);
    await owner.post(`/v1/inventory-counts/${ic.body.id}/review`);
    const posted = await owner.post(`/v1/inventory-counts/${ic.body.id}/post`);
    expect(posted.body.status).toBe('posted');
    const stock = (await owner.get(`/v1/products/${pid}`)).body.stock[0].on_hand;
    expect(stock).toBe(expected - 1000 - 3000);
    const again = await owner.post(`/v1/inventory-counts/${ic.body.id}/post`);
    expect(again.body.replay).toBe(true);
    expect((await owner.get(`/v1/products/${pid}`)).body.stock[0].on_hand).toBe(stock);
  });

  it('T07: damaged goods are received into a non-saleable location', async () => {
    const gr = await owner.post('/v1/goods-receipts', {
      supplierId: demo.supplierId, branchId: demo.branchId, reason: 'משלוח דחוף בלי הזמנה',
      lines: [{ productId: prod('5001').id, qtyMilli: 2000, unitCostAgorot: 800, condition: 'damaged' }],
    });
    await owner.post(`/v1/goods-receipts/${gr.body.id}/post`);
    const p = (await owner.get(`/v1/products/${prod('5001').id}`)).body.stock[0];
    expect(p.damaged).toBe(2000);
  });
});

describe('shift close, audit, exports', () => {
  it('CSH-03/05: close requires a reason for a variance, then produces Z', async () => {
    const x = await cashier.get(`/v1/cash-sessions/${sessionId}`);
    const expected = x.body.expected_cash_agorot;
    const bad = await cashier.post(`/v1/cash-sessions/${sessionId}/close`, { countedCashAgorot: expected - 5000 });
    expect(bad.status).toBe(422);
    const withReason = await cashier.post(`/v1/cash-sessions/${sessionId}/close`, { countedCashAgorot: expected - 5000, varianceReason: 'חסר בספירה' });
    expect(withReason.status).toBe(403); // קופאי לא מאשר פער גדול
    const ok = await owner.post(`/v1/cash-sessions/${sessionId}/close`, { countedCashAgorot: expected - 5000, varianceReason: 'חסר בספירה' });
    expect(ok.status).toBe(200);
    expect(ok.body.session.status).toBe('closed');
    expect(ok.body.session.variance_agorot).toBe(-5000);
    expect(ok.body.sales.count).toBeGreaterThan(3);
  });

  it('T23: audit chain verifies', async () => {
    const v = await owner.get('/v1/audit/verify');
    expect(v.body.ok).toBe(true);
    expect(v.body.count).toBeGreaterThan(20);
  });

  it('reports match documents', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
    const dash = await owner.get('/v1/reports/dashboard');
    expect(dash.body.sales.count).toBeGreaterThan(0);
    const daily = await owner.get(`/v1/reports/sales?from=${today}&to=${today}&groupBy=day`);
    expect(daily.body[0].total).toBe(dash.body.sales.total);
    const csv = await app.inject({ method: 'GET', url: `/v1/exports/accountant.csv?from=${today}&to=${today}`, headers: { authorization: `Bearer ${ownerSession.token}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('חשבונית מס / קבלה');
  });

  it('OPEN-01 (draft): every unified-format record has a fixed width', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
    const r = await owner.post('/v1/exports/open-format', { from: '2026-01-01', to: today });
    expect(r.status).toBe(200);
    const text = Buffer.from(r.body.bkmvdataBase64, 'base64').toString('latin1').split('\r\n').filter(Boolean);
    for (const line of text) expect(line.length).toBe(recordWidth(line.slice(0, 4)));
    expect(Object.keys(RECORDS)).toContain('C100');
    expect(r.body.warning).toMatch(/טיוטה/);
  });

  it('QA-07: exempt dealer gets receipts only', async () => {
    const o = await login(app, 'other-shop', 'o@other.co.il', 'password1');
    const oc = client(app, o.token);
    const p = await oc.post('/v1/products', { sku: 'A1', name: 'שירות תיקון', priceAgorot: 10000, trackStock: false });
    await oc.post('/v1/cash-sessions/open', { registerId: o.registers[0].id, openingFloatAgorot: 0 });
    const s = await sell(oc, [{ productId: p.body.id, qtyMilli: 1000 }], [{ method: 'cash', amountAgorot: 10000 }], {}, o.registers[0].id);
    expect(s.finalize!.body.document.doc_type).toBe('receipt');
    expect(s.finalize!.body.sale.vat_agorot).toBe(0);
    const cu = await oc.post('/v1/customers', { name: 'לקוח' });
    const inv = await oc.post('/v1/documents', { type: 'tax_invoice', customerId: cu.body.id, lines: [{ name: 'x', qtyMilli: 1000, unitPriceAgorot: 100 }] }, true);
    expect(inv.status).toBe(422);
  });
});
