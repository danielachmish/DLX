// טבלת נתונים (D-02): טבלה עם מיון בטאבלט ובמחשב, כרטיסים בטלפון. אותו מקור עמודות לשתי התצוגות.
import { type ReactNode, useMemo, useState } from 'react';
import { cls } from '../lib/misc';

export interface Column<T> {
  key: string; label: string; render?: (row: T) => ReactNode; value?: (row: T) => string | number | null | undefined;
  num?: boolean; muted?: boolean; hideOnCard?: boolean; primary?: boolean; width?: string;
}

export default function DataTable<T>({ rows, columns, onRowClick, rowKey, footer, empty, responsive = true, initialSort }: {
  rows: T[]; columns: Column<T>[]; onRowClick?: (r: T) => void; rowKey: (r: T) => string; footer?: ReactNode; empty?: ReactNode;
  responsive?: boolean; initialSort?: { key: string; dir: 1 | -1 };
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.value) return rows;
    return [...rows].sort((a, b) => {
      const x = col.value!(a); const y = col.value!(b);
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'he')) * sort.dir;
    });
  }, [rows, sort, columns]);
  const cell = (c: Column<T>, r: T) => (c.render ? c.render(r) : String(c.value?.(r) ?? (r as any)[c.key] ?? '—'));
  if (rows.length === 0 && empty) return <>{empty}</>;
  const primary = columns.find((c) => c.primary) ?? columns[0]!;
  return (
    <div className={cls('dt-wrap', responsive && 'responsive')}>
      <div className="dt-scroll">
        <table className="dt">
          <thead><tr>{columns.map((c) => (
            <th key={c.key} className={cls(c.num && 'num', c.value && 'sortable')} style={c.width ? { width: c.width } : undefined}
              onClick={c.value ? () => setSort((s) => (s?.key === c.key ? { key: c.key, dir: (s.dir * -1) as 1 | -1 } : { key: c.key, dir: 1 })) : undefined}
              aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
              {c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
            </th>))}</tr></thead>
          <tbody>{sorted.map((r) => (
            <tr key={rowKey(r)} className={onRowClick ? 'clickable' : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}
              tabIndex={onRowClick ? 0 : undefined} onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined}>
              {columns.map((c) => <td key={c.key} className={cls(c.num && 'num', c.muted && 'muted')}>{cell(c, r)}</td>)}
            </tr>))}</tbody>
          {footer && <tfoot>{footer}</tfoot>}
        </table>
      </div>
      {responsive && (
        <div className="dt-cards">
          {sorted.map((r) => {
            const Tag = onRowClick ? 'button' : 'div';
            return (
              <Tag key={rowKey(r)} className="dt-card" onClick={onRowClick ? () => onRowClick(r) : undefined} type={onRowClick ? 'button' : undefined}>
                <div className="dt-card-top"><b>{cell(primary, r)}</b>{columns.filter((c) => c.num && !c.hideOnCard).slice(-1).map((c) => <span key={c.key} className="money">{cell(c, r)}</span>)}</div>
                {columns.filter((c) => c !== primary && !c.hideOnCard && !(c.num && c === columns.filter((x) => x.num && !x.hideOnCard).slice(-1)[0])).map((c) => (
                  <div key={c.key} className="dt-card-row"><span>{c.label}</span><span>{cell(c, r)}</span></div>
                ))}
              </Tag>
            );
          })}
        </div>
      )}
    </div>
  );
}
