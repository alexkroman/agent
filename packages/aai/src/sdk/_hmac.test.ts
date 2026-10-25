// Copyright 2026 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { hmacSha256 } from "./_hmac.ts";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

test("is HMAC-SHA256 — RFC 4231 test case 2", async () => {
  const mac = await hmacSha256(new TextEncoder().encode("Jefe"), "what do ya want for nothing?");
  expect(hex(mac)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  expect(mac).toHaveLength(32);
});

test("a different key or text is a different MAC", async () => {
  const text = "payload";
  const a = await hmacSha256(new TextEncoder().encode("k1"), text);
  const b = await hmacSha256(new TextEncoder().encode("k2"), text);
  const c = await hmacSha256(new TextEncoder().encode("k1"), `${text}.`);
  expect(hex(a)).not.toBe(hex(b));
  expect(hex(a)).not.toBe(hex(c));
});
