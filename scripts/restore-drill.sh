#!/bin/sh
# תרגול שחזור (QA-20): משחזר גיבוי למסד נפרד dlx_restore_check, ובודק שהנתונים שלמים. לא נוגע במסד החי.
# שימוש: PGPASSWORD=<owner> BACKUP_PASSPHRASE=... sh scripts/restore-drill.sh <file.dump.enc> [host] [port]
set -eu
FILE=${1:?קובץ גיבוי}; HOST=${2:-localhost}; PORT=${3:-5432}
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE חסר}"
DB=dlx_restore_check
psql -h "$HOST" -p "$PORT" -U dlx_owner -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$FILE" | pg_restore -h "$HOST" -p "$PORT" -U dlx_owner -d "$DB" --no-owner --exit-on-error
psql -h "$HOST" -p "$PORT" -U dlx_owner -d "$DB" -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT 'tenants: ' || count(*) FROM tenants;
SELECT 'documents: ' || count(*) FROM documents;
SELECT 'stock_movements: ' || count(*) FROM stock_movements;
SELECT 'audit_events: ' || count(*) FROM audit_events;
SELECT 'last document: ' || COALESCE(max(issued_at)::text, '-') FROM documents;
SELECT 'sequence gaps: ' || count(*) FROM (
  SELECT tenant_id, doc_type, serial, lag(serial) OVER (PARTITION BY tenant_id, doc_type ORDER BY serial) AS prev FROM documents
) x WHERE prev IS NOT NULL AND serial <> prev + 1;
SQL
echo "restore drill ok — DB $DB (מחקו אותו בסיום: DROP DATABASE $DB)"
