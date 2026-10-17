// הודעות צפות. פעולה הפיכה — עושים מיד ומציעים "ביטול" בהודעה, במקום לשאול "בטוח?"
export interface Toast { id: number; text: string; action?: { label: string; onClick: () => void }; tone?: 'ok' | 'error' }
let listeners: ((t: Toast) => void)[] = [];
let id = 0;
export function onToast(cb: (t: Toast) => void) { listeners.push(cb); return () => { listeners = listeners.filter((l) => l !== cb); }; }
export function showToast(text: string, action?: Toast['action'], tone?: Toast['tone']) { const t = { id: ++id, text, action, tone }; listeners.forEach((l) => l(t)); }
export const showError = (e: unknown) => showToast(e instanceof Error ? e.message : String(e), undefined, 'error');
