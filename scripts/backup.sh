#!/bin/sh
# גיבוי DLX: pg_dump בפורמט custom, מוצפן ב-AES-256 (openssl), עם בדיקת שלמות. שומר KEEP_DAYS ימים.
# שימוש: PGPASSWORD=... BACKUP_PASSPHRASE=... sh scripts/backup.sh <host> [port] [dir]
set -eu
HOST=${1:-localhost}; PORT=${2:-5432}; DIR=${3:-/backups}; KEEP=${KEEP_DAYS:-35}
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE חסר}"
mkdir -p "$DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DIR/dlx-$STAMP.dump.enc"
pg_dump -h "$HOST" -p "$PORT" -U dlx_owner -d dlx -Fc --no-owner | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$OUT.tmp"
# בדיקה: הקובץ מתפענח ו-pg_restore מזהה אותו
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$OUT.tmp" | pg_restore --list > /dev/null
mv "$OUT.tmp" "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
find "$DIR" -name 'dlx-*.dump.enc*' -mtime +"$KEEP" -delete
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
