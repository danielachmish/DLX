// פיילוט ומסמכים: מצב המסמכים של העסק (פיילוט / רשמי) וסביבת תרגול לקופאים.
// מעבר למסמכים רשמיים רק אחרי רישום התוכנה ברשות המסים ואישור רו"ח — השרת אוכף, כאן רק מסבירים.
import { useState } from 'react';
import Icon from '../../components/Icon';
import { Badge, Card, Field, LoadError, Skeleton } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { askConfirm } from '../../lib/dialogs';
import { getSession, setSession, useSession } from '../../lib/session';
import { showError, showToast } from '../../lib/toast';
import { useLoad } from '../../lib/useLoad';

const LIVE_CONFIRM = 'אני מאשר שהתוכנה רשומה ושרו"ח אישר את המסמכים';

export default function PilotSettings() {
  const session = useSession();
  const { data, error, loading, reload } = useLoad<any>(() => api.get('/settings/documents-mode'), []);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data && loading) return <Skeleton variant="card" />;
  if (!data) return <LoadError error={error} what="מצב המסמכים" onRetry={reload} />;
  const mode = data.documents_mode as 'shadow' | 'live' | 'training';
  const isOwner = session?.user.role === 'owner';

  const refreshSession = async () => {
    const me = await api.get('/me');
    setSession({ ...getSession()!, ...me, slug: me.tenant.slug });
  };
  const setMode = async (m: 'shadow' | 'live') => {
    if (m === 'live' && !(await askConfirm({ title: 'לעבור למסמכים רשמיים?', text: 'מעכשיו כל מסמך שהקופה מפיקה הוא מסמך רשמי לרשות המסים. אי אפשר למחוק מסמכים. צריך להפסיק להפיק מסמכים במערכת הקודמת באותו רגע.', confirmLabel: 'מעבר לרשמי', danger: true }))) return;
    setBusy(true);
    try {
      await api.put('/settings/documents-mode', { mode: m, confirm: confirm.trim() });
      showToast(m === 'live' ? 'המסמכים רשמיים מעכשיו' : 'חזרה למצב פיילוט');
      setConfirm('');
      await refreshSession();
      reload();
    } catch (e) { showError(e); } finally { setBusy(false); }
  };
  const createTraining = async () => {
    setBusy(true);
    try {
      const r = await api.post('/settings/training');
      showToast(`סביבת התרגול מוכנה: קוד עסק ${r.slug}`);
      reload();
    } catch (e) { showError(e instanceof ApiError ? e : new Error('לא הצלחנו ליצור סביבת תרגול')); } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <Card title="מצב המסמכים" icon="file">
        {mode === 'training' && <div className="notice danger"><Icon name="lamp" size={18} />זו סביבת תרגול. שום מכירה, מסמך או תשלום כאן לא אמיתיים.</div>}
        {mode === 'shadow' && (
          <div className="notice"><Icon name="flag" size={18} />
            <span><b>פיילוט.</b> הקופה, המלאי והדוחות עובדים מלא, אבל כל מסמך מודפס עם הכיתוב "פיילוט — לא מסמך רשמי". המסמך הרשמי ללקוח יוצא מהמערכת הקיימת של העסק. אין פנייה לרשות המסים למספרי הקצאה.</span>
          </div>
        )}
        {mode === 'live' && <div className="notice info"><Icon name="check2" size={18} />מסמכים רשמיים. כל מסמך נכנס לספרים ולמבנה האחיד.</div>}
        <dl className="kv mt">
          <dt>רישום התוכנה ברשות המסים</dt><dd>{data.softwareRegistered ? <Badge tone="ok">רשומה</Badge> : <Badge tone="warn">עוד לא</Badge>}</dd>
          <dt>חיבור לחשבוניות ישראל</dt><dd>{data.allocationConnected ? <Badge tone="ok">מחובר</Badge> : <Badge tone="warn">לא מחובר</Badge>}</dd>
          {data.documents_mode_changed_at && <><dt>שינוי אחרון</dt><dd>{new Date(data.documents_mode_changed_at).toLocaleString('he-IL')}</dd></>}
        </dl>
        {mode === 'shadow' && isOwner && (
          <div className="mt">
            {!data.softwareRegistered
              ? <p className="muted small">המעבר למסמכים רשמיים ייפתח אחרי שהתוכנה תירשם ברשות המסים.</p>
              : <>
                <Field label="כדי לעבור למסמכים רשמיים, הקלידו בדיוק:" hint={LIVE_CONFIRM}>
                  <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </Field>
                <button type="button" className="action-btn danger-soft inline mt" disabled={busy || confirm.trim() !== LIVE_CONFIRM} onClick={() => setMode('live')}>מעבר למסמכים רשמיים</button>
              </>}
          </div>
        )}
        {mode === 'live' && isOwner && <button type="button" className="action-btn ghost inline mt" disabled={busy} onClick={() => setMode('shadow')}>חזרה למצב פיילוט</button>}
      </Card>

      {mode !== 'training' && (
        <Card title="סביבת תרגול לקופאים" icon="lamp">
          <p className="section-sub">עסק נפרד עם אותם מוצרים, קופות ועובדים (אותו PIN). מכירות, החזרות וסגירות משמרת לתרגול — בלי להשפיע על העסק האמיתי. כל מסמך שם מסומן "תרגול".</p>
          {data.trainingSlug
            ? <div className="notice info"><Icon name="key" size={18} /><span>להתחברות לתרגול: קוד עסק <b dir="ltr">{data.trainingSlug}</b> ואותו PIN של העובד.</span></div>
            : <button type="button" className="action-btn secondary inline" disabled={busy} onClick={createTraining}><Icon name="plus" size={18} />יצירת סביבת תרגול</button>}
        </Card>
      )}
    </div>
  );
}
