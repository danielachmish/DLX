// הזמנת רכש (S10, PUR-02..PUR-05): שורות מוזמן/התקבל/פתוח, עריכה בטיוטה, אישור, שליחה, ביטול, קליטה והדפסה
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import DataTable from '../components/DataTable';
import Icon from '../components/Icon';
import { ActionBar, Badge, Card, LoadError, PageHeader, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { askConfirm } from '../lib/dialogs';
import { dateOnly, money, qty } from '../lib/format';
import { printHtml } from '../lib/misc';
import { can, useSession } from '../lib/session';
import { showError, showToast } from '../lib/toast';
import { useLoad } from '../lib/useLoad';
import { esc, PO_STATUS, printPage } from './office/shared';
import { type PoLineDraft, PoLinesEditor, poLinesBody } from './Purchasing';
import '../styles/office.css';

export default function PoView() {
  const { id } = useParams();
  const nav = useNavigate();
  const s = useSession();
  const { data: po, error, loading, reload, setData } = useLoad(() => api.get(`/purchase-orders/${id}`), [id]);
  const [editing, setEditing] = useState<PoLineDraft[] | null>(null);
  const write = can('purchase:write');

  if (loading && !po) return <><PageHeader title="הזמנת רכש" back /><Skeleton variant="card" /></>;
  if (error && !po) return <><PageHeader title="הזמנת רכש" back /><LoadError error={error} what="ההזמנה" onRetry={reload} /></>;
  const st = PO_STATUS[po.status];
  const branchName = s?.branches.find((b) => b.id === po.branch_id)?.name ?? '';

  const act = async (action: 'approve' | 'order' | 'cancel' | 'close') => {
    if (action === 'cancel' && !(await askConfirm({ title: 'לבטל את ההזמנה?', confirmLabel: 'ביטול הזמנה', cancelLabel: 'חזרה', danger: true }))) return;
    try { setData(await api.post(`/purchase-orders/${id}/${action}`)); showToast('עודכן'); } catch (e) { showError(e); }
  };
  const saveLines = async () => {
    try {
      setData(await api.put(`/purchase-orders/${id}`, { supplierId: po.supplier_id, branchId: po.branch_id, expectedAt: po.expected_at, notes: po.notes, lines: poLinesBody(editing!) }));
      setEditing(null); showToast('השורות נשמרו');
    } catch (e) { showError(e); }
  };
  const receive = async () => {
    try { const r = await api.post('/goods-receipts', { poId: po.id, supplierId: po.supplier_id, branchId: po.branch_id }); nav(`/purchasing/receipts/${r.id}`); } catch (e) { showError(e); }
  };
  const print = () => {
    const rows = po.lines.map((l: any) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td class="n">${qty(l.qty_milli)}</td><td class="n">${esc(money(l.unit_cost_agorot))}</td><td class="n">${esc(money(Math.round((l.qty_milli * l.unit_cost_agorot) / 1000)))}</td></tr>`).join('');
    printHtml(printPage(`הזמנת רכש ${po.number}`, `<h1>הזמנת רכש ${po.number}</h1>
      <p>${esc(s?.tenant.trade_name || s?.tenant.legal_name)} · ע.מ. ${esc(s?.tenant.tax_id)}<br>לכבוד: ${esc(po.supplier_name)}<br>תאריך: ${esc(dateOnly(po.created_at))}${po.expected_at ? ` · צפי אספקה: ${esc(dateOnly(po.expected_at))}` : ''}<br>סניף: ${esc(branchName)}</p>
      <table><thead><tr><th>מק"ט</th><th>פריט</th><th class="n">כמות</th><th class="n">מחיר ליחידה</th><th class="n">סה"כ</th></tr></thead><tbody>${rows}</tbody></table>
      <p><b>סה"כ לפני מע"מ: ${esc(money(po.total_agorot))}</b></p>${po.notes ? `<p>הערות: ${esc(po.notes)}</p>` : ''}`));
  };

  return (
    <div className="stack">
      <PageHeader title={`הזמנת רכש ${po.number}`} sub={`${po.supplier_name} · ${st?.label ?? po.status}`} onBack={() => nav('/purchasing')}
        actions={<button type="button" className="action-btn ghost inline" onClick={print}><Icon name="printer" size={18} />הדפסה</button>} />
      <Card>
        <dl className="kv">
          <dt>סטטוס</dt><dd><Badge tone={st?.tone}>{st?.label ?? po.status}</Badge></dd>
          <dt>ספק</dt><dd>{po.supplier_name}</dd>
          <dt>סניף</dt><dd>{branchName}</dd>
          <dt>נוצרה</dt><dd>{dateOnly(po.created_at)}</dd>
          <dt>צפי אספקה</dt><dd>{po.expected_at ? dateOnly(po.expected_at) : '—'}</dd>
          <dt>סה"כ לפני מע"מ</dt><dd>{money(po.total_agorot)}</dd>
          {po.notes && <><dt>הערות</dt><dd>{po.notes}</dd></>}
        </dl>
      </Card>

      {editing ? (
        <Card title="עריכת שורות" icon="edit">
          <PoLinesEditor lines={editing} setLines={setEditing} />
          <div className="form-actions"><button type="button" className="action-btn" disabled={!editing.length} onClick={saveLines}>שמירה</button><button type="button" className="action-btn ghost" onClick={() => setEditing(null)}>ביטול</button></div>
        </Card>
      ) : (
        <DataTable rows={po.lines} rowKey={(l: any) => l.id} columns={[
          { key: 'name', label: 'פריט', primary: true, value: (l: any) => l.name },
          { key: 'sku', label: 'מק"ט', muted: true, value: (l: any) => l.sku, hideOnCard: true },
          { key: 'ord', label: 'הוזמן', num: true, render: (l: any) => qty(l.qty_milli) },
          { key: 'rec', label: 'התקבל', num: true, render: (l: any) => qty(l.received_qty_milli) },
          { key: 'open', label: 'פתוח', num: true, render: (l: any) => (l.open_qty_milli > 0 ? <Badge tone="warn">{qty(l.open_qty_milli)}</Badge> : <Badge tone="ok">0</Badge>) },
          { key: 'cost', label: 'עלות ליחידה', num: true, hideOnCard: true, render: (l: any) => money(l.unit_cost_agorot) },
          { key: 'total', label: 'סה"כ', num: true, render: (l: any) => money(Math.round((l.qty_milli * l.unit_cost_agorot) / 1000)) },
        ]} />
      )}

      {write && !editing && (
        <ActionBar>
          {po.status === 'draft' && <button type="button" className="action-btn" onClick={() => act('approve')}>אישור הזמנה</button>}
          {po.status === 'draft' && <button type="button" className="action-btn secondary" onClick={() => setEditing(po.lines.map((l: any) => ({ product: { id: l.product_id, name: l.name, sku: l.sku, price_agorot: 0 }, qty: qty(l.qty_milli), cost: (l.unit_cost_agorot / 100).toFixed(2) })))}>עריכת שורות</button>}
          {po.status === 'approved' && <button type="button" className="action-btn" onClick={() => act('order')}>סימון כנשלחה לספק</button>}
          {['approved', 'ordered', 'partial'].includes(po.status) && can('inventory:receive') && <button type="button" className={'action-btn' + (po.status === 'approved' ? ' secondary' : '')} onClick={receive}><Icon name="truck" size={18} /> קליטה מההזמנה</button>}
          {po.status === 'partial' && <button type="button" className="action-btn secondary" onClick={() => act('close')}>סגירה (בלי היתרה)</button>}
          {po.status === 'received' && <button type="button" className="action-btn secondary" onClick={() => act('close')}>סגירת הזמנה</button>}
          {['draft', 'approved', 'ordered'].includes(po.status) && <button type="button" className="action-btn danger-soft" onClick={() => act('cancel')}>ביטול</button>}
        </ActionBar>
      )}
    </div>
  );
}
