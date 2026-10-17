// בדיקת עשן מול סביבה מותקנת: עסק חדש → מוצר → משמרת → מכירה באשראי ממסוף חיצוני → הדפסה מסומנת פיילוט
// שימוש: node scripts/smoke.mjs https://pos.example.co.il   (מול סביבת בדיקה עם תעודה פנימית: NODE_TLS_REJECT_UNAUTHORIZED=0)
const BASE = process.argv[2] ?? 'https://localhost:8443';
let token = null;
const call = async (method, path, body, key) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const slug = `smoke-${Date.now() % 100000}`;
const s = await call('POST', '/v1/auth/signup', { business: { slug, legalName: 'בדיקת עשן בע"מ', taxId: '515555555', taxStatus: 'company' }, branch: { name: 'ראשי' }, owner: { name: 'בודק', email: 'smoke@x.co.il', password: 'smoke-pass-1' } });
token = s.token;
const p = await call('POST', '/v1/products', { sku: 'S1', name: 'פריט בדיקה', priceAgorot: 4990, trackStock: false });
const reg = s.registers[0].id;
await call('POST', '/v1/cash-sessions/open', { registerId: reg, openingFloatAgorot: 0 });
const sale = await call('POST', '/v1/sales', { registerId: reg, lines: [{ productId: p.id, qtyMilli: 1000 }] }, `k-${Date.now()}-1`);
const integrated = await fetch(BASE + `/v1/sales/${sale.id}/payments`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': `k-${Date.now()}-2` }, body: JSON.stringify({ method: 'card', amountAgorot: 4990 }) }).then((r) => r.json());
console.log('integrated terminal (must fail in prod):', integrated.payment?.status, '-', integrated.payment?.failure_reason);
await call('POST', `/v1/sales/${sale.id}/payments`, { method: 'card', amountAgorot: 4990, terminal: 'external', approvalCode: '123456', last4: '4242' }, `k-${Date.now()}-3`);
const fin = await call('POST', `/v1/sales/${sale.id}/finalize`, { tenders: [] }, `k-${Date.now()}-4`);
const pr = await call('POST', `/v1/documents/${fin.document.id}/print`, { format: '80mm' });
console.log('document:', fin.document.doc_type, fin.document.serial, '| pilot mark:', pr.html.includes('פיילוט — לא מסמך רשמי'));
const live = await fetch(BASE + '/v1/settings/documents-mode', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ mode: 'live', confirm: 'אני מאשר שהתוכנה רשומה ושרו"ח אישר את המסמכים' }) }).then((r) => r.json());
console.log('switch to live without registration:', live.code);
console.log('SMOKE OK');
