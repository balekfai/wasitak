#!/usr/bin/env bash
# يعيد بناء قاعدة اختبار نظيفة ويطبق كل الترحيلات بالترتيب
set -euo pipefail
DB=${1:-wasitak_test}
DIR="$(cd "$(dirname "$0")" && pwd)/migrations"
su postgres -c "psql -q -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB' AND pid <> pg_backend_pid()\" -c 'DROP DATABASE IF EXISTS $DB' -c 'CREATE DATABASE $DB'" 2>&1 | grep -vE "NOTICE|pg_terminate|^-+|row|^\s*$|^\s+t$" || true
for f in "$DIR"/*.sql; do echo "== $(basename "$f")"; su postgres -c "psql -q -v ON_ERROR_STOP=1 -d $DB -f $f"; done
