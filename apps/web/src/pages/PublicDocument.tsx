// קישור צפייה ללקוח (D05): המסמך כפי שהופק, בלי התחברות
import { useParams } from 'react-router-dom';

export default function PublicDocument() {
  const { token } = useParams();
  return <iframe className="doc-frame public" title="מסמך" src={`/v1/public/documents/${encodeURIComponent(token ?? '')}`} />;
}
