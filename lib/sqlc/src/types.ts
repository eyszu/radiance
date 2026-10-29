/** A value that can be bound to a parameter or read from a column. SQLite NULL/INTEGER/REAL/TEXT/BLOB. */
export type SqlValue = null | number | bigint | string | boolean | Uint8Array;

/** One result row keyed by column name. Duplicate column names keep the last one; use `values()` to avoid that. */
export type Row = Record<string, SqlValue>;

/** Positional (`[1, "a"]`) or named (`{ id: 1 }`) parameters. Named keys may omit the `:`, `@` or `$` prefix. */
export type Params = SqlValue[] | Row;

export interface DatabaseOptions {
  /** Open read-only. Default: false. */
  readonly?: boolean;
  /** Fail instead of creating the file when it does not exist. Default: false. */
  fileMustExist?: boolean;
  /** Milliseconds to wait on a locked database before failing with SQLITE_BUSY. Default: 5000. */
  timeout?: number;
  /** Return every INTEGER as `bigint` instead of `number` when it exceeds 2^53. Default: false. See `Statement.safeIntegers`. */
  safeIntegers?: boolean;
  /** Run `PRAGMA foreign_keys = ON` on open. SQLite itself defaults to OFF. Default: true. */
  foreignKeys?: boolean;
}
