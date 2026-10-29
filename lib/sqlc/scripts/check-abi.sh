#!/usr/bin/env bash
# Verifies that the three views of the native ABI agree:
#   native/sqlc.c exports  <->  sqlc.ffi.json  <->  src/native.ts declarations
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f dist/libsqlc.a ] || scripts/build-native.sh >/dev/null
a=$(nm dist/libsqlc.a 2>/dev/null | awk '$2=="T" && $3 ~ /^sqlc_/ {print $3}' | sort -u)
m=$(python3 -c 'import json;print("\n".join(sorted(f["symbol"] for f in json.load(open("sqlc.ffi.json"))["functions"])))')
n=$(python3 -c 'import json;print("\n".join(sorted(f["name"] for f in json.load(open("sqlc.ffi.json"))["functions"])))')
d=$(grep -o 'export declare function sqlc_[a-z0-9_]*' src/native.ts | awk '{print $4}' | sort -u)
fail=0
cmp() { if ! diff <(echo "$2") <(echo "$3") >/dev/null; then echo "MISMATCH: $1"; diff <(echo "$2") <(echo "$3") || true; fail=1; fi; }
cmp "manifest symbols vs archive exports" "$m" "$a"
cmp "manifest names vs TS declarations" "$n" "$d"
[ $fail = 0 ] && echo "ABI ok: $(echo "$m" | wc -l) functions agree across C, manifest and TypeScript"
exit $fail
