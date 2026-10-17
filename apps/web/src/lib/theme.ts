// מצב לילה וגודל טקסט — בחירה אישית במכשיר. ברירת מחדל: בהיר (כדי שמסך הקופה לא ישתנה פתאום).
const KEY = 'dlx_theme';
const TEXT_KEY = 'dlx_text';
export type Theme = 'light' | 'dark' | 'system';
export function getTheme(): Theme { try { const t = localStorage.getItem(KEY); return t === 'dark' || t === 'system' ? t : 'light'; } catch { return 'light'; } }
const systemDark = () => { try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; } };
export function applyTheme(theme: Theme = getTheme()) {
  const shown = theme === 'system' ? (systemDark() ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = shown;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', shown === 'dark' ? '#0f1719' : '#f6f8f9');
  try { const tx = localStorage.getItem(TEXT_KEY); if (tx) document.documentElement.dataset.text = tx; else delete document.documentElement.dataset.text; } catch { /* */ }
}
export function setTheme(t: Theme) { try { localStorage.setItem(KEY, t); } catch { /* */ } applyTheme(t); }
export function setTextSize(s: 'normal' | 'large' | 'xlarge') {
  try { if (s === 'normal') localStorage.removeItem(TEXT_KEY); else localStorage.setItem(TEXT_KEY, s); } catch { /* */ }
  applyTheme();
}
export function getTextSize() { try { return (localStorage.getItem(TEXT_KEY) as 'large' | 'xlarge') ?? 'normal'; } catch { return 'normal'; } }
