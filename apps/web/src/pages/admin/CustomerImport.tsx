// ייבוא לקוחות מהמערכת הקודמת (INT-07): בדיקה קודם (dryRun), אחר כך ייבוא. balance = יתרת חוב פתיחה
import { useState } from 'react';
import Icon from '../../components/Icon';
import { Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { showError, showToast } from '../../lib/toast';
import { parseCsv } from '../office/csv';

const SAMPLE = 'name,kind,taxId,phone,email,address,creditLimit,balance\nמשרד כהן,business,512345679,03-5550000,office@cohen.co.il,"הרצל 5, תל אביב",5000,1250.00\nרינה לוי,private,,052-4445566,,,0,0';

export default function CustomerImport({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [report, setReport] = useState<any>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const rows = text.trim() ? parseCsv(text) : [];
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await api.post('/customers/import', { rows, dryRun });
      setReport(r);
      if (dryRun) setChecked(true);
      else { showToast(`נוספו ${r.created} לקוחות${r.failed ? `, ${r.failed} שורות נכשלו` : ''}`); if (!r.failed) onDone(); }
    } catch (e) { showError(e); } finally { setBusy(false); }
  };
  const reset = (t: string) => { setText(t); setChecked(false); setReport(null); };
  return (
    <Modal title="ייבוא לקוחות מקובץ" size="wide" onClose={onClose} footer={<>
      {!checked && <button type="button" className="action-btn" disabled={!rows.length || busy} onClick={() => run(true)}>בדיקת הקובץ ({rows.length} שורות)</button>}
      {checked && <button type="button" className="action-btn" disabled={busy || !report?.report?.some((r: any) => r.ok)} onClick={() => run(false)}>ייבוא השורות התקינות</button>}
      <button type="button" className="action-btn ghost" onClick={onClose}>סגירה</button>
    </>}>
      <p className="section-sub">עמודות: name, kind (private / business), taxId, phone, email, address, creditLimit, balance. balance — יתרת החוב של הלקוח בשקלים ביום המעבר (נרשמת כתנועת פתיחה). כדאי להשוות את סך היתרות לדוח של המערכת הקודמת.</p>
      <div className="row-gap mb">
        <label className="action-btn secondary inline"><Icon name="upload" size={18} />בחירת קובץ CSV<input type="file" accept=".csv,text/csv,text/plain" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) reset(await f.text()); }} /></label>
        <button type="button" className="action-btn ghost inline" onClick={() => reset(SAMPLE)}>דוגמה</button>
      </div>
      <textarea className="csv-text" value={text} onChange={(e) => reset(e.target.value)} placeholder="או הדביקו כאן את תוכן הקובץ" aria-label="תוכן CSV" />
      {report && (
        <div className="mt">
          <p><b>{report.report.filter((r: any) => r.ok).length}</b> תקינות · <b>{report.failed}</b> עם שגיאה</p>
          {report.report.filter((r: any) => !r.ok).map((r: any) => <div key={r.row} className="notice danger mt">שורה {r.row} ({r.name || 'בלי שם'}): {r.error}</div>)}
        </div>
      )}
    </Modal>
  );
}
