const decoder = new TextDecoder();

export function decodeUtf8(buf: Uint8Array, start: number, end: number): string {
  return decoder.decode(buf.subarray(start, end));
}

/**
 * Calls `fill` with a scratch buffer and returns the string it wrote. The native side reports the length it
 * needs, so a result larger than the first buffer simply triggers one retry with an exact-size buffer.
 */
export function readOutString(fill: (buf: Uint8Array) => number): string {
  let buf = new Uint8Array(256);
  let n = fill(buf);
  if (n > buf.length) {
    buf = new Uint8Array(n);
    n = fill(buf);
  }
  return n <= 0 ? "" : decodeUtf8(buf, 0, n);
}
