import {
  sqlc_bind_blob, sqlc_bind_count, sqlc_bind_int64, sqlc_bind_name, sqlc_bind_null, sqlc_bind_number,
  sqlc_bind_text, sqlc_changes, sqlc_clear_bindings, sqlc_column_count, sqlc_column_name, sqlc_finalize,
  sqlc_last_rowid_f64, sqlc_last_rowid_i64, sqlc_readonly, sqlc_reset, sqlc_row_pack, sqlc_step_pack,
} from "./native";
import type { Database } from "./database";
import { SqliteError } from "./errors";
import type { Params, Row, SqlValue } from "./types";
import { decodeUtf8, readOutString } from "./util";

// Packed-row type tags. Must match native/sqlc.c.
const TAG_NULL = 0;
const TAG_INT_AS_DOUBLE = 1;
const TAG_FLOAT = 2;
const TAG_TEXT = 3;
const TAG_BLOB = 4;

/** Outcome of `Statement.run()`. */
export class RunResult {
  /** Rows inserted, updated or deleted by the statement (0 for statements that do not write). */
  changes: number;
  /** Rowid of the most recent insert on the connection (0 for statements that do not write). `bigint` only past 2^53. */
  lastInsertRowid: number | bigint;
  constructor(changes: number, lastInsertRowid: number | bigint) {
    this.changes = changes;
    this.lastInsertRowid = lastInsertRowid;
  }
}

/** A prepared statement. Create one with `db.prepare(sql)` and reuse it: preparing is the expensive part. */
export class Statement {
  readonly sql: string;
  private db: Database;
  private ptr: bigint;
  private names: string[] = [];
  private named: Map<string, number> = new Map();
  private paramCount: number = 0;
  private writes: boolean = false;
  private dirty: boolean = false; // bindings may be set and need clearing before the next run
  private bigints: boolean;
  private buf: Uint8Array = new Uint8Array(4096);
  private view: DataView = new DataView(new ArrayBuffer(0));
  private pos: number = 0;
  private done: boolean = false;

  /** @internal use `db.prepare()` */
  constructor(db: Database, ptr: bigint, sql: string, safeIntegers: boolean) {
    this.db = db;
    this.ptr = ptr;
    this.sql = sql;
    this.bigints = safeIntegers;
    this.view = new DataView(this.buf.buffer);
    this.writes = sqlc_readonly(ptr) === 0;
    const columns = sqlc_column_count(ptr);
    for (let i = 0; i < columns; i++) {
      this.names.push(readOutString((b: Uint8Array) => sqlc_column_name(ptr, i, b)));
    }
    this.paramCount = sqlc_bind_count(ptr);
    for (let i = 1; i <= this.paramCount; i++) {
      const name = readOutString((b: Uint8Array) => sqlc_bind_name(ptr, i, b));
      if (name.length > 0) {
        this.named.set(name, i);
        const c = name.charCodeAt(0);
        if (c === 58 || c === 64 || c === 36) this.named.set(name.slice(1), i); // ':' '@' '$'
      }
    }
  }

  /** Column names, in order. */
  columns(): string[] {
    return this.names.slice();
  }

  /** Number of bind parameters in the SQL. */
  get parameterCount(): number {
    return this.paramCount;
  }

  /** `true` when the statement cannot change the database. */
  get readonly(): boolean {
    return !this.writes;
  }

  get finalized(): boolean {
    return this.ptr === 0n;
  }

  /**
   * Return INTEGER columns as `bigint` always (true) or as `number` unless they exceed 2^53 (false, the default).
   * Integers beyond 2^53 are never rounded: they come back as `bigint` in both modes.
   */
  safeIntegers(on: boolean = true): Statement {
    this.bigints = on;
    return this;
  }

  // ---- execution ----------------------------------------------------------------------------

  /** Execute and discard any rows. */
  run(params?: Params): RunResult {
    this.start(params);
    while (this.step()) {
      // drain: statements like INSERT ... RETURNING produce rows we do not want here
    }
    let result: RunResult = new RunResult(0, 0);
    if (this.writes) {
      const rowid = sqlc_last_rowid_f64(this.db.handle());
      result = new RunResult(
        sqlc_changes(this.db.handle()),
        rowid === rowid ? rowid : sqlc_last_rowid_i64(this.db.handle()),
      );
    }
    this.finish();
    return result;
  }

  /** First row, or `undefined` when there is none. */
  get(params?: Params): Row | undefined {
    this.start(params);
    let row: Row | undefined = undefined;
    if (this.step()) row = this.decodeRow();
    this.finish();
    return row;
  }

  /** All rows as objects keyed by column name. */
  all(params?: Params): Row[] {
    this.start(params);
    const rows: Row[] = [];
    while (this.step()) rows.push(this.decodeRow());
    this.finish();
    return rows;
  }

