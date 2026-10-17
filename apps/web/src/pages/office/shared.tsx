// רכיבים משותפים למסכי המשרד: בחירת מוצר בחיפוש, בורר סניף, תוויות למקור תנועה
import { useEffect, useState } from 'react';
import Icon from '../../components/Icon';
import { api, qs } from '../../lib/api';
import { money } from '../../lib/format';
import { useSession } from '../../lib/session';

export interface PickedProduct { id: string; name: string; sku: string; price_agorot: number; cost_agorot?: number; unit_measure?: string; sold_by_weight?: boolean }

// חיפוש מוצר לפי שם / מק"ט / ברקוד — לשורות הזמנה, התאמה, העברה
export function ProductPicker({ onPick, placeholder = 'חיפוש מוצר לפי שם, מק"ט או ברקוד' }: { onPick: (p: PickedProduct) => void; placeholder?: string }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PickedProduct[]>([]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRows([]); return undefined; }
    const t = setTimeout(() => { api.get(`/products${qs({ q: term, limit: 12 })}`).then(setRows).catch(() => setRows([])); }, 220);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="picker">
      <div className="search-box flush">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder}
          onKeyDown={(e) => { if (e.key === 'Enter' && rows[0]) { e.preventDefault(); onPick(rows[0]); setQ(''); } }} />
      </div>
      {rows.length > 0 && (
        <div className="picker-results">
          {rows.map((p) => (
            <button key={p.id} type="button" onClick={() => { onPick(p); setQ(''); setRows([]); }}>
              <span><Icon name="plus" size={16} /> {p.name} <small className="muted">{p.sku}</small></span>
              <span className="money">{money(p.price_agorot)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function BranchSelect({ value, onChange, allowAll = true }: { value: string; onChange: (v: string) => void; allowAll?: boolean }) {
  const s = useSession();
  if (!s) return null;
  const branches = s.user.branchId ? s.branches.filter((b) => b.id === s.user.branchId) : s.branches;
  if (branches.length <= 1 && allowAll) return null;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="סניף">
      {allowAll && !s.user.branchId && <option value="">כל הסניפים</option>}
      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  );
}

export const defaultBranch = (s: ReturnType<typeof useSession>) => s?.user.branchId ?? s?.branches[0]?.id ?? '';

export const SOURCE_LABEL: Record<string, string> = {
  sale: 'מכירה', return: 'החזרה', goods_receipt: 'קליטה', supplier_return: 'החזרה לספק', adjustment: 'התאמה', count: 'ספירה', transfer: 'העברה', opening: 'מלאי פתיחה',
};
export const LOCATION_LABEL: Record<string, string> = { sale: 'למכירה', damaged: 'פגום', transit: 'בדרך' };
export const UNIT_LABEL: Record<string, string> = { unit: 'יחידה', kg: 'ק"ג', g: 'גרם', liter: 'ליטר', ml: 'מ"ל', meter: 'מטר' };
export const TAX_LABEL: Record<string, string> = { standard: 'מע"מ רגיל', zero: 'מע"מ 0%', exempt: 'פטור' };

export const PO_STATUS: Record<string, { label: string; tone?: 'ok' | 'warn' | 'info' | 'danger' | 'teal' }> = {
  draft: { label: 'טיוטה' }, approved: { label: 'מאושרת', tone: 'info' }, ordered: { label: 'נשלחה לספק', tone: 'teal' },
  partial: { label: 'התקבלה חלקית', tone: 'warn' }, received: { label: 'התקבלה', tone: 'ok' }, closed: { label: 'סגורה', tone: 'ok' }, cancelled: { label: 'בוטלה', tone: 'danger' },
};
export const GR_STATUS: Record<string, { label: string; tone?: 'ok' | 'warn' | 'info' }> = {
  draft: { label: 'טיוטה' }, counting: { label: 'בספירה', tone: 'warn' }, verified: { label: 'נבדקה', tone: 'info' }, posted: { label: 'נקלטה למלאי', tone: 'ok' },
};
export const COUNT_STATUS: Record<string, { label: string; tone?: 'ok' | 'warn' | 'info' }> = {
  open: { label: 'פתוחה', tone: 'warn' }, counted: { label: 'נספרה', tone: 'info' }, reviewed: { label: 'נבדקה', tone: 'info' }, posted: { label: 'אושרה', tone: 'ok' },
};

// HTML פשוט להדפסה (הזמנת רכש / מדבקות)
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function printPage(title: string, body: string, css = '') {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  body{font-family:Rubik,Heebo,Arial,sans-serif;margin:12mm;color:#000}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #999;padding:4px 6px;text-align:start}
  .n{text-align:left;direction:ltr}h1{font-size:18pt;margin:0 0 6px}${css}</style></head><body>${body}</body></html>`;
}
