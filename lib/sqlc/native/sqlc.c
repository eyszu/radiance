/*
 * sqlc native shim: the only C code in the driver.
 *
 * scriptc's FFI passes strings and byte buffers as (pointer, length) pairs, returns only scalars
 * or an opaque pointer, and cannot take out-parameters. SQLite's C API wants NUL-terminated strings
 * and `sqlite3 **` out-parameters, so this file adapts one to the other. It contains no policy:
 * SQL semantics stay in SQLite, API design stays in TypeScript.
 *
 * Conventions
 *   - every function is `sqlc_*` and bound 1:1 by sqlc.ffi.json
 *   - handles (sqlite3 *, sqlite3_stmt *) cross the boundary as opaque pointers
 *   - text/blob inputs are borrowed for the call only, so they are copied (SQLITE_TRANSIENT)
 *   - text/blob outputs are copied into a caller-supplied buffer; the return value is the number of
 *     bytes needed, so a caller with a too-small buffer can retry with the right size
 *   - result codes are SQLite extended result codes (enabled at open)
 *   - single-threaded by design (SQLite is built with SQLITE_THREADSAFE=0); the few static
 *     variables below rely on that
 */
#include "../vendor/sqlite/sqlite3.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#if !defined(__BYTE_ORDER__) || __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "sqlc packs rows in little-endian order and currently supports little-endian hosts only"
#endif

#define SQLC_ABI_VERSION 1

/* packed-row type tags; must match src/statement.ts */
#define TAG_NULL 0
#define TAG_INT_AS_DOUBLE 1 /* INTEGER that is exactly representable as a JS number */
#define TAG_FLOAT 2
#define TAG_TEXT 3
#define TAG_BLOB 4
#define TAG_INT64 5 /* INTEGER kept as raw int64 (bigint on the TS side) */

#define MODE_BIGINT 1 /* step_pack/row_pack mode bit: return every INTEGER as TAG_INT64 */

#define MAX_SAFE 9007199254740991LL

static int sqlc_inited = 0;
static int sqlc_tail_off = 0;
static int sqlc_last_rc_value = 0;

static void sqlc_init(void) {
  if (!sqlc_inited) {
    sqlite3_initialize();
    sqlc_inited = 1;
  }
}

/* NUL-terminated copy of a (ptr, len) string. Caller frees. */
static char *dup_z(const uint8_t *p, size_t n) {
  char *z = (char *)malloc(n + 1);
  if (!z) return NULL;
  if (n) memcpy(z, p, n);
  z[n] = 0;
  return z;
}

/* copy `len` bytes of `src` into the caller's buffer (up to `cap`); always return the full length */
static int32_t copy_out(const char *src, size_t len, uint8_t *buf, size_t cap) {
  if (len > 0 && len <= cap) memcpy(buf, src, len);
  else if (len > cap && cap > 0) memcpy(buf, src, cap);
  return (int32_t)len;
}

/* ------------------------------------------------------------------------------------------ */
/* library info                                                                               */
/* ------------------------------------------------------------------------------------------ */

int32_t sqlc_abi_version(void) { return SQLC_ABI_VERSION; }
int32_t sqlc_libversion_number(void) { return sqlite3_libversion_number(); }
int32_t sqlc_libversion(uint8_t *buf, size_t cap) {
  const char *s = sqlite3_libversion();
  return copy_out(s, strlen(s), buf, cap);
}
int32_t sqlc_sourceid(uint8_t *buf, size_t cap) {
  const char *s = sqlite3_sourceid();
  return copy_out(s, strlen(s), buf, cap);
}
/* i-th compile option ("ENABLE_FTS5", ...), or -1 past the end */
int32_t sqlc_compileoption(int32_t i, uint8_t *buf, size_t cap) {
  const char *s = sqlite3_compileoption_get(i);
  if (!s) return -1;
  return copy_out(s, strlen(s), buf, cap);
}
double sqlc_memory_used(void) { return (double)sqlite3_memory_used(); }

/* ------------------------------------------------------------------------------------------ */
/* connections                                                                                */
/* ------------------------------------------------------------------------------------------ */

/* Returns the connection even when opening failed (inspect sqlc_errcode); NULL only on OOM. */
void *sqlc_open(const uint8_t *path, size_t len, int32_t flags) {
  sqlc_init();
  char *z = dup_z(path, len);
  if (!z) return NULL;
  sqlite3 *db = NULL;
  sqlite3_open_v2(z, &db, flags, NULL);
  free(z);
  if (db) sqlite3_extended_result_codes(db, 1);
  return db;
}

int32_t sqlc_close(void *db) { return sqlite3_close_v2((sqlite3 *)db); }

int32_t sqlc_errcode(void *db) { return db ? sqlite3_extended_errcode((sqlite3 *)db) : SQLITE_NOMEM; }

