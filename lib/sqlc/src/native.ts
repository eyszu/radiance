// Signature-only declarations for the C shim (native/sqlc.c). scriptc binds each one to the C symbol of the
// same name through sqlc.ffi.json. The TypeScript types follow the manifest's value classes:
//   i32 / f64 -> number    i64 / pointer -> bigint    string -> string    bytes / mutable-bytes -> Uint8Array
// A pointer is an opaque handle (0n is NULL). mutable-bytes buffers are written by C; the return value is
// the number of bytes needed, which may exceed the buffer length (the caller retries with a larger buffer).
//
// KEEP IN SYNC with sqlc.ffi.json: scripts/check-abi.sh verifies it and runs in `make check`.

export declare function sqlc_abi_version(): number;
export declare function sqlc_libversion_number(): number;
export declare function sqlc_libversion(out: Uint8Array): number;
export declare function sqlc_sourceid(out: Uint8Array): number;
export declare function sqlc_compileoption(i: number, out: Uint8Array): number;
export declare function sqlc_memory_used(): number;
export declare function sqlc_open(path: string, flags: number): bigint;
export declare function sqlc_close(handle: bigint): number;
export declare function sqlc_errcode(handle: bigint): number;
export declare function sqlc_errmsg(db: bigint, out: Uint8Array): number;
export declare function sqlc_exec(db: bigint, sql: string): number;
export declare function sqlc_busy_timeout(db: bigint, ms: number): number;
export declare function sqlc_interrupt(handle: bigint): void;
export declare function sqlc_autocommit(handle: bigint): number;
export declare function sqlc_changes(handle: bigint): number;
export declare function sqlc_total_changes(handle: bigint): number;
export declare function sqlc_last_rowid_f64(handle: bigint): number;
export declare function sqlc_last_rowid_i64(handle: bigint): bigint;
export declare function sqlc_prepare(db: bigint, sql: string, flags: number): bigint;
export declare function sqlc_last_rc(): number;
export declare function sqlc_tail(): number;
export declare function sqlc_finalize(handle: bigint): number;
export declare function sqlc_reset(handle: bigint): number;
export declare function sqlc_clear_bindings(handle: bigint): number;
export declare function sqlc_step(handle: bigint): number;
export declare function sqlc_readonly(handle: bigint): number;
export declare function sqlc_column_count(handle: bigint): number;
export declare function sqlc_column_name(stmt: bigint, index: number, out: Uint8Array): number;
export declare function sqlc_bind_count(handle: bigint): number;
export declare function sqlc_bind_name(stmt: bigint, index: number, out: Uint8Array): number;
export declare function sqlc_bind_null(stmt: bigint, index: number): number;
export declare function sqlc_bind_number(stmt: bigint, index: number, value: number): number;
export declare function sqlc_bind_int64(stmt: bigint, index: number, value: bigint): number;
export declare function sqlc_bind_text(stmt: bigint, index: number, value: string): number;
export declare function sqlc_bind_blob(stmt: bigint, index: number, value: Uint8Array): number;
export declare function sqlc_row_pack(stmt: bigint, out: Uint8Array, mode: number): number;
export declare function sqlc_step_pack(stmt: bigint, out: Uint8Array, mode: number): number;
