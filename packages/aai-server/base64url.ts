// Copyright 2025 the AAI authors. MIT license.

/**
 * Test support only: production code no longer encodes base64url (the legacy
 * PBKDF2 verify path only decodes), but tests use this to build fixtures.
 */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64url"));
}
