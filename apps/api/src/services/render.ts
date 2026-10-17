// הדפסת מסמך (ACC-04, INT-04, D-04 בסקירה): HTML מוכן להדפסה — 80mm, 58mm או A4, מימין לשמאל.
// "מקור" בהדפסה הראשונה בלבד, אחריה "העתק נאמן למקור" (FIS-05). הכל ממה שנשמר במסמך — לא מהקטלוג העדכני.
import { DOC_TYPES, type DocType, formatAgorot, formatQty, formatRate, PAYMENT_LABEL, type PaymentMethod, STATUS_LABEL } from '@dlx/core';

export type PrintFormat = '80mm' | '58mm' | 'a4';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const dt = (iso: string) => new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(new Date(iso));

export interface RenderOpts { format: PrintFormat; mark: string; viewUrl?: string | null; originalSerial?: string | null; softwareRegistration?: string | null }

export function renderDocumentHtml(doc: any, opts: RenderOpts): string {
  const info = DOC_TYPES[doc.doc_type as DocType];
  const i = doc.issuer;
  const t = doc.totals;
  const wide = opts.format === 'a4';
  const width = opts.format === 'a4' ? '190mm' : opts.format === '58mm' ? '54mm' : '76mm';
  const lines = (doc.lines as any[]).map((l) => `
      <tr>
        <td class="nm">${esc(l.name)}${l.sku && wide ? `<div class="sub">${esc(l.sku)}</div>` : ''}${l.discount ? `<div class="sub">הנחה ${formatAgorot(-l.discount)}</div>` : ''}</td>
        <td class="n">${formatQty(l.qtyMilli)}</td>
        ${wide ? `<td class="n">${formatAgorot(l.unitPrice)}</td>` : ''}
        <td class="n">${formatAgorot(l.total)}</td>
      </tr>`).join('');
  const rates = (t.byRate as any[]).filter((b) => info.carriesVat).map((b) => `
      <tr><td>חייב במע"מ ${formatRate(b.rateBp)}</td><td class="n">${formatAgorot(b.net)}</td></tr>
      ${b.rateBp ? `<tr><td>מע"מ ${formatRate(b.rateBp)}</td><td class="n">${formatAgorot(b.vat)}</td></tr>` : ''}`).join('');
  const pays = (doc.payments as any[]).map((p) => `
      <tr><td>${esc(PAYMENT_LABEL[p.method as PaymentMethod] ?? p.method)}${p.last4 ? ` ••••${esc(p.last4)}` : ''}${p.approvalCode ? ` · אישור ${esc(p.approvalCode)}` : ''}${p.installments > 1 ? ` · ${p.installments} תשלומים` : ''}${p.checkNumber ? ` · שיק ${esc(p.checkNumber)}` : ''}</td>
      <td class="n">${formatAgorot(p.amount)}</td></tr>`).join('');
  const c = doc.customer;
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(info.title)} ${esc(doc.serial)}</title>
<style>
  @page { size: ${opts.format === 'a4' ? 'A4' : `${opts.format === '58mm' ? '58mm' : '80mm'} auto`}; margin: ${wide ? '12mm' : '2mm'}; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Rubik", "Heebo", Arial, sans-serif; color: #000; background: #fff; direction: rtl; }
  .doc { width: ${width}; margin: 0 auto; padding: ${wide ? '0' : '2mm 0'}; font-size: ${wide ? '12pt' : opts.format === '58mm' ? '9pt' : '10pt'}; }
  h1 { font-size: 1.35em; margin: 0; text-align: center; }
  .biz { text-align: center; line-height: 1.4; }
  .biz b { font-size: 1.2em; }
  .title { text-align: center; margin: 3mm 0 1mm; font-size: 1.15em; font-weight: 700; }
  .mark { text-align: center; font-weight: 700; border: 1px solid #000; padding: 1mm; margin: 1mm auto; width: fit-content; }
  .meta, .cust { line-height: 1.5; margin: 2mm 0; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: start; border-bottom: 1px solid #000; font-weight: 600; padding: .6mm 0; }
  td { padding: .6mm 0; vertical-align: top; }
  .n { text-align: left; white-space: nowrap; direction: ltr; unicode-bidi: plaintext; }
  th.n { text-align: left; }
  .sub { font-size: .85em; }
  .sum td { border-top: 1px dashed #000; }
  .total td { font-size: 1.25em; font-weight: 800; border-top: 1px solid #000; }
  .foot { margin-top: 3mm; text-align: center; font-size: .85em; line-height: 1.45; white-space: pre-line; }
  .alloc { text-align: center; font-weight: 700; margin-top: 2mm; }
  .notofficial { text-align: center; font-weight: 800; border: 2px dashed #000; padding: 1.5mm; margin: 2mm 0; font-size: 1.05em; }
  @media screen { body { background: #eef2f4; padding: 16px 0; } .doc { background: #fff; padding: 6mm; box-shadow: 0 8px 24px rgba(0,0,0,.12); border-radius: 8px; } }
</style></head>
<body><div class="doc">
  <div class="biz"><b>${esc(i.tradeName || i.legalName)}</b><br>
    ${i.tradeName && i.tradeName !== i.legalName ? `${esc(i.legalName)}<br>` : ''}
    ${esc(STATUS_LABEL[i.taxStatus as keyof typeof STATUS_LABEL] ?? '')} ${esc(i.taxId)}<br>
    ${i.address ? `${esc(i.address)}<br>` : ''}${i.phone ? `טל' ${esc(i.phone)}` : ''}
  </div>
  <div class="title">${esc(info.title)} מס' ${esc(doc.serial)}</div>
  <div class="mark">${esc(opts.mark)}</div>
  ${doc.documents_mode === 'shadow' ? '<div class="notofficial">פיילוט — לא מסמך רשמי.<br>המסמך הרשמי מופק במערכת הקיימת של העסק.</div>' : ''}
  ${doc.documents_mode === 'training' ? '<div class="notofficial">תרגול — לא מסמך ולא עסקה אמיתית</div>' : ''}
  <div class="meta">תאריך: ${dt(doc.issued_at)}${i.branchName ? `<br>סניף: ${esc(i.branchName)}` : ''}${opts.originalSerial ? `<br>זיכוי למסמך מס' ${esc(opts.originalSerial)}` : ''}</div>
  ${c ? `<div class="cust">לכבוד: ${esc(c.name)}${c.taxId ? `<br>${c.kind === 'business' ? 'ע.מ./ח.פ.' : 'ת.ז.'} ${esc(c.taxId)}` : ''}${c.address ? `<br>${esc(c.address)}` : ''}</div>` : ''}
  <table>
    <thead><tr><th>פריט</th><th class="n">כמות</th>${wide ? '<th class="n">מחיר</th>' : ''}<th class="n">סה"כ</th></tr></thead>
    <tbody>${lines}</tbody>
  </table>
  <table class="sums">
    ${t.discount ? `<tr class="sum"><td>הנחות</td><td class="n">${formatAgorot(-t.discount)}</td></tr>` : ''}
    ${rates}
    ${info.carriesVat ? `<tr><td>סה"כ מע"מ</td><td class="n">${formatAgorot(t.vat)}</td></tr>` : ''}
    <tr class="total"><td>סה"כ${info.isCredit ? ' לזיכוי' : ' לתשלום'}</td><td class="n">${formatAgorot(t.total)}</td></tr>
  </table>
  ${pays ? `<table class="pays"><tr class="sum"><td colspan="2"><b>${info.isCredit ? 'הוחזר' : 'שולם'}</b></td></tr>${pays}
    ${t.rounding ? `<tr><td>עיגול אגורות</td><td class="n">${formatAgorot(t.rounding)}</td></tr>` : ''}
    ${t.change ? `<tr><td>עודף</td><td class="n">${formatAgorot(t.change)}</td></tr>` : ''}</table>` : ''}
  ${doc.allocation_number ? `<div class="alloc">מספר הקצאה: ${esc(doc.allocation_number)}</div>` : ''}
  ${t.notes ? `<div class="foot">${esc(t.notes)}</div>` : ''}
  <div class="foot">${i.returnPolicy ? `${esc(i.returnPolicy)}\n` : ''}${i.footer ? `${esc(i.footer)}\n` : ''}${opts.viewUrl ? `לצפייה במסמך: ${esc(opts.viewUrl)}\n` : ''}הופק באמצעות DLX${doc.documents_mode === 'live' && opts.softwareRegistration ? ` · תוכנה רשומה מס' ${esc(opts.softwareRegistration)}` : ''}</div>
</div>${opts.format !== 'a4' && opts.mark ? '' : ''}</body></html>`;
}
