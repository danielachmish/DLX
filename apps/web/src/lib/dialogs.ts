// חלונות שאלה בשפה של המערכת (מערכת העיצוב) — במקום confirm / prompt / alert של הדפדפן.
// גיליון תחתון בטלפון, חלון באמצע במחשב. Esc / לחיצה על הרקע = ביטול. הציור — components/DialogHost.tsx
export interface DialogOption { value: string; label: string; danger?: boolean; primary?: boolean }
export interface DialogState {
  id: number; kind: 'confirm' | 'text' | 'choice'; title: string; text?: string; confirmLabel: string; cancelLabel: string; danger?: boolean; icon?: string;
  label?: string; placeholder?: string; initial?: string; required?: boolean; multiline?: boolean; inputMode?: 'numeric' | 'decimal' | 'text' | 'tel';
  type?: string; validate?: (v: string) => string; options?: DialogOption[]; resolve: (v: any) => void;
}

let queue: DialogState[] = [];
let listeners: ((d: DialogState | null) => void)[] = [];
let seq = 0;
const notify = () => listeners.forEach((l) => l(queue[0] ?? null));

export function onDialog(cb: (d: DialogState | null) => void) {
  listeners.push(cb);
  cb(queue[0] ?? null);
  return () => { listeners = listeners.filter((l) => l !== cb); };
}

function open<T>(kind: DialogState['kind'], opts: Partial<DialogState>): Promise<T> {
  return new Promise((resolve) => {
    queue.push({ id: ++seq, kind, title: '', confirmLabel: 'אישור', cancelLabel: 'ביטול', ...opts, resolve } as DialogState);
    if (queue.length === 1) notify();
  });
}

export function answerDialog(id: number, value: unknown) {
  const d = queue[0];
  if (!d || d.id !== id) return;
  queue = queue.slice(1);
  d.resolve(value);
  notify();
}
export function cancelDialog(id: number) {
  const d = queue[0];
  if (!d || d.id !== id) return;
  answerDialog(id, d.kind === 'confirm' ? false : null);
}

export const askConfirm = (o: { title: string; text?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; icon?: string }) =>
  open<boolean>('confirm', o);
export const askText = (o: { title: string; text?: string; label?: string; placeholder?: string; initial?: string; confirmLabel?: string; required?: boolean; multiline?: boolean; inputMode?: DialogState['inputMode']; type?: string; validate?: (v: string) => string; danger?: boolean; icon?: string }) =>
  open<string | null>('text', { required: true, ...o });
export const askChoice = (o: { title: string; text?: string; options: DialogOption[]; icon?: string }) => open<string | null>('choice', o);
