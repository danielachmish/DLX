// כניסה: בעלים / מנהל באימייל וסיסמה, קופאי ב-PIN מהיר (IAM-02). קוד העסק נשמר במכשיר.
import { type FormEvent, useState } from 'react';
import Icon from '../components/Icon';
import NumPad from '../components/NumPad';
import { Field, Tabs } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { setSession } from '../lib/session';

const SLUG_KEY = 'dlx_slug';
const savedSlug = () => { try { return localStorage.getItem(SLUG_KEY) ?? ''; } catch { return ''; } };

export default function Login() {
  const [mode, setMode] = useState<'pin' | 'password' | 'signup'>(savedSlug() ? 'pin' : 'password');
  const [slug, setSlug] = useState(savedSlug());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const finish = (r: any) => {
    try { localStorage.setItem(SLUG_KEY, r.tenant.slug); } catch { /* */ }
    setSession({ ...r, slug: r.tenant.slug });
  };
  const run = async (fn: () => Promise<any>) => {
    setErr(''); setBusy(true);
    try { finish(await fn()); } catch (e) { setErr(e instanceof ApiError ? e.message : 'משהו השתבש'); setPin(''); } finally { setBusy(false); }
  };
  const submitPassword = (e: FormEvent) => { e.preventDefault(); run(() => api.post('/auth/login', { slug: slug.trim(), email: email.trim(), password })); };
  const submitPin = () => { if (pin.length >= 4) run(() => api.post('/auth/pin', { slug: slug.trim(), pin })); };

  return (
    <div className="login-page">
      <div className="card login-card">
        <div className="login-logo">DLX</div>
        <p className="login-sub">קופה, מלאי ומסמכים לחנות</p>
        <Tabs variant="seg" label="אופן כניסה" value={mode} onChange={(k) => { setMode(k as any); setErr(''); }}
          items={[{ key: 'pin', label: 'קופאי (PIN)' }, { key: 'password', label: 'מנהל / בעלים' }, { key: 'signup', label: 'עסק חדש' }]} />
        {mode !== 'signup' && (
          <Field label="קוד העסק"><input value={slug} onChange={(e) => setSlug(e.target.value)} autoCapitalize="none" autoCorrect="off" placeholder="למשל demo" dir="ltr" /></Field>
        )}
        {mode === 'password' && (
          <form onSubmit={submitPassword} className="stack mt">
            <Field label="אימייל"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" dir="ltr" /></Field>
            <Field label="סיסמה"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" dir="ltr" /></Field>
            {err && <div className="dlg-err" role="alert">{err}</div>}
            <button className="action-btn" disabled={busy || !slug || !email || !password}>{busy ? 'מתחבר…' : 'כניסה'}</button>
          </form>
        )}
        {mode === 'pin' && (
          <div className="mt">
            <div className="pin-dots" aria-label={`${pin.length} ספרות`}>{Array.from({ length: Math.max(4, pin.length) }, (_, i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}</div>
            {err && <div className="dlg-err" role="alert">{err}</div>}
            <NumPad value={pin.replace(/./g, '•')} decimals={0} onChange={(v) => {
              if (v.length < pin.length) setPin(pin.slice(0, v.length));
              else if (pin.length < 8) setPin(pin + v.slice(-1));
            }} onEnter={submitPin} enterLabel={busy ? 'מתחבר…' : 'כניסה'} />
          </div>
        )}
        {mode === 'signup' && <Signup onDone={finish} />}
        <p className="muted small mt"><Icon name="lock" size={14} /> הנתונים של כל עסק מופרדים לגמרי. אחרי 12 שעות צריך להתחבר מחדש.</p>
      </div>
    </div>
  );
}

function Signup({ onDone }: { onDone: (r: any) => void }) {
  const [f, setF] = useState({ slug: '', legalName: '', tradeName: '', taxId: '', taxStatus: 'murshe', address: '', phone: '', branchName: 'סניף ראשי', ownerName: '', email: '', password: '' });
  const [err, setErr] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setMsg(''); setErr({});
    try {
      onDone(await api.post('/auth/signup', {
        business: { slug: f.slug, legalName: f.legalName, tradeName: f.tradeName || null, taxId: f.taxId, taxStatus: f.taxStatus, address: f.address || null, phone: f.phone || null },
        branch: { name: f.branchName }, owner: { name: f.ownerName, email: f.email, password: f.password },
      }));
    } catch (x) { if (x instanceof ApiError) { setMsg(x.message); setErr(x.fieldErrors ?? {}); } }
  };
  return (
    <form onSubmit={submit} className="stack mt">
      <Field label="קוד עסק (לכניסה)" hint="אותיות באנגלית, ספרות ומקף" error={err['business.slug']}><input value={f.slug} onChange={set('slug')} dir="ltr" required /></Field>
      <Field label="שם העסק הרשמי" error={err['business.legalName']}><input value={f.legalName} onChange={set('legalName')} required /></Field>
      <Field label="שם מסחרי (לקבלה)"><input value={f.tradeName} onChange={set('tradeName')} /></Field>
      <div className="form-grid">
        <Field label="ע.מ. / ח.פ." error={err['business.taxId']}><input value={f.taxId} onChange={set('taxId')} inputMode="numeric" required /></Field>
        <Field label="סוג עוסק">
          <select value={f.taxStatus} onChange={set('taxStatus')}><option value="murshe">עוסק מורשה</option><option value="company">חברה</option><option value="patur">עוסק פטור</option></select>
        </Field>
      </div>
      <Field label="כתובת"><input value={f.address} onChange={set('address')} /></Field>
      <Field label="שם הבעלים" error={err['owner.name']}><input value={f.ownerName} onChange={set('ownerName')} required /></Field>
      <Field label="אימייל" error={err['owner.email']}><input type="email" value={f.email} onChange={set('email')} dir="ltr" required /></Field>
      <Field label="סיסמה" hint="לפחות 8 תווים" error={err['owner.password']}><input type="password" value={f.password} onChange={set('password')} dir="ltr" required /></Field>
      <div className="notice info"><Icon name="alert" size={18} />סוג העוסק קובע אילו מסמכים מותרים (עוסק פטור — קבלות בלבד). כדאי לאמת מול רו"ח לפני שמתחילים למכור.</div>
      {msg && <div className="dlg-err" role="alert">{msg}</div>}
      <button className="action-btn">פתיחת עסק</button>
    </form>
  );
}
