#!/bin/sh
set -eu

DB_MAX_ATTEMPTS="${DB_MAX_ATTEMPTS:-60}"
DB_WAIT_SECONDS="${DB_WAIT_SECONDS:-2}"

attempt=1
printf 'Waiting for database %s:%s' "${DB_HOST:-localhost}" "${DB_PORT:-3306}"
while [ "$attempt" -le "$DB_MAX_ATTEMPTS" ]; do
  if python - <<'PY'
import os
import pymysql

host = os.environ.get("DB_HOST", "localhost")
port = int(os.environ.get("DB_PORT", "3306"))
user = os.environ.get("DB_USER", "")
password = os.environ.get("DB_PASSWORD", "")
database = os.environ.get("DB_NAME", "")

try:
    connection = pymysql.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database,
        connect_timeout=5,
    )
except Exception as exc:  # noqa: BLE001 - best effort logging
    raise SystemExit(str(exc))
else:
    connection.close()
PY
  then
    echo " - ready"
    break
  fi
  if [ "$attempt" -eq "$DB_MAX_ATTEMPTS" ]; then
    echo "\nDatabase connection failed after ${DB_MAX_ATTEMPTS} attempts"
    exit 1
  fi
  printf '.'
  attempt=$((attempt + 1))
  sleep "$DB_WAIT_SECONDS"
done

echo "Running database migrations"
alembic upgrade head

echo "Starting application: $*"
exec "$@"
