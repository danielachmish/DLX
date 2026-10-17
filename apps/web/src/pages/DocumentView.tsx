// מסמך (FIS-05, FIS-07, ACC-05): תצוגה כפי שהופק, הדפסה (מקור בפעם הראשונה, אחר כך העתק), קישור ללקוח,
// מסמכים מקושרים (זיכוי ↔ מקור), היסטוריית הדפסות, בדיקת שלמות (hash) ומספר הקצאה
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Icon from '../components/Icon';
import { Badge, Card, LoadError, PageHeader, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { DOC_TITLE, dateTime, money } from '../lib/format';
import { printHtml } from '../lib/misc';
import { can } from '../lib/session';
import { showError, showToast } from '../lib/toast';
import { useLoad } from '../lib/useLoad';
import '../styles/pos.css';

export default function DocumentView() {
  const { id } = useParams();
  const nav = useNavigate();
  const doc = useLoad(() => api.get(`/documents/${id}`), [id]);
  const [preview, setPreview] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPreview(null);
    api.post(`/documents/${id}/print`, { preview: true, format: 'a4' }).then((r) => setPreview(r.html)).catch(() => setPreview(''));
  }, [id]);

  const d = doc.data;
  const title = d ? `${d.title ?? DOC_TITLE[d.doc_type]} ${d.serial}` : 'מסמך';
  const header = <PageHeader title={title} sub={d ? dateTime(d.issued_at) : undefined} back />;
  if (!d && doc.loading) return <>{header}<Skeleton variant="card" /></>;
  if (!d) return <>{header}<LoadError error={doc.error} what="המסמך" onRetry={doc.reload} /></>;

  const print = async (format: '80mm' | 'a4') => {
    setBusy(true);
    try {
      const r = await api.post(`/documents/${id}/print`, { format });
      printHtml(r.html);
      showToast(`הודפס: ${r.mark}`);
      doc.reload();
    } catch (e) { showError(e); } finally { setBusy(false); }
  };
  const share = async () => {
    try { const r = await api.post(`/documents/${id}/link`); setLink(r.url); } catch (e) { showError(e); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(link!); showToast('הקישור הועתק'); } catch { showToast(link!); } };
  const isSale = d.source_type === 'sale' && d.source_id;
  const credit = ['credit_invoice', 'return_note'].includes(d.doc_type);

  return (
    <div className="split wide-main">
      {header}
      <div className="stack">
        {preview === null ? <Skeleton variant="card" /> : preview ? <iframe className="doc-frame" title={title} srcDoc={preview} /> : <LoadError error={null} what="תצוגת המסמך" />}
      </div>
      <div className="stack">
        <Card title="פעולות" icon="printer">
          <div className="row-gap">
            <button type="button" className="action-btn secondary inline" disabled={busy} onClick={() => print('80mm')}><Icon name="printer" size={18} />קבלה 80mm</button>
            <button type="button" className="action-btn secondary inline" disabled={busy} onClick={() => print('a4')}><Icon name="file" size={18} />A4</button>
            {can('document:send') && <button type="button" className="action-btn secondary inline" onClick={share}><Icon name="share" size={18} />קישור ללקוח</button>}
            {isSale && can('pos:refund') && <button type="button" className="action-btn secondary inline" onClick={() => nav(`/returns?sale=${d.source_id}`)}><Icon name="undo" size={18} />החזרה</button>}
          </div>
          <p className="muted small mt">{d.print_count === 0 ? 'ההדפסה הראשונה תסומן "מקור"; כל הדפסה אחריה — "העתק נאמן למקור".' : `הודפס ${d.print_count} פעמים — הדפסה נוספת תסומן "העתק".`}</p>
          {link && (
            <div className="notice info mt">
              <span className="pos-link-url" dir="ltr">{link}</span>
              <span className="row-gap">
                <button type="button" className="action-btn small inline" onClick={copy}>העתקה</button>
                <a className="action-btn small inline secondary" href={`https://wa.me/?text=${encodeURIComponent(`${title}: ${link}`)}`} target="_blank" rel="noreferrer">וואטסאפ</a>
              </span>
            </div>
          )}
        </Card>
        <Card title="פרטים" icon="receipt">
          <dl className="kv">
            <dt>סוג</dt><dd>{d.title} (קוד {d.doc_code})</dd>
            <dt>סכום</dt><dd className="money">{money(credit ? -d.total_agorot : d.total_agorot)}</dd>
            <dt>מע"מ</dt><dd className="money">{money(d.vat_agorot)}</dd>
            {d.customer && <><dt>לקוח</dt><dd>{d.customer.name}{d.customer.taxId ? ` · ${d.customer.taxId}` : ''}</dd></>}
            <dt>שלמות</dt><dd>{d.hash_ok ? <Badge tone="ok">תואם לחתימה</Badge> : <Badge tone="danger">לא תואם — לבדוק</Badge>}</dd>
            <dt>מספר הקצאה</dt><dd>{d.allocation_number ? <Badge tone="ok">{d.allocation_number}</Badge>
              : d.allocation_status === 'failed' ? <Badge tone="danger">לא התקבל</Badge> : d.allocation_status === 'pending' ? <Badge tone="warn">ממתין</Badge> : <span className="muted">לא נדרש</span>}</dd>
          </dl>
        </Card>
        {d.related?.length > 0 && (
          <Card title="מסמכים מקושרים" icon="link">
            <ul className="list-plain">
              {d.related.map((r: any) => (
                <li key={r.id}><button type="button" className="action-btn ghost small inline" onClick={() => nav(`/documents/${r.id}`)}>{DOC_TITLE[r.doc_type] ?? r.doc_type} {r.serial}</button><span className="money">{money(r.total_agorot)}</span></li>
              ))}
            </ul>
          </Card>
        )}
        {d.prints?.length > 0 && (
          <Card title="הדפסות" icon="history">
            <ul className="list-plain">{d.prints.map((p: any, i: number) => <li key={i}><span>{p.mark} · {p.format}</span><span className="muted small">{dateTime(p.created_at)} {p.actor_name ?? ''}</span></li>)}</ul>
          </Card>
        )}
      </div>
    </div>
  );
}