int32_t sqlc_errmsg(void *db, uint8_t *buf, size_t cap) {
  const char *s = db ? sqlite3_errmsg((sqlite3 *)db) : "out of memory";
  return copy_out(s, strlen(s), buf, cap);
}

/* Run one or more statements, ignoring any rows. */
int32_t sqlc_exec(void *db, const uint8_t *sql, size_t len) {
  char *z = dup_z(sql, len);
  if (!z) return SQLITE_NOMEM;
  int rc = sqlite3_exec((sqlite3 *)db, z, NULL, NULL, NULL);
  free(z);
  return rc;
}

int32_t sqlc_busy_timeout(void *db, int32_t ms) { return sqlite3_busy_timeout((sqlite3 *)db, ms); }
void sqlc_interrupt(void *db) { sqlite3_interrupt((sqlite3 *)db); }
int32_t sqlc_autocommit(void *db) { return sqlite3_get_autocommit((sqlite3 *)db); }
double sqlc_changes(void *db) { return (double)sqlite3_changes64((sqlite3 *)db); }
double sqlc_total_changes(void *db) { return (double)sqlite3_total_changes64((sqlite3 *)db); }

/* NaN when the rowid does not fit a JS number exactly; callers then use sqlc_last_rowid_i64 */
double sqlc_last_rowid_f64(void *db) {
  sqlite3_int64 v = sqlite3_last_insert_rowid((sqlite3 *)db);
  if (v > MAX_SAFE || v < -MAX_SAFE) return 0.0 / 0.0;
  return (double)v;
}
int64_t sqlc_last_rowid_i64(void *db) { return sqlite3_last_insert_rowid((sqlite3 *)db); }

/* ------------------------------------------------------------------------------------------ */
/* statements                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/* Prepares the first statement in `sql`. NULL on error OR when the text holds no statement
 * (comment/whitespace only); sqlc_last_rc() tells them apart. sqlc_tail() is the byte offset
 * where parsing stopped, so the caller can reject "multiple statements". */
void *sqlc_prepare(void *db, const uint8_t *sql, size_t len, int32_t flags) {
  sqlite3_stmt *st = NULL;
  const char *tail = NULL;
  int rc = sqlite3_prepare_v3((sqlite3 *)db, (const char *)sql, (int)len, (unsigned)flags, &st, &tail);
  sqlc_last_rc_value = rc;
  sqlc_tail_off = tail ? (int)(tail - (const char *)sql) : (int)len;
  return st;
}
int32_t sqlc_last_rc(void) { return sqlc_last_rc_value; }
int32_t sqlc_tail(void) { return sqlc_tail_off; }

int32_t sqlc_finalize(void *st) { return sqlite3_finalize((sqlite3_stmt *)st); }
int32_t sqlc_reset(void *st) { return sqlite3_reset((sqlite3_stmt *)st); }
int32_t sqlc_clear_bindings(void *st) { return sqlite3_clear_bindings((sqlite3_stmt *)st); }
int32_t sqlc_step(void *st) { return sqlite3_step((sqlite3_stmt *)st); }
int32_t sqlc_readonly(void *st) { return sqlite3_stmt_readonly((sqlite3_stmt *)st); }
int32_t sqlc_column_count(void *st) { return sqlite3_column_count((sqlite3_stmt *)st); }

int32_t sqlc_column_name(void *st, int32_t i, uint8_t *buf, size_t cap) {
  const char *s = sqlite3_column_name((sqlite3_stmt *)st, i);
  if (!s) return -1;
  return copy_out(s, strlen(s), buf, cap);
}

/* ------------------------------------------------------------------------------------------ */
/* binding (indexes are 1-based, as in SQLite)                                                */
/* ------------------------------------------------------------------------------------------ */

int32_t sqlc_bind_count(void *st) { return sqlite3_bind_parameter_count((sqlite3_stmt *)st); }

/* name of parameter i including its prefix (":a", "@a", "$a", "?NNN"), or -1 for anonymous "?" */
int32_t sqlc_bind_name(void *st, int32_t i, uint8_t *buf, size_t cap) {
  const char *s = sqlite3_bind_parameter_name((sqlite3_stmt *)st, i);
  if (!s) return -1;
  return copy_out(s, strlen(s), buf, cap);
}

int32_t sqlc_bind_null(void *st, int32_t i) { return sqlite3_bind_null((sqlite3_stmt *)st, i); }

/* A JS number: integral values within +-2^53 bind as INTEGER, everything else as REAL. */
int32_t sqlc_bind_number(void *st, int32_t i, double d) {
  if (d >= -9007199254740991.0 && d <= 9007199254740991.0 && (double)(int64_t)d == d) {
    return sqlite3_bind_int64((sqlite3_stmt *)st, i, (sqlite3_int64)d);
  }
  return sqlite3_bind_double((sqlite3_stmt *)st, i, d);
}

