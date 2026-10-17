// לוח בקרה לבעל העסק (RPT-01, S02): היום לפי סניף — מכירות, תקבולים, שעות, מוצרים מובילים, משמרות פתוחות וחריגים
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../components/Icon';
import { Card, EmptyState, LoadError, Money, PageHeader, Skeleton, StatCard, StatGrid } from '../components/ui';
import { api, qs } from '../lib/api';
import { dateOnly, money, moneyShort, PAY_LABEL, qty, timeOnly } from '../lib/format';
import { useSession } from '../lib/session';
import { loadPhase, useLoad } from '../lib/useLoad';
import { BranchSelect } from './office/shared';
import '../styles/office.css';

export default function Dashboard() {
  const s = useSession();
  const nav = useNavigate();
  const [branchId, setBranchId] = useState(s?.user.branchId ?? '');
  const { data, error, loading, reload } = useLoad(() => api.get(`/reports/dashboard${qs({ branchId })}`), [branchId]);
  const phase = loadPhase({ data, error, loading });

  return (
    <div>
      <PageHeader sub={data ? `היום, ${dateOnly(data.day)}` : 'היום'} actions={<>
        <BranchSelect value={branchId} onChange={setBranchId} />
        <button type="button" className="icon-btn" aria-label="רענון" onClick={reload}><Icon name="refresh" /></button>
      </>} />
      {phase === 'loading' && <Skeleton variant="counters" rows={6} />}
      {phase === 'error' && <LoadError error={error} what="לוח הבקרה" onRetry={reload} />}
      {data && <DashboardBody d={data} onLow={() => nav('/inventory?low=1')} onExceptions={() => nav('/reports?tab=exceptions')} />}
    </div>
  );
}

function DashboardBody({ d, onLow, onExceptions }: { d: any; onLow: () => void; onExceptions: () => void }) {
  const hours = d.by_hour as { hour: number; count: number; total: number }[];
  const max = Math.max(1, ...hours.map((h) => Number(h.total)));
  return (
    <>
      <StatGrid>
        <StatCard label="מכירות היום" icon="coins" value={money(d.sales.total)} sub={`כולל מע"מ · ${d.sales.count} עסקאות`} tone="teal" />
        <StatCard label="עסקאות" icon="receipt" value={d.sales.count} />
        <StatCard label="סל ממוצע" icon="cart" value={money(d.avg_basket_agorot)} />
        <StatCard label="נטו אחרי החזרות" icon="wallet" value={money(d.total_after_returns_agorot)} sub={`לפני מע"מ ${money(d.net_sales_agorot)}`} />
        <StatCard label="החזרות" icon="undo" value={money(d.returns.total)} sub={`${d.returns.count} החזרות`} tone={d.returns.count ? 'warn' : undefined} />
        {d.gross_profit_agorot != null && <StatCard label="רווח גולמי" icon="percent" value={money(d.gross_profit_agorot)} sub="לפי עלות ממוצעת" tone="ok" />}
        <StatCard label="מלאי נמוך" icon="box" value={d.low_stock} tone={d.low_stock ? 'warn' : 'ok'} onClick={onLow} sub="לרשימה" />
        <StatCard label="חריגים לטיפול" icon="alert" value={d.exceptions} tone={d.exceptions ? 'danger' : 'ok'} onClick={onExceptions} sub="תשלומים / מסמכים" />
      </StatGrid>

      <div className="dash-grid">
        <Card title="מכירות לפי שעה" icon="clock" className="hour-chart">
          {hours.length === 0 ? <EmptyState compact icon="clock" title="עוד אין מכירות היום" /> : (
            <div className="bars" role="img" aria-label="מכירות לפי שעה">
              {hours.map((h) => (
                <div key={h.hour} className="bar" style={{ height: `${Math.max(2, (Number(h.total) / max) * 100)}%` }} title={`${h.hour}:00 · ${money(Number(h.total))} · ${h.count} עסקאות`}>
                  <span>{h.hour}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="תקבולים לפי אמצעי" icon="card">
          {d.by_method.length === 0 ? <EmptyState compact icon="coins" title="אין תקבולים היום" /> : (
            <ul className="list-plain">
              {d.by_method.map((m: any) => <li key={m.method}><span>{PAY_LABEL[m.method] ?? m.method}</span><Money a={Number(m.amount)} /></li>)}
            </ul>
          )}
        </Card>

        <Card title="מוצרים מובילים" icon="tag">
          {d.top_products.length === 0 ? <EmptyState compact icon="tag" title="עוד לא נמכרו מוצרים היום" /> : (
            <ul className="list-plain">
              {d.top_products.map((p: any) => <li key={p.product_id ?? p.name}><span>{p.name} <small className="muted">× {qty(Number(p.qty_milli))}</small></span><span className="money">{moneyShort(Number(p.total))}</span></li>)}
            </ul>
          )}
        </Card>

        <Card title="משמרות פתוחות" icon="wallet">
          {d.open_sessions.length === 0 ? <EmptyState compact icon="check" title="אין משמרות פתוחות" /> : (
            <ul className="list-plain">
              {d.open_sessions.map((o: any) => <li key={o.id}><span>{o.register_name} · {o.opened_by_name}</span><span className="muted">מ-{timeOnly(o.opened_at)} · Z {o.number}</span></li>)}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
