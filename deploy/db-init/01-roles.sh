#!/bin/sh
# רץ פעם אחת, ביצירת מסד הנתונים בקונטיינר. התפקידים כמו ב-scripts/db-setup.sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE dlx_owner LOGIN BYPASSRLS CREATEDB PASSWORD '${DLX_OWNER_PASSWORD}';
CREATE ROLE dlx_app LOGIN NOBYPASSRLS PASSWORD '${DLX_APP_PASSWORD}';
CREATE DATABASE dlx OWNER dlx_owner;
SQL