int32_t sqlc_bind_int64(void *st, int32_t i, int64_t v) { return sqlite3_bind_int64((sqlite3_stmt *)st, i, v); }

int32_t sqlc_bind_text(void *st, int32_t i, const uint8_t *p, size_t n) {
  if (n > 0x7fffffffu) return SQLITE_TOOBIG;
  if (n == 0) return sqlite3_bind_text((sqlite3_stmt *)st, i, "", 0, SQLITE_STATIC); /* NULL ptr would bind NULL */
  return sqlite3_bind_text((sqlite3_stmt *)st, i, (const char *)p, (int)n, SQLITE_TRANSIENT);
}

int32_t sqlc_bind_blob(void *st, int32_t i, const uint8_t *p, size_t n) {
  if (n > 0x7fffffffu) return SQLITE_TOOBIG;
  if (n == 0) return sqlite3_bind_zeroblob((sqlite3_stmt *)st, i, 0); /* NULL ptr would bind NULL */
  return sqlite3_bind_blob((sqlite3_stmt *)st, i, p, (int)n, SQLITE_TRANSIENT);
}

/* ------------------------------------------------------------------------------------------ */
/* row packing                                                                                */
/*                                                                                            */
/* One FFI call returns a whole row. Per column: 1 tag byte, then                             */
/*   NULL            nothing                                                                  */
/*   INT_AS_DOUBLE   8 bytes  float64 LE                                                      */
/*   FLOAT           8 bytes  float64 LE                                                      */
/*   TEXT / BLOB     4 bytes  uint32 LE length, then that many bytes                          */
/*   INT64           8 bytes  int64 LE                                                        */
/* ------------------------------------------------------------------------------------------ */

typedef struct {
  uint8_t *buf;
  size_t cap;
  size_t len;
  int overflow;
} Packer;

static void put(Packer *p, const void *src, size_t n) {
  if (!p->overflow && p->len + n <= p->cap) {
    if (n) memcpy(p->buf + p->len, src, n);
  } else {
    p->overflow = 1;
  }
  p->len += n; /* keep counting so the caller learns the size it needs */
}

/* Returns the size the packed row needs. The buffer content is valid only if that size <= cap. */
int32_t sqlc_row_pack(void *stp, uint8_t *buf, size_t cap, int32_t mode) {
  sqlite3_stmt *st = (sqlite3_stmt *)stp;
  Packer p = {buf, cap, 0, 0};
  int n = sqlite3_column_count(st);
  for (int i = 0; i < n; i++) {
    switch (sqlite3_column_type(st, i)) {
      case SQLITE_INTEGER: {
        sqlite3_int64 v = sqlite3_column_int64(st, i);
        if (!(mode & MODE_BIGINT) && v <= MAX_SAFE && v >= -MAX_SAFE) {
          uint8_t tag = TAG_INT_AS_DOUBLE;
          double d = (double)v;
          put(&p, &tag, 1);
          put(&p, &d, 8);
        } else {
          uint8_t tag = TAG_INT64;
          put(&p, &tag, 1);
          put(&p, &v, 8);
        }
        break;
      }
      case SQLITE_FLOAT: {
        uint8_t tag = TAG_FLOAT;
        double d = sqlite3_column_double(st, i);
        put(&p, &tag, 1);
        put(&p, &d, 8);
        break;
      }
      case SQLITE_TEXT: {
        uint8_t tag = TAG_TEXT;
        const unsigned char *t = sqlite3_column_text(st, i); /* text first, then bytes (SQLite docs) */
        uint32_t len = (uint32_t)sqlite3_column_bytes(st, i);
        put(&p, &tag, 1);
        put(&p, &len, 4);
        put(&p, t, len);
        break;
      }
      case SQLITE_BLOB: {
        uint8_t tag = TAG_BLOB;
        const void *b = sqlite3_column_blob(st, i);
        uint32_t len = (uint32_t)sqlite3_column_bytes(st, i);
        put(&p, &tag, 1);
        put(&p, &len, 4);
        if (len) put(&p, b, len);
        break;
      }
      default: {
        uint8_t tag = TAG_NULL;
        put(&p, &tag, 1);
        break;
      }
    }
  }
  return (int32_t)p.len;
}

/* step + pack in one call.
 *   >= 0   a row; the value is the packed size (if > cap, call sqlc_row_pack with a bigger buffer)
 *   -1     SQLITE_DONE
 *   <= -2  error; the SQLite result code is (-ret - 1)                                         */
int32_t sqlc_step_pack(void *st, uint8_t *buf, size_t cap, int32_t mode) {
  int rc = sqlite3_step((sqlite3_stmt *)st);
  if (rc == SQLITE_ROW) return sqlc_row_pack(st, buf, cap, mode);
  if (rc == SQLITE_DONE) return -1;
  return -(rc + 1);
}
