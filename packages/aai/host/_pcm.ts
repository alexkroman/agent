// Copyright 2026 the AAI authors. MIT license.
/** Shared PCM16 audio byte conversion. */

/**
 * View audio bytes as PCM16 LE samples. Zero-copy when the view is
 * 2-byte aligned; otherwise copies, dropping a trailing odd byte.
 */
export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const { byteOffset: offset, byteLength: length } = bytes;
  if (offset % 2 === 0 && length % 2 === 0) {
    return new Int16Array(bytes.buffer, offset, length / 2);
  }
  const copy = new Uint8Array(length - (length % 2));
  copy.set(bytes.subarray(0, copy.byteLength));
  return new Int16Array(copy.buffer);
}
