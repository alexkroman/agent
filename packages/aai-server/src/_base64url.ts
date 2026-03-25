// Copyright 2025 the AAI authors. MIT license.

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64url"));
}
