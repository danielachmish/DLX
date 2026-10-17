// נתוני הדגמה (S20, "מצב הדגמה" בהמלצות ה-UX): עסק "demo" עם מוצרים, ספק, מלאי ועובדים.
// עובר דרך ה-API עצמו, כך שכל הכללים (מספור, מלאי, ביקורת) חלים גם על נתוני ההדגמה.
// כניסה: קוד עסק demo · owner@demo.co.il / demo1234 · קופאי PIN 1234 · מנהל PIN 9999
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './migrate.js';

const P = (sku: string, name: string, price: number, extra: Record<string, unknown> = {}) => ({ sku, name, priceAgorot: price, ...extra });

export const DEMO_PRODUCTS = [
  P('1001', 'חלב 3% קרטון 1 ליטר', 690, { category: 'מוצרי חלב', barcodes: [{ barcode: '7290004131074' }], costAgorot: 480, unitPriceBasis: 'לליטר', unitPriceFactorMilli: 1000 }),
  P('1002', 'גבינה לבנה 5% 250 גרם', 590, { category: 'מוצרי חלב', barcodes: [{ barcode: '7290004127053' }], costAgorot: 390, unitPriceBasis: 'ל-100 גרם', unitPriceFactorMilli: 2500 }),
  P('1003', 'יוגורט טבעי 200 גרם', 390, { category: 'מוצרי חלב', barcodes: [{ barcode: '7290011194215' }], costAgorot: 250 }),
  P('1004', 'ביצים L תבנית 12', 1290, { category: 'מוצרי חלב', barcodes: [{ barcode: '7290000176017' }], costAgorot: 950 }),
  P('2001', 'לחם אחיד פרוס', 790, { category: 'לחם ומאפים', barcodes: [{ barcode: '7290000270012' }], costAgorot: 520 }),
  P('2002', 'פיתות 10 יחידות', 1090, { category: 'לחם ומאפים', barcodes: [{ barcode: '7290000270029' }], costAgorot: 700 }),
  P('3001', 'עגבניות', 990, { category: 'פירות וירקות', taxCategory: 'zero', soldByWeight: true, unitMeasure: 'kg', scaleCode: '10001', costAgorot: 550 }),
  P('3002', 'מלפפונים', 790, { category: 'פירות וירקות', taxCategory: 'zero', soldByWeight: true, unitMeasure: 'kg', scaleCode: '10002', costAgorot: 400 }),
  P('3003', 'בננות', 1190, { category: 'פירות וירקות', taxCategory: 'zero', soldByWeight: true, unitMeasure: 'kg', scaleCode: '10003', costAgorot: 700 }),
  P('3004', 'תפוחי עץ', 1290, { category: 'פירות וירקות', taxCategory: 'zero', soldByWeight: true, unitMeasure: 'kg', scaleCode: '10004', costAgorot: 760 }),
  P('4001', 'קוקה קולה 1.5 ליטר', 890, { category: 'משקאות', depositAgorot: 30, barcodes: [{ barcode: '7290011017866' }, { barcode: '17290011017863', unitFactorMilli: 6000, kind: 'pack' }], costAgorot: 560 }),
  P('4002', 'מים מינרליים 1.5 ליטר', 390, { category: 'משקאות', depositAgorot: 30, barcodes: [{ barcode: '7290000144016' }], costAgorot: 190 }),
  P('4003', 'מיץ תפוזים טבעי 1 ליטר', 1490, { category: 'משקאות', barcodes: [{ barcode: '7290000144023' }], costAgorot: 900 }),
  P('4101', 'יין אדום יבש 750 מ"ל', 4990, { category: 'אלכוהול', restriction: 'alcohol', barcodes: [{ barcode: '7290000555010' }], costAgorot: 2900 }),
  P('4102', 'בירה לאגר 500 מ"ל', 990, { category: 'אלכוהול', restriction: 'alcohol', depositAgorot: 30, barcodes: [{ barcode: '7290000555027' }], costAgorot: 520 }),
  P('5001', 'אורז פרסי 1 ק"ג', 1190, { category: 'מזווה', barcodes: [{ barcode: '7290000066318' }], costAgorot: 780 }),
  P('5002', 'פסטה ספגטי 500 גרם', 590, { category: 'מזווה', barcodes: [{ barcode: '7290000066325' }], costAgorot: 330 }),
  P('5003', 'שמן זית כתית 750 מ"ל', 3990, { category: 'מזווה', barcodes: [{ barcode: '7290000066332' }], costAgorot: 2700 }),
  P('5004', 'קפה טורקי 200 גרם', 1690, { category: 'מזווה', barcodes: [{ barcode: '7290000066349' }], costAgorot: 1050 }),
  P('5005', 'טחינה גולמית 500 גרם', 1890, { category: 'מזווה', barcodes: [{ barcode: '7290000066356' }], costAgorot: 1200 }),
  P('6001', 'נייר טואלט 32 גלילים', 4990, { category: 'ניקיון', barcodes: [{ barcode: '7290000077017' }], costAgorot: 3400 }),
  P('6002', 'נוזל כלים 1 ליטר', 1190, { category: 'ניקיון', barcodes: [{ barcode: '7290000077024' }], costAgorot: 690 }),
  P('7001', 'סיגריות — חפיסה', 3800, { category: 'טבק', restriction: 'tobacco', barcodes: [{ barcode: '7290000888019' }], costAgorot: 3300 }),
  P('8001', 'חולצת טריקו כותנה', 7990, { category: 'ביגוד', barcodes: [{ barcode: '7290000999016' }], costAgorot: 3200 }),
  P('8002', 'גרביים 3 זוגות', 2990, { category: 'ביגוד', barcodes: [{ barcode: '7290000999023' }], costAgorot: 1100 }),
  P('9001', 'שקית נשיאה', 10, { category: 'כללי', trackStock: false, barcodes: [{ barcode: '7290000000017' }] }),
];

