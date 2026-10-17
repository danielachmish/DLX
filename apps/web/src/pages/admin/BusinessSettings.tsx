// פרטי העסק (TEN-01, TEN-03, TEN-04): נשמרים כתמונת מצב בכל מסמך חדש. מסמכים קיימים לא משתנים.
import { isValidIsraeliId, STATUS_LABEL } from '@dlx/core';
import { type FormEvent, useEffect, useState } from 'react';
import Icon from '../../components/Icon';
import { Card, Field, LoadError, Skeleton, Switch } from '../../components/ui';
import { api } from '../../lib/api';
import { getSession, setSession } from '../../lib/session';
import { showToast } from '../../lib/toast';
import { useLoad } from '../../lib/useLoad';
import { apiErrors } from './common';

export default function BusinessSettings() {
  const { data, error, loading, reload } = useLoad<any>(() => api.get('/settings/business'), []);
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setF({
      legalName: data.legal_name, tradeName: data.trade_name ?? '', taxId: data.tax_id, taxStatus: data.tax_status, taxStatusFrom: data.tax_status_from ?? '',
      address: data.address ?? '', phone: data.phone ?? '', email: data.email ?? '', allowNegativeStock: data.allow_negative_stock,
      returnDays: String(data.return_days), returnPolicy: data.return_policy ?? '', receiptFooter: data.receipt_footer ?? '',
    });
  }, [data]);
  if (!f && loading) return <Skeleton variant="card" />;
  if (!f) return <LoadError error={error} what="פרטי העסק" onRetry={reload} />;
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const statusChanged = f.taxStatus !== data.tax_status;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!isValidIsraeliId(f.taxId)) fe.taxId = 'מספר עוסק / ח"פ לא תקין';
    const days = Number(f.returnDays);
    if (!Number.isInteger(days) || days < 0 || days > 365) fe.returnDays = 'בין 0 ל-365';
    if (Object.keys(fe).length) { setErr(fe); return; }
    setBusy(true); setErr({}); setMsg('');
    try {
      await api.put('/settings/business', {
        legalName: f.legalName, tradeName: f.tradeName || null, taxId: f.taxId, taxStatus: f.taxStatus, taxStatusFrom: statusChanged && f.taxStatusFrom ? f.taxStatusFrom : undefined,
        address: f.address || null, phone: f.phone || null, email: f.email || null, allowNegativeStock: f.allowNegativeStock, returnDays: days,
        returnPolicy: f.returnPolicy || null, receiptFooter: f.receiptFooter || null,
      });
      const me = await api.get('/me');
      setSession({ ...getSession()!, ...me, slug: me.tenant.slug });
      showToast('פרטי העסק נשמרו');
      reload();
    } catch (x) { const r = apiErrors(x); setMsg(r.msg); setErr(r.fields); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="stack">
      <Card title="פרטי העסק" icon="building">
        <div className="form-grid">
          <Field label="שם רשמי" error={err.legalName}><input value={f.legalName} onChange={set('legalName')} required /></Field>
          <Field label="שם מסחרי (מופיע בקבלה)"><input value={f.tradeName} onChange={set('tradeName')} /></Field>
          <Field label="ע.מ. / ח.פ." error={err.taxId}><input value={f.taxId} onChange={set('taxId')} inputMode="numeric" dir="ltr" required /></Field>
          <Field label="סוג עוסק">
            <select value={f.taxStatus} onChange={set('taxStatus')}>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Field>
          {statusChanged && <Field label="סוג העוסק החדש בתוקף מתאריך" hint="היום או תאריך עתידי"><input type="date" value={f.taxStatusFrom} onChange={set('taxStatusFrom')} /></Field>}
          <Field label="כתובת"><input value={f.address} onChange={set('address')} /></Field>
          <Field label="טלפון"><input value={f.phone} onChange={set('phone')} inputMode="tel" dir="ltr" /></Field>
          <Field label="אימייל" error={err.email}><input type="email" value={f.email} onChange={set('email')} dir="ltr" /></Field>
        </div>
        {statusChanged && <div className="notice mt"><Icon name="alert" size={18} /><div>שינוי סוג העוסק משנה אילו מסמכים מותר להפיק (עוסק פטור — קבלות בלבד, בלי מע"מ). מסמכים שכבר הופקו לא משתנים. <b>לאשר מול רו"ח לפני השמירה.</b></div></div>}
      </Card>
      <Card title="מכירה והחזרות" icon="receipt">
        <div className="form-grid">
          <Field label="ימים להחזרה" hint="מעבר לזה — אישור מנהל" error={err.returnDays}><input value={f.returnDays} onChange={set('returnDays')} inputMode="numeric" dir="ltr" /></Field>
          <div className="field"><span>מכירה גם כשאין מלאי במערכת</span>
            <div className="check-row"><Switch label="מלאי שלילי" on={f.allowNegativeStock} onChange={(v) => setF({ ...f, allowNegativeStock: v })} />{f.allowNegativeStock ? 'מותר — המלאי יכול לרדת מתחת לאפס' : 'חסום (מומלץ)'}</div>
          </div>
          <Field label="מדיניות החזרה" hint="מודפסת על כל קבלה. לפי תקנות הגנת הצרכן צריך גם שלט בחנות." wide><textarea rows={3} value={f.returnPolicy} onChange={set('returnPolicy')} maxLength={600} /></Field>
          <Field label="שורה בתחתית הקבלה" wide><input value={f.receiptFooter} onChange={set('receiptFooter')} maxLength={400} /></Field>
        </div>
      </Card>
      {msg && <div className="dlg-err" role="alert">{msg}</div>}
      <div className="form-actions"><button className="action-btn" disabled={busy}>{busy ? 'שומר…' : 'שמירה'}</button></div>
    </form>
  );
}
