import {
  sqlc_abi_version, sqlc_autocommit, sqlc_busy_timeout, sqlc_changes, sqlc_close, sqlc_compileoption, sqlc_errcode,
  sqlc_errmsg, sqlc_exec, sqlc_interrupt, sqlc_last_rc, sqlc_last_rowid_f64, sqlc_last_rowid_i64, sqlc_libversion,
  sqlc_memory_used, sqlc_open, sqlc_prepare, sqlc_sourceid, sqlc_tail, sqlc_total_changes,
} from "./native";
import { SqliteError } from "./errors";
import { Statement } from "./statement";
import type { DatabaseOptions, Row } from "./types";
import { readOutString } from "./util";

/** Must equal SQLC_ABI_VERSION in native/sqlc.c. Catches a stale libsqlc.a paired with newer TypeScript. */
const EXPECTED_ABI = 1;

const OPEN_READONLY = 0x1;
const OPEN_READWRITE = 0x2;
const OPEN_CREATE = 0x4;
const PREPARE_PERSISTENT = 0x1;

const CACHE_LIMIT = 128;

/** SQLite library version, e.g. "3.53.4". */
export function sqliteVersion(): string {
  return readOutString((b: Uint8Array) => sqlc_libversion(b));
}

/** SQLite source id (check-in date and hash). */
export function sqliteSourceId(): string {
  return readOutString((b: Uint8Array) => sqlc_sourceid(b));
}

/** Options SQLite was compiled with, e.g. ["ENABLE_FTS5", "THREADSAFE=0", ...]. */
export function compileOptions(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 512; i++) {
    let buf = new Uint8Array(128);
    let n = sqlc_compileoption(i, buf);
    if (n < 0) break;
    if (n > buf.length) {
      buf = new Uint8Array(n);
      n = sqlc_compileoption(i, buf);
    }
    out.push(readOutString((b: Uint8Array) => sqlc_compileoption(i, b)));
  }
  return out;
}

/** Bytes currently allocated by SQLite. */
export function memoryUsed(): number {
  return sqlc_memory_used();
}

export class Database {
  /** The path the database was opened with (":memory:" for an in-memory database). */
  readonly name: string;
  readonly readonly: boolean;
  private ptr: bigint = 0n;
  private safeInts: boolean;
  private statements: Set<Statement> = new Set();
  private cache: Map<string, Statement> = new Map();
  private depth: number = 0;

  constructor(path?: string, options?: DatabaseOptions) {
    if (sqlc_abi_version() !== EXPECTED_ABI) {
      throw new SqliteError(
        "libsqlc.a does not match this sqlc version (ABI " + sqlc_abi_version() + ", expected " + EXPECTED_ABI + "); rebuild with `make`",
        0,
        "SQLC_ABI",
      );
    }
    this.name = path === undefined ? ":memory:" : path;
    const readOnly = options !== undefined && options.readonly === true;
    const mustExist = options !== undefined && options.fileMustExist === true;
    this.readonly = readOnly;
    this.safeInts = options !== undefined && options.safeIntegers === true;

    const flags = readOnly ? OPEN_READONLY : mustExist ? OPEN_READWRITE : OPEN_READWRITE | OPEN_CREATE;
    const handle = sqlc_open(this.name, flags);
    if (handle === 0n) throw new SqliteError("out of memory", 7);
    const rc = sqlc_errcode(handle);
    if (rc !== 0) {
      const message = readOutString((b: Uint8Array) => sqlc_errmsg(handle, b));
      sqlc_close(handle);
      throw new SqliteError(message, rc);
    }
    this.ptr = handle;

    const timeout = options !== undefined && options.timeout !== undefined ? options.timeout : 5000;
    sqlc_busy_timeout(handle, timeout);
    if (options === undefined || options.foreignKeys !== false) this.exec("PRAGMA foreign_keys = ON");
  }

  /** `false` once `close()` has been called. */
  get open(): boolean {
    return this.ptr !== 0n;
  }

  /** `true` while a transaction is open (including one started by hand with `BEGIN`). */
  get inTransaction(): boolean {
    this.assertOpen();
    return sqlc_autocommit(this.ptr) === 0;
  }

  /** Rows changed by the most recent INSERT/UPDATE/DELETE on this connection. */
  get changes(): number {
    this.assertOpen();
    return sqlc_changes(this.ptr);
  }

  /** Rows changed since the connection was opened. */
  get totalChanges(): number {
    this.assertOpen();
    return sqlc_total_changes(this.ptr);
  }

  /** Rowid of the most recent successful INSERT on this connection. */
  get lastInsertRowid(): number | bigint {
    this.assertOpen();
    const v = sqlc_last_rowid_f64(this.ptr);
    return v === v ? v : sqlc_last_rowid_i64(this.ptr);
  }

  // ---- SQL ----------------------------------------------------------------------------------

  /** Run one or more statements separated by `;`. Results are discarded: use `prepare` to read rows. */
  exec(sql: string): void {
    this.assertOpen();
    const rc = sqlc_exec(this.ptr, sql);
    if (rc !== 0) throw this.errorFor(rc);
  }