export async function seedDemo(app: Awaited<ReturnType<typeof buildApp>>, slug = 'demo') {
  const call = async (method: string, url: string, token: string | null, payload?: unknown, key?: string) => {
    const res = await app.inject({
      method: method as any, url, payload: payload as any,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    });
    if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
    return res.json();
  };
  const s = await call('POST', '/v1/auth/signup', null, {
    business: { slug, legalName: 'מכולת הדגמה בע"מ', tradeName: 'מכולת DLX', taxId: '515555555', taxStatus: 'company', address: 'הרצל 1, תל אביב', phone: '03-1234567', email: 'demo@dlx.co.il' },
    branch: { name: 'סניף מרכז', address: 'הרצל 1, תל אביב' },
    owner: { name: 'דניאל (בעלים)', email: 'owner@demo.co.il', password: 'demo1234' },
  });
  const t = s.token as string;
  const branchId = s.branches[0].id as string;
  await call('PUT', '/v1/settings/business', t, {
    legalName: 'מכולת הדגמה בע"מ', tradeName: 'מכולת DLX', taxId: '515555555', taxStatus: 'company', address: 'הרצל 1, תל אביב', phone: '03-1234567', email: 'demo@dlx.co.il',
    returnPolicy: 'החזרה עד 14 ימים מיום הקנייה, עם חשבונית, בפריט שלא נפגם. ההחזר באמצעי התשלום המקורי.', receiptFooter: 'תודה שקניתם אצלנו!',
  });
  await call('POST', '/v1/registers', t, { branchId, code: '02', name: 'קופה 2' });
  await call('POST', '/v1/users', t, { name: 'נועה (קופאית)', role: 'cashier', pin: '1234', branchId });
  await call('POST', '/v1/users', t, { name: 'אבי (מנהל סניף)', role: 'manager', email: 'manager@demo.co.il', password: 'demo1234', pin: '9999', branchId });
  await call('POST', '/v1/users', t, { name: 'יוסי (מחסנאי)', role: 'warehouse', pin: '5555', branchId });
  await call('POST', '/v1/users', t, { name: 'רו"ח מירב', role: 'accountant', email: 'cpa@demo.co.il', password: 'demo1234' });
  const products: any[] = [];
  for (const p of DEMO_PRODUCTS) products.push(await call('POST', '/v1/products', t, p));
  const sup = await call('POST', '/v1/suppliers', t, { name: 'שיווק מזון מרכז בע"מ', taxId: '512345679', phone: '03-7654321', paymentTerms: 'שוטף + 30' });
  const tracked = products.filter((p) => p.track_stock);
  const po = await call('POST', '/v1/purchase-orders', t, {
    supplierId: sup.id, branchId, lines: tracked.map((p) => ({ productId: p.id, qtyMilli: p.sold_by_weight ? 40_000 : 48_000, unitCostAgorot: p.cost_agorot || Math.round(p.price_agorot * 0.6) })),
  });
  await call('POST', `/v1/purchase-orders/${po.id}/approve`, t, {});
  await call('POST', `/v1/purchase-orders/${po.id}/order`, t, {});
  const gr = await call('POST', '/v1/goods-receipts', t, { poId: po.id, supplierId: sup.id, branchId, supplierDocRef: 'ת.מ. 4471' });
  await call('POST', `/v1/goods-receipts/${gr.id}/post`, t, {});
  await call('POST', '/v1/customers', t, { name: 'משרד רואי חשבון כהן', kind: 'business', taxId: '512345679', phone: '050-1112233', creditLimitAgorot: 200000 });
  await call('POST', '/v1/customers', t, { name: 'רינה לוי', kind: 'private', phone: '052-4445566' });
  return { token: t, branchId, products, supplierId: sup.id };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = { ...loadConfig(), logger: false };
  await migrate(config.ownerUrl);
  const app = await buildApp(config);
  try {
    await seedDemo(app);
    console.log('demo seeded: slug=demo owner@demo.co.il/demo1234 · cashier PIN 1234 · manager PIN 9999');
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}
