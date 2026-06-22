// Copyright 2025 the AAI authors. MIT license.

export function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function base64ToUint8(base64: string): Uint8Array {
  // Return a plain Uint8Array view (not a Buffer) over the decoded bytes —
  // zero-copy, but preserves the exact return type callers/tests expect.
  const buf = Buffer.from(base64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