  /** Compile one statement. Reuse the returned `Statement`; call `finalize()` when done (or let `close()` do it). */
  prepare(sql: string): Statement {
    this.assertOpen();
    const handle = sqlc_prepare(this.ptr, sql, PREPARE_PERSISTENT);
    const rc = sqlc_last_rc();
    if (rc !== 0) throw this.errorFor(rc);
    if (handle === 0n) throw new SqliteError("the SQL text contains no statement", 0, "SQLC_EMPTY");
    this.rejectTrailingStatement(sql, sqlc_tail());
    const stmt = new Statement(this, handle, sql, this.safeInts);
    this.statements.add(stmt);
    return stmt;
  }

  /** Like `prepare`, but statements are cached by SQL text (up to 128), so repeated calls are cheap. */
  query(sql: string): Statement {
    const hit = this.cache.get(sql);
    if (hit !== undefined && !hit.finalized) return hit;
    if (this.cache.size >= CACHE_LIMIT) {
      for (const oldest of this.cache.keys()) {
        const evicted = this.cache.get(oldest);
        this.cache.delete(oldest);
        if (evicted !== undefined) evicted.finalize();
        break;
      }
    }
    const stmt = this.prepare(sql);
    this.cache.set(sql, stmt);
    return stmt;
  }

  /** `db.pragma("journal_mode = WAL")`, `db.pragma("user_version")`. Returns the rows the pragma produced. */
  pragma(source: string): Row[] {
    const stmt = this.prepare("PRAGMA " + source);
    const rows = stmt.all();
    stmt.finalize();
    return rows;
  }

  /** Write a consistent copy of the database to `path` (VACUUM INTO). The file must not exist. */
  backup(path: string): void {
    const stmt = this.prepare("VACUUM INTO ?");
    stmt.run([path]);
    stmt.finalize();
  }

  // ---- transactions -------------------------------------------------------------------------

  /** Run `fn` in a transaction: COMMIT if it returns, ROLLBACK and rethrow if it throws. Nested calls use savepoints. */
  transaction<T>(fn: () => T): T {
    return this.inTransaction_("BEGIN", fn);
  }

  /** Like `transaction`, but takes the write lock up front (BEGIN IMMEDIATE) so it cannot fail later with SQLITE_BUSY. */
  immediate<T>(fn: () => T): T {
    return this.inTransaction_("BEGIN IMMEDIATE", fn);
  }

  private inTransaction_<T>(begin: string, fn: () => T): T {
    this.assertOpen();
    const nested = this.depth > 0;
    const savepoint = "sqlc_sp_" + this.depth;
    this.exec(nested ? "SAVEPOINT " + savepoint : begin);
    this.depth++;
    let result: T | undefined = undefined;
    try {
      result = fn();
    } catch (e) {
      this.depth--;
      if (this.open) {
        try {
          if (nested) this.exec("ROLLBACK TO " + savepoint + "; RELEASE " + savepoint);
          else this.exec("ROLLBACK");
        } catch (rollbackError) {
          // the original error is the one worth reporting
        }
      }
      throw e;
    }
    this.depth--;
    this.exec(nested ? "RELEASE " + savepoint : "COMMIT");
    return result as T;
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  /** Abort the statement currently running on this connection (from a timer or callback). */
  interrupt(): void {
    this.assertOpen();
    sqlc_interrupt(this.ptr);
  }

  /** Finalize every statement and close the connection. Safe to call twice. */
  close(): void {
    if (this.ptr === 0n) return;
    this.cache.clear();
    const all: Statement[] = [];
    for (const s of this.statements) all.push(s);
    for (const s of all) s.finalize();
    const handle = this.ptr;
    this.ptr = 0n;
    const rc = sqlc_close(handle);
    if (rc !== 0) throw new SqliteError("failed to close the database (result code " + rc + ")", rc);
  }

  // ---- internal (used by Statement) ---------------------------------------------------------

  /** @internal */
  handle(): bigint {
    return this.ptr;
  }

  /** @internal */
  assertOpen(): void {
    if (this.ptr === 0n) throw new SqliteError("the database connection is not open", 0, "SQLC_CLOSED");
  }

  /** @internal */
  forget(stmt: Statement): void {
    this.statements.delete(stmt);
  }

  /** @internal Build an error for result code `rc` with SQLite's message for the connection's last failure. */
  errorFor(rc: number): SqliteError {
    const handle = this.ptr;
    const message = handle === 0n ? "the database connection is not open" : readOutString((b: Uint8Array) => sqlc_errmsg(handle, b));
    return new SqliteError(message, rc);
  }

  private rejectTrailingStatement(sql: string, tail: number): void {
    const bytes = Buffer.from(sql, "utf8");
    if (tail >= bytes.length) return;
    const rest = bytes.subarray(tail).toString("utf8");
    if (rest.trim().length === 0) return;
    // anything left must be comments/whitespace; if it holds a statement, refuse like better-sqlite3 does
    const handle = sqlc_prepare(this.ptr, rest, PREPARE_PERSISTENT);
    if (handle !== 0n) {
      // prepared successfully: it is a real second statement
      const msg = "the supplied SQL contains more than one statement; use exec() for scripts";
      this.discard(handle);
      throw new SqliteError(msg, 0, "SQLC_MULTI");
    }
    const rc = sqlc_last_rc();
    if (rc !== 0) throw this.errorFor(rc);
  }

  private discard(handle: bigint): void {
    const s = new Statement(this, handle, "", false);
    s.finalize();
  }
}
