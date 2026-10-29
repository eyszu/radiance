#!/usr/bin/env bash
# Builds dist/libsqlc.a = SQLite amalgamation + sqlc shim, using only clang and ar.
# Re-run with FORCE=1 to rebuild; otherwise it is a no-op when the archive is newer than its inputs.
set -euo pipefail
cd "$(dirname "$0")/.."

CC="${CC:-clang}"
AR="${AR:-ar}"
OUT=dist/libsqlc.a

if [ -z "${FORCE:-}" ] && [ -f "$OUT" ] \
   && [ "$OUT" -nt vendor/sqlite/sqlite3.c ] && [ "$OUT" -nt native/sqlc.c ] && [ "$OUT" -nt scripts/build-native.sh ]; then
  exit 0
fi

# SQLite build options. Rationale for each is in README.md ("Build configuration").
SQLITE_FLAGS=(
  -O2 -fPIC
  -DSQLITE_THREADSAFE=0
  -DSQLITE_OMIT_LOAD_EXTENSION=1
  -DSQLITE_DQS=0
  -DSQLITE_DEFAULT_MEMSTATUS=0
  -DSQLITE_OMIT_DEPRECATED=1
  -DSQLITE_OMIT_SHARED_CACHE=1
  -DSQLITE_LIKE_DOESNT_MATCH_BLOBS=1
  -DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1
  -DSQLITE_USE_ALLOCA=1
  -DHAVE_USLEEP=1
  -DSQLITE_ENABLE_FTS5=1
  -DSQLITE_ENABLE_RTREE=1
  -DSQLITE_ENABLE_MATH_FUNCTIONS=1
  -DSQLITE_ENABLE_DBSTAT_VTAB=1
)

mkdir -p build dist
echo "[sqlc] compiling vendor/sqlite/sqlite3.c (takes a while) ..."
"$CC" "${SQLITE_FLAGS[@]}" -c vendor/sqlite/sqlite3.c -o build/sqlite3.o
echo "[sqlc] compiling native/sqlc.c ..."
"$CC" -O2 -fPIC -Wall -Wextra -c native/sqlc.c -o build/sqlc.o
rm -f "$OUT"
"$AR" rcs "$OUT" build/sqlite3.o build/sqlc.o
echo "[sqlc] built $OUT ($(wc -c < "$OUT") bytes)"