  /** All rows as arrays in column order (no per-row key allocation; also safe with duplicate column names). */
  values(params?: Params): SqlValue[][] {
    this.start(params);
    const rows: SqlValue[][] = [];
    while (this.step()) rows.push(this.decodeValues());
    this.finish();
    return rows;
  }

  /** Call `visit` with each row as it is produced, without materializing the whole result. */
  each(params: Params | undefined, visit: (row: Row) => void): void {
    this.start(params);
    while (this.step()) visit(this.decodeRow());
    this.finish();
  }

  /** Release the native statement. The statement cannot be used afterwards. Safe to call twice. */
  finalize(): void {
    if (this.ptr === 0n) return;
    const p = this.ptr;
    this.ptr = 0n;
    this.db.forget(this);
    sqlc_finalize(p);
  }

  // ---- internals ----------------------------------------------------------------------------

  private start(params: Params | undefined): void {
    if (this.ptr === 0n) throw new SqliteError("statement has been finalized", 0, "SQLC_FINALIZED");
    this.db.assertOpen();
    sqlc_reset(this.ptr);
    if (this.dirty) {
      sqlc_clear_bindings(this.ptr);
      this.dirty = false;
    }
    this.done = false;
    if (params !== undefined) this.bindAll(params);
  }

  private finish(): void {
    sqlc_reset(this.ptr); // releases read locks and lets the statement be re-run
  }

  private bindAll(params: Params): void {
    this.dirty = true;
    if (Array.isArray(params)) {
      if (params.length > this.paramCount) {
        throw new SqliteError(
          "too many parameter values were provided (" + params.length + " given, " + this.paramCount + " expected)",
          25,
          "SQLC_RANGE",
        );
      }
      let index = 1;
      for (const value of params) {
        this.bindValue(index, value);
        index++;
      }
    } else {
      for (const key in params) {
        const index = this.named.get(key);
        if (index === undefined) throw new SqliteError("unknown named parameter '" + key + "'", 25, "SQLC_RANGE");
        this.bindValue(index, params[key]);
      }
    }
  }

  private bindValue(index: number, value: SqlValue): void {
    let rc = 0;
    if (value === null) rc = sqlc_bind_null(this.ptr, index);
    else if (typeof value === "number") rc = sqlc_bind_number(this.ptr, index, value);
    else if (typeof value === "string") rc = sqlc_bind_text(this.ptr, index, value);
    else if (typeof value === "bigint") rc = sqlc_bind_int64(this.ptr, index, value);
    else if (typeof value === "boolean") rc = sqlc_bind_number(this.ptr, index, value ? 1 : 0);
    else rc = sqlc_bind_blob(this.ptr, index, value);
    if (rc !== 0) throw this.db.errorFor(rc);
  }

  /** Advance one row. The row is left packed in `buf`; returns false when the statement is done. */
  private step(): boolean {
    if (this.done) return false;
    const mode = this.bigints ? 1 : 0;
    let n = sqlc_step_pack(this.ptr, this.buf, mode);
    if (n >= 0) {
      if (n > this.buf.length) {
        // the row did not fit: grow once to the exact size and re-pack the same (still current) row
        this.buf = new Uint8Array(n > this.buf.length * 2 ? n : this.buf.length * 2);
        this.view = new DataView(this.buf.buffer);
        n = sqlc_row_pack(this.ptr, this.buf, mode);
      }
      this.pos = 0;
      return true;
    }
    this.done = true;
    if (n === -1) return false;
    const err = this.db.errorFor(-n - 1);
    sqlc_reset(this.ptr);
    throw err;
  }

  private readValue(): SqlValue {
    const tag = this.buf[this.pos];
    this.pos++;
    if (tag === TAG_NULL) return null;
    if (tag === TAG_INT_AS_DOUBLE || tag === TAG_FLOAT) {
      const v = this.view.getFloat64(this.pos, true);
      this.pos += 8;
      return v;
    }
    if (tag === TAG_TEXT) {
      const len = this.view.getUint32(this.pos, true);
      this.pos += 4;
      const s = decodeUtf8(this.buf, this.pos, this.pos + len);
      this.pos += len;
      return s;
    }
    if (tag === TAG_BLOB) {
      const len = this.view.getUint32(this.pos, true);
      this.pos += 4;
      const b = this.buf.slice(this.pos, this.pos + len); // copy: `buf` is reused for the next row
      this.pos += len;
      return b;
    }
    const big = this.view.getBigInt64(this.pos, true); // TAG_INT64
    this.pos += 8;
    return big;
  }

  private decodeRow(): Row {
    const row: Row = {};
    for (const name of this.names) row[name] = this.readValue();
    return row;
  }

  private decodeValues(): SqlValue[] {
    const out: SqlValue[] = [];
    for (const _name of this.names) out.push(this.readValue());
    return out;
  }
}
