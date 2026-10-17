#!/usr/bin/env bash
# יוצר את תפקידי ה-DB ואת מסדי הנתונים לפיתוח ולבדיקות (להריץ פעם אחת, כמשתמש-על של Postgres).
# dlx_owner — בעלים, מריץ מיגרציות (BYPASSRLS כדי שפונקציות ה-SECURITY DEFINER יעבדו).
# dlx_app   — השרת. כפוף ל-RLS תמיד.
set -euo pipefail
PSQL=${PSQL:-"sudo -u postgres psql"}
OWNER_PW=${DLX_OWNER_PASSWORD:-dlx_owner_dev}
APP_PW=${DLX_APP_PASSWORD:-dlx_app_dev}
$PSQL -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dlx_owner') THEN
    CREATE ROLE dlx_owner LOGIN BYPASSRLS PASSWORD '$OWNER_PW';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dlx_app') THEN
    CREATE ROLE dlx_app LOGIN NOBYPASSRLS PASSWORD '$APP_PW';
  END IF;
END \$\$;
SQL
for db in dlx dlx_test; do
  if ! $PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
    $PSQL -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db OWNER dlx_owner"
  fi
done
echo "DB ready: dlx, dlx_test"
