// Copyright 2025 the AAI authors. MIT license.

export function uint8ToBase64(bytes: Uint8Array): string {
  // Zero-copy view over the same memory — avoids duplicating every audio chunk.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function base64ToUint8(base64: string): Uint8Array {
  // Zero-copy Uint8Array view over the decoded Buffer's memory.
  const buf = Buffer.from(base64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
