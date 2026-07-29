// Copyright 2025 the AAI authors. MIT license.

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

export function fromBase64Url(str: string): Uint8Array {
  // Buffer.from silently drops characters outside the base64url alphabet,
  // so garbage input would decode to *something* and flow onward (into
  // decryptEnv). Reject it loudly instead — every legitimate caller passes
  // strings produced by toBase64Url.
  if (!BASE64URL_RE.test(str)) {
    throw new Error("Invalid base64url string");
  }
  return new Uint8Array(Buffer.from(str, "base64url"));
}
