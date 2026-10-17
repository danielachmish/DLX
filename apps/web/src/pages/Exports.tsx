// ייצוא (ACC-06, OPEN-01, G-01): לרו"ח, מבנה אחיד (טיוטה) וייצוא מלא של נתוני העסק
import { Fragment, useState } from 'react';
import Icon from '../components/Icon';
import { Card, PageHeader } from '../components/ui';
import { api, download, qs } from '../lib/api';
import { can } from '../lib/session';
import { showToast } from '../lib/toast';
import { RangeFields, saveBase64, toastError, useRange } from './admin/common';
import '../styles/admin.css';

export default function Exports() {
  const [range, setRange] = useRange();
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<any>(null);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } catch (e) { toastError(e); } finally { setBusy(''); }
  };
  const accountant = () => run('csv', async () => {
    await download('/exports/accountant.csv' + qs(range), `dlx-documents-${range.from}-${range.to}.csv`);
    showToast('הקובץ ירד');
  });
  const openFormat = () => run('open', async () => { setOpen(await api.post('/exports/open-format', range)); });
  const full = () => run('full', async () => { await download('/exports/full', `dlx-full-export-${range.to}.json`); showToast('הייצוא המלא ירד'); });

  return (
    <div className="stack">
      <PageHeader sub="קבצים לרואה החשבון ולרשות המסים" />
      <div className="range-bar"><RangeFields range={range} onChange={(r) => { setRange(r); setOpen(null); }} /></div>

      <Card title="יומן מסמכים לרו״ח (CSV)" icon="file" className="export-card">
        <p className="muted small">כל המסמכים בתקופה, שורה לכל מסמך: סוג, מספר, תאריך, לקוח, לפני מע"מ, מע"מ, סה"כ, אמצעי תשלום ומספר הקצאה. נפתח באקסל.</p>
        <button className="action-btn inline" onClick={accountant} disabled={!!busy}><Icon name="download" size={18} />{busy === 'csv' ? 'מכין…' : 'הורדת CSV'}</button>
      </Card>

      <Card title="קובץ במבנה אחיד (נספח ה')" icon="layers" className="export-card">
        <div className="notice danger"><Icon name="alert" size={18} /><div><b>טיוטה — לא להגשה.</b> רוחבי השדות לא אומתו מול מפרט 1.31 ולא נבדקו בסימולטור של רשות המסים. הגשה מותרת רק אחרי אימות ורישום התוכנה.</div></div>
        <button className="action-btn inline secondary mt" onClick={openFormat} disabled={!!busy}><Icon name="layers" size={18} />{busy === 'open' ? 'מכין…' : 'הפקת טיוטה'}</button>
        {open && (
          <div className="stack mt">
            {open.warning && <p className="muted small flush">{open.warning}</p>}
            <dl className="kv">
              <dt>תיקייה</dt><dd dir="ltr">{open.path}</dd>
              <dt>סה"כ רשומות</dt><dd>{open.totalRecords}</dd>
              {Object.entries(open.counts as Record<string, number>).map(([k, n]) => <Fragment key={k}><dt dir="ltr">{k}</dt><dd>{n}</dd></Fragment>)}
            </dl>
            <div className="row-gap">
              <button className="action-btn inline small" onClick={() => saveBase64(open.iniBase64, 'INI.TXT')}><Icon name="download" size={16} />INI.TXT</button>
              <button className="action-btn inline small" onClick={() => saveBase64(open.bkmvdataBase64, 'BKMVDATA.TXT')}><Icon name="download" size={16} />BKMVDATA.TXT</button>
            </div>
          </div>
        )}
      </Card>

      {can('settings:write') && (
        <Card title="ייצוא מלא של נתוני העסק" icon="shield" className="export-card">
          <p className="muted small">כל הנתונים — מסמכים, מכירות, מלאי, לקוחות ויומן הביקורת — בקובץ JSON אחד, בלי סיסמאות. חובת השמירה של מסמכים היא 7 שנים מסוף שנת המס, גם אחרי שמפסיקים להשתמש ב-DLX. מומלץ לשמור עותק בסוף כל שנה.</p>
          <button className="action-btn inline secondary" onClick={full} disabled={!!busy}><Icon name="download" size={18} />{busy === 'full' ? 'מכין…' : 'הורדת ייצוא מלא'}</button>
        </Card>
      )}
    </div>
  );
}
