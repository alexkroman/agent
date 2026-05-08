// Copyright 2025 the AAI authors. MIT license.

export function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function base64ToUint8(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}
