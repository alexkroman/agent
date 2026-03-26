// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { fromBase64Url, toBase64Url } from "./_base64url.ts";

describe("toBase64Url", () => {
  test("encodes known bytes correctly", () => {
    const bytes = new TextEncoder().encode("Hello, World!");
    expect(toBase64Url(bytes)).toBe("SGVsbG8sIFdvcmxkIQ");
  });

  test("handles empty Uint8Array", () => {
    expect(toBase64Url(new Uint8Array())).toBe("");
  });

  test("produces URL-safe output (no +, /, or = padding)", () => {
    // Bytes that would produce +, /, and = in standard base64
    const bytes = new Uint8Array([251, 255, 254, 63, 62]);
    const result = toBase64Url(bytes);
    expect(result).not.toMatch(/[+/=]/);
  });
});

describe("fromBase64Url", () => {
  test("decodes back to original bytes", () => {
    const decoded = fromBase64Url("SGVsbG8sIFdvcmxkIQ");
    expect(new TextDecoder().decode(decoded)).toBe("Hello, World!");
  });

  test("handles empty string", () => {
    const result = fromBase64Url("");
    expect(result).toEqual(new Uint8Array());
  });

  test("handles strings with URL-safe characters (- and _)", () => {
    // "-" replaces "+", "_" replaces "/" in base64url
    const encoded = toBase64Url(new Uint8Array([251, 255, 254, 63, 62]));
    const decoded = fromBase64Url(encoded);
    expect(decoded).toEqual(new Uint8Array([251, 255, 254, 63, 62]));
  });
});

describe("round-trip", () => {
  test("encode then decode preserves arbitrary binary data", () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const roundTripped = fromBase64Url(toBase64Url(original));
    expect(roundTripped).toEqual(original);
  });
});
