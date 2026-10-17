// המכשיר הזה: לאיזו קופה הוא משויך, מצב לילה, גודל טקסט, והתקנה למסך הבית (חשוב באייפד / אייפון)
import { useState } from 'react';
import Icon from '../../components/Icon';
import { Card, Field, Tabs } from '../../components/ui';
import { currentRegister, setRegisterId, useSession } from '../../lib/session';
import { getTextSize, getTheme, setTextSize, setTheme, type Theme } from '../../lib/theme';
import { showToast } from '../../lib/toast';

export default function DeviceSettings() {
  const s = useSession();
  const [theme, setT] = useState<Theme>(getTheme());
  const [size, setS] = useState(getTextSize());
  const reg = currentRegister(s);
  const regs = (s?.registers ?? []).filter((r) => !s?.user.branchId || r.branch_id === s.user.branchId);
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone);
  return (
    <div className="stack">
      <Card title="קופה במכשיר" icon="cart">
        <Field label="המכשיר הזה הוא" hint="כל מכירה ומשמרת נרשמות לקופה הזו">
          <select value={reg?.id ?? ''} onChange={(e) => { setRegisterId(e.target.value); showToast('הקופה עודכנה'); }}>
            {regs.map((r) => <option key={r.id} value={r.id}>{r.name} · {s?.branches.find((b) => b.id === r.branch_id)?.name}</option>)}
          </select>
        </Field>
      </Card>
      <Card title="תצוגה" icon="sun">
        <div className="stack">
          <Field label="מצב">
            <Tabs variant="seg" value={theme} onChange={(k) => { setT(k as Theme); setTheme(k as Theme); }} items={[{ key: 'light', label: 'בהיר' }, { key: 'dark', label: 'לילה' }, { key: 'system', label: 'לפי המכשיר' }]} />
          </Field>
          <Field label="גודל טקסט">
            <Tabs variant="seg" value={size} onChange={(k) => { setS(k as any); setTextSize(k as any); }} items={[{ key: 'normal', label: 'רגיל' }, { key: 'large', label: 'גדול' }, { key: 'xlarge', label: 'גדול מאוד' }]} />
          </Field>
        </div>
      </Card>
      <Card title="התקנה כאפליקציה" icon="single">
        {standalone ? <p className="flush"><Icon name="check" size={16} /> DLX מותקנת במכשיר הזה.</p> : (
          <div className="stack">
            <p className="flush">באייפד ובאייפון: בספארי לוחצים על <b>שיתוף</b> ← <b>הוספה למסך הבית</b>. באנדרואיד ובמחשב: בתפריט הדפדפן ← <b>התקנת אפליקציה</b>.</p>
            <div className="notice"><Icon name="alert" size={18} />ספארי מוחק נתונים שנשמרו במכשיר (כמו עגלה שלא נשלחה) של אתר שלא נפתח 7 ימים — אלא אם האתר מותקן למסך הבית. בקופה — חובה להתקין.</div>
          </div>
        )}
      </Card>
    </div>
  );
}
