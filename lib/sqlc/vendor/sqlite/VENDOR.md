# Vendored SQLite

| | |
|---|---|
| Version | 3.53.4 (`sqlite3_libversion()`), source id `2026-07-24 …bf7c7f30…` |
| Files | `sqlite3.c` (9,516,284 B), `sqlite3.h` (690,838 B) |
| sha256 `sqlite3.c` | `55e059cc5d081fa14c0d40cf99ac7aba3113c3da9fbcdb6c2d4e0155911076e5` |
| sha256 `sqlite3.h` | `919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d` |

## Provenance (read this)
sqlite.org was unreachable from the build environment, so the amalgamation was taken from the one bundled in
`better-sqlite3@13.0.3` (npm), with that package's patch 1208 reverted.
**Byte-identity with the official `sqlite-amalgamation-*.zip` has NOT been verified.** A SHA3 comparison against
sqlite.org's published hash did not match, which is what you would expect from a patched/re-generated file, but it means
you should not treat this copy as the canonical release.

## Swapping in an official amalgamation
1. Download `sqlite-amalgamation-<ver>.zip` from https://sqlite.org/download.html and verify its SHA3-256.
2. Replace `sqlite3.c` and `sqlite3.h` here.
3. `FORCE=1 make native && make check && make test && make diff`.
The shim only uses stable public C API symbols; no SQLite internals.
