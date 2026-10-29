const NAMES: Map<number, string> = new Map([
  [1, "SQLITE_ERROR"], [2, "SQLITE_INTERNAL"], [3, "SQLITE_PERM"], [4, "SQLITE_ABORT"], [5, "SQLITE_BUSY"],
  [6, "SQLITE_LOCKED"], [7, "SQLITE_NOMEM"], [8, "SQLITE_READONLY"], [9, "SQLITE_INTERRUPT"], [10, "SQLITE_IOERR"],
  [11, "SQLITE_CORRUPT"], [12, "SQLITE_NOTFOUND"], [13, "SQLITE_FULL"], [14, "SQLITE_CANTOPEN"], [15, "SQLITE_PROTOCOL"],
  [16, "SQLITE_EMPTY"], [17, "SQLITE_SCHEMA"], [18, "SQLITE_TOOBIG"], [19, "SQLITE_CONSTRAINT"], [20, "SQLITE_MISMATCH"],
  [21, "SQLITE_MISUSE"], [22, "SQLITE_NOLFS"], [23, "SQLITE_AUTH"], [24, "SQLITE_FORMAT"], [25, "SQLITE_RANGE"],
  [26, "SQLITE_NOTADB"],
  // extended codes people actually branch on
  [261, "SQLITE_BUSY_RECOVERY"], [517, "SQLITE_BUSY_SNAPSHOT"], [773, "SQLITE_BUSY_TIMEOUT"], [262, "SQLITE_LOCKED_SHAREDCACHE"],
  [264, "SQLITE_READONLY_RECOVERY"], [776, "SQLITE_READONLY_ROLLBACK"], [1032, "SQLITE_READONLY_DBMOVED"],
  [1544, "SQLITE_IOERR_SHORT_READ"], [266, "SQLITE_IOERR_READ"], [778, "SQLITE_IOERR_WRITE"],
  [275, "SQLITE_CONSTRAINT_CHECK"], [531, "SQLITE_CONSTRAINT_COMMITHOOK"], [787, "SQLITE_CONSTRAINT_FOREIGNKEY"],
  [1043, "SQLITE_CONSTRAINT_FUNCTION"], [1299, "SQLITE_CONSTRAINT_NOTNULL"], [1555, "SQLITE_CONSTRAINT_PRIMARYKEY"],
  [1811, "SQLITE_CONSTRAINT_TRIGGER"], [2067, "SQLITE_CONSTRAINT_UNIQUE"], [2323, "SQLITE_CONSTRAINT_VTAB"],
  [2579, "SQLITE_CONSTRAINT_ROWID"], [3091, "SQLITE_CONSTRAINT_DATATYPE"],
  [270, "SQLITE_CANTOPEN_ISDIR"], [1038, "SQLITE_CANTOPEN_FULLPATH"],
  [1, "SQLITE_ERROR"],
]);

/** Symbolic name for a SQLite result code ("SQLITE_CONSTRAINT_UNIQUE"); falls back to the primary code's name. */
export function codeName(errno: number): string {
  const exact = NAMES.get(errno);
  if (exact !== undefined) return exact;
  const primary = NAMES.get(errno & 0xff);
  return primary !== undefined ? primary : "SQLITE_UNKNOWN";
}

/** Raised for every SQLite failure and for misuse of the driver API. */
export class SqliteError extends Error {
  /** Symbolic code, e.g. "SQLITE_CONSTRAINT_UNIQUE". Driver-level problems use "SQLC_*". */
  code: string;
  /** SQLite extended result code (0 for driver-level problems). Primary code = errno & 0xff. */
  errno: number;

  constructor(message: string, errno: number, code?: string) {
    super(message);
    this.name = "SqliteError";
    this.errno = errno;
    this.code = code !== undefined ? code : codeName(errno);
  }
}
