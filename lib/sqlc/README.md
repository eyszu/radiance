# sqlc — a zero-dependency SQLite driver for scriptc

`sqlc` lets a [scriptc](https://scriptc.dev)-compiled TypeScript program talk to SQLite. SQLite itself is vendored and
statically linked into your executable, so there is **no npm dependency, no system `libsqlite3`, and no loadable
module** that can drift or break underneath you. Everything needed is in this directory plus `clang` (which scriptc
already requires).

```ts
import { Database } from "./src/index";

const db = new Database("app.db");
db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)");
db.prepare("INSERT INTO users (name) VALUES (:name)").run({ name: "Ada" });
console.log(db.prepare("SELECT * FROM users").all());
db.close();
```

```
export SCRIPTC=/path/to/scriptc     # scriptc >= 0.4.5 (FFI manifest format 7)
./sqlc build app.ts -o app          # builds dist/libsqlc.a on first use, then calls scriptc
./app
```

## 1. "No dependency", precisely

| Claim | Evidence in this repo |
|---|---|
| Driver has no runtime packages | `src/` imports only itself; `package.json` does not exist |
| SQLite is not an external library | `vendor/sqlite/sqlite3.c` compiled by `scripts/build-native.sh` into `dist/libsqlc.a`, linked statically |
| Output binary links nothing new | `readelf -d build/hello` → `NEEDED: libm.so.6, libc.so.6` only (the same as any scriptc binary). `nm -D` shows 0 imported `sqlite3_*` symbols; `nm` shows 260 defined statically |
| Build needs no tools beyond scriptc's | `clang`, `ar`, `bash` |
| Test tooling is optional | the test suite is itself a scriptc program; `bun` is used only for the differential test and benchmarks |

Caveat: the *vendored* SQLite amalgamation's provenance is documented in `vendor/sqlite/VENDOR.md`; byte-identity with
sqlite.org's zip is unverified.

## 2. Architecture

```
 your.ts ──► src/database.ts, statement.ts      (typed TS API, 100% statically compiled by scriptc)
                   │  export declare function sqlc_*(…)   (src/native.ts, 37 signatures)
                   ▼
        sqlc.ffi.json (ffi_format 7)  ── scriptc FFI binding by name ──►  native/sqlc.c  (301 lines)
                                                                              │
                                                              vendor/sqlite/sqlite3.c (amalgamation)
```

### Why a C shim at all
scriptc's FFI is deliberately narrow, and SQLite's C API doesn't fit it directly:

| scriptc FFI constraint | SQLite API that collides | Shim solution |
|---|---|---|
| strings/bytes are passed as `(const uint8_t*, size_t)` | `sqlite3_prepare_v2(db, const char*, nByte, …)` expects NUL-terminated/length pairs in a different order | `sqlc_prepare(db, sql, flags)` takes the pair and copies as needed |
| returns are scalar or opaque pointer only | `sqlite3_column_text` returns pointers into SQLite memory | rows are serialised into a caller-provided buffer |
| no out-params | `sqlite3_prepare(…, &stmt, &tail)`, error strings | pointer returned directly; `sqlc_last_rc()`, `sqlc_tail()`, `sqlc_errmsg(db, buf)` |
| `i64` is `bigint` in TS | rowids/ints beyond 2^53 | `sqlc_last_rowid_f64` (NaN if unsafe) + `_i64` |

Pointers (`sqlite3*`, `sqlite3_stmt*`) are opaque `bigint` handles in TypeScript; `0n` means NULL.

### Packed-row protocol (one FFI call per row)
Crossing the FFI per *column* would dominate runtime. `sqlc_step_pack(stmt, buf, mode)` steps and serialises the whole
row (little-endian) into a `mutable-bytes` buffer:

| tag | meaning | payload |
|---|---|---|
| 0 | NULL | – |
| 1 | INTEGER (fits 2^53−1) as double | 8 B |
| 2 | REAL | 8 B |
| 3 | TEXT | u32 len + UTF-8 |
| 4 | BLOB | u32 len + bytes |
| 5 | INTEGER raw int64 (→ `bigint`) | 8 B |

Return value: `>= 0` packed size (if larger than the buffer, the row is *not lost* — call `sqlc_row_pack` with a bigger
buffer; the statement hasn't advanced), `-1` DONE, `<= -2` error with `rc = -ret - 1`. `mode` bit 0 forces tag 5 for every
integer (`safeIntegers`). The shim has an `#error` on big-endian hosts.

Binding goes the other way with `sqlc_bind_*`: JS numbers that are integral and within ±2^53 bind as INTEGER, otherwise
REAL; `bigint` binds as int64; empty strings/blobs bind as empty (not NULL).

## 3. Build configuration (`scripts/build-native.sh`)
| Flag | Why |
|---|---|
| `THREADSAFE=0` | scriptc programs are single-threaded; removes mutex overhead |
| `OMIT_LOAD_EXTENSION` | no `dlopen` ⇒ no extra libc/libdl dependency; also closes an attack surface |
| `DQS=0` | `"x"` is an identifier only, never a string — catches typos instead of silently misbehaving |
| `DEFAULT_MEMSTATUS=0` | skip global allocator counters |
| `OMIT_DEPRECATED`, `OMIT_SHARED_CACHE` | smaller, simpler |
| `LIKE_DOESNT_MATCH_BLOBS` | sane `LIKE` semantics |
| `DEFAULT_WAL_SYNCHRONOUS=1` | WAL is safe with `synchronous=NORMAL` |
| `USE_ALLOCA`, `HAVE_USLEEP` | fewer heap allocations; precise busy-wait sleeps |
| `ENABLE_FTS5`, `ENABLE_RTREE`, `ENABLE_MATH_FUNCTIONS`, `ENABLE_DBSTAT_VTAB` | batteries included |

Result: `dist/libsqlc.a` = 2,056,014 B; a hello-world binary is 2.2 MB.

## 4. API

`new Database(path = ":memory:", options?)` — options: `readonly`, `fileMustExist`, `timeout` (ms, default 5000),
`safeIntegers` (default false), `foreignKeys` (default **true**).

| Database | |
|---|---|
| `exec(sql)` | run one or more statements, no results |
| `prepare(sql)` | one statement; rejects empty (`SQLC_EMPTY`) and multi-statement (`SQLC_MULTI`) SQL |
| `query(sql)` | `prepare` + cache (128 entries, FIFO eviction) |
| `pragma(src)` | rows as objects |
| `transaction(fn)` / `immediate(fn)` | BEGIN/COMMIT, ROLLBACK on throw; nested calls become SAVEPOINTs |
| `backup(path)` | `VACUUM INTO` |
| `interrupt()`, `close()` | `close` is idempotent and finalizes outstanding statements |
| getters | `open`, `readonly`, `inTransaction`, `changes`, `totalChanges`, `lastInsertRowid` |

| Statement | |
|---|---|
| `run(params?)` → `{changes, lastInsertRowid}` | |
| `get(params?)` → row \| `undefined`; `all()`; `values()` (arrays); `each(params, fn)` | |
| `columns()`, `parameterCount`, `readonly`, `finalized`, `safeIntegers(on)`, `finalize()` | |

Params are an array (positional) or an object (named; keys with or without the `:`/`@`/`$` prefix). Unknown names or
too many values throw `SQLC_RANGE`; too few leave NULLs. Values: `null | number | bigint | string | boolean | Uint8Array`.
Integers come back as `number` up to ±(2^53−1) and `bigint` beyond (or always, with `safeIntegers`).

Errors are `SqliteError {code, errno, message}` with SQLite's primary/extended names (`SQLITE_CONSTRAINT_UNIQUE`, …)
and driver codes `SQLC_CLOSED/FINALIZED/RANGE/EMPTY/MULTI/ABI`.

## 5. scriptc-specific design notes
The whole driver compiles 100% statically (`./sqlc coverage src/index.ts`). Constructs that forced rewrites: no `fn.length`,
`import type` required for type-only imports, `let r: T` must be `T | undefined` + cast, string-converting a union with
object arms must be narrowed first (`typeof x === "string"`). Row decoding uses `for…of` over cached column names.

## 6. Verification
| Check | Command | Result at time of writing |
|---|---|---|
| Unit/integration tests (scriptc binary, real SQLite) | `make test` | 52 passed, 0 failed |
| ABI agreement C ↔ manifest ↔ TS | `scripts/check-abi.sh` | 37 functions agree |
| Differential vs `bun:sqlite` | `make diff` | 5 seeds × ~5k output lines each: byte-identical, including which statements error |
| Leak check | in `make test` | SQLite heap growth < 64 KiB over 200 open/use/close cycles; < 16 KiB over 200k re-runs |

Test coverage includes type round-trips (2^53, int64 min/max, NUL bytes, emoji, empty values), buffer growth (2.6 MB text,
3 MB blob, 500 columns), constraints, transactions/savepoints, WAL, readonly, `SQLITE_BUSY`, FTS5, JSON, R-tree, math,
window functions, upsert, RETURNING, 100k-row scale.

## 7. Benchmarks (in-memory DB, 3 runs, ms — lower is better; `bench/`)
| Workload | sqlc | bun:sqlite | node:sqlite |
|---|---|---|---|
| insert 200k rows, one txn | 130–230 | 135–156 | 235–257 |
| select 200k rows → objects | 132–200 | 55–60 | 379–423 |
| select 200k rows → arrays | 102–152 | 54–84 | 118–122 |
| 100k point queries | 141–238 | 94–106 | 172–179 |
| 20× GROUP BY over 200k rows | 1228–1298 | 1154–1260 | 1023–1169 |

Honest reading: sqlc is competitive on writes and aggregates (SQLite-bound), beats node:sqlite on object materialisation,
but **bun:sqlite is faster at reading rows** (≈2–3×) and point queries. Run-to-run variance is large on this shared VM; treat
these as order-of-magnitude. The read path has headroom (per-row `Uint8Array` decode and object construction).

## 8. Limitations
- No user-defined SQL functions/collations, hooks, or incremental blob I/O; `backup()` is `VACUUM INTO`, not the online backup API.
- Single-threaded by construction (`THREADSAFE=0`); don't share a connection across threads.
- Database paths cannot contain NUL; `-0.0` binds as integer 0; duplicate column names collapse in object rows (use `values()`).
- Requires scriptc ≥ 0.4.5 (`ffi_format` 7), Linux/clang tested only; little-endian only.
- Vendored amalgamation provenance: see `vendor/sqlite/VENDOR.md`.

## 9. Layout
```
native/sqlc.c   C shim            src/        TypeScript driver       tests/      scriptc test suite
vendor/sqlite/  amalgamation      sqlc.ffi.json  FFI manifest         test/diff/  bun differential test
scripts/        build + ABI check sqlc  CLI wrapper (build|run|coverage|native)   bench/  benchmarks
```
