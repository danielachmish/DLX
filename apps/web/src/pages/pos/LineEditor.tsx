// עריכת שורה בעגלה: כמות (שקיל — בק"ג עם 3 ספרות), הנחה באחוזים, הסרה
import { parseQty } from '@dlx/core';
import { useState } from 'react';
import Icon from '../../components/Icon';
import NumPad from '../../components/NumPad';
import { Modal, Tabs } from '../../components/ui';
import { money, qty } from '../../lib/format';
import type { PosLine } from './cart';

export default function LineEditor({ line, onSave, onRemove, onClose }: {
  line: PosLine; onSave: (l: PosLine) => void; onRemove: () => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<'qty' | 'discount'>('qty');
  const [q, setQ] = useState(qty(line.qtyMilli));
  const [d, setD] = useState(line.discountBp ? String(line.discountBp / 100) : '');
  const weight = line.soldByWeight;
  const save = () => {
    const qm = parseQty(q || '0');
    if (!qm || qm <= 0) return;
    const pct = Number(d || '0');
    if (!(pct >= 0 && pct <= 100)) return;
    onSave({ ...line, qtyMilli: weight ? qm : Math.max(1000, Math.round(qm / 1000) * 1000), discountBp: Math.round(pct * 100) || undefined });
  };
  return (
    <Modal title={line.name} onClose={onClose}>
      <p className="section-sub">{money(line.unitPrice)} {weight ? 'לק"ג' : 'ליחידה'}{line.fixedPrice ? ' · מחיר ממאזניים' : ''}</p>
      <Tabs variant="seg" value={tab} onChange={(k) => setTab(k as any)} items={[{ key: 'qty', label: weight ? 'משקל (ק"ג)' : 'כמות' }, { key: 'discount', label: 'הנחה %' }]} />
      {tab === 'qty'
        ? (line.fixedPrice
          ? <p className="notice info">שורה ממדבקת מאזניים — הכמות והמחיר קבועים. אפשר רק להסיר.</p>
          : <NumPad value={q} onChange={setQ} decimals={weight ? 3 : 0} onEnter={save} enterLabel="שמירה" />)
        : <NumPad value={d} onChange={setD} decimals={2} onEnter={save} enterLabel="שמירה" />}
      <button type="button" className="action-btn danger-soft inline mt" onClick={onRemove}><Icon name="trash" size={18} />הסרה מהעגלה</button>
    </Modal>
  );
}
