#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
./rebuild_test_db.sh wasitak_test >/dev/null
for t in tests/*.sql; do echo "### $t"; su postgres -c "psql -v ON_ERROR_STOP=1 -d wasitak_test -f $PWD/$t"; done
