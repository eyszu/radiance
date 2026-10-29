#!/usr/bin/env bash
# Builds ./build/blog (a single native executable; SQLite is linked in).
set -euo pipefail
cd "$(dirname "$0")"
export SCRIPTC="${SCRIPTC:-scriptc}"
mkdir -p build
bash lib/sqlc/sqlc build src/main.ts -o build/blog
