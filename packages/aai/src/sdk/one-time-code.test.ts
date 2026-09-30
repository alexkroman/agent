// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test, vi } from "vitest";

import { codeMatches, hashCode, mintDigitCode } from "./one-time-code.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mintDigitCode", () => {
  test("six digits by default, as a string", () => {
    const code = mintDigitCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  test("keeps leading zeros and honours the length", () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.fill(0);
        return array;
      },
    );
    expect(mintDigitCode(4)).toBe("0000");
  });

  test("re-draws a byte at or above 250 instead of folding it (no modulo bias)", () => {
    // 250..255 would map to 0..5 under a bare `% 10`; they must be skipped.
    const rounds = [
      [250, 251, 252, 253, 254, 255, 7, 8],
      [9, 1, 2, 3, 4, 5, 6, 7],
    ];
    let round = 0;
    vi.spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) {
          const bytes = rounds[round++] ?? [];
          for (let i = 0; i < array.length; i++) array[i] = bytes[i] ?? 0;
        }
        return array;
      },
    );
    expect(mintDigitCode(4)).toBe("7891");
  });

  test("every digit is drawn about equally often", () => {
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 2000; i++) {
      for (const d of mintDigitCode(10)) counts[Number(d)] = (counts[Number(d)] ?? 0) + 1;
    }
    // 20,000 digits, 2,000 expected each; a loose band that a real bias would still break.
    for (const n of counts) expect(n).toBeGreaterThan(1700);
    for (const n of counts) expect(n).toBeLessThan(2300);
  });

  test.each([0, -1, 33, 2.5, Number.NaN])("refuses digits=%s", (digits) => {
    expect(() => mintDigitCode(digits)).toThrow(RangeError);
  });
});

describe("hashCode", () => {
  test("is SHA-256 as lower-case hex", async () => {
    expect(await hashCode("123456")).toBe(
      "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
    );
  });

  test("hashes exactly the string given — it does not normalize", async () => {
    expect(await hashCode("123 456")).not.toBe(await hashCode("123456"));
  });
});

describe("codeMatches", () => {
  test.each(["123456", "123 456", "123-456", "it's 1 2 3 4 5 6"])(
    "matches the read-back %j",
    async (said) => {
      expect(await codeMatches(said, await hashCode("123456"))).toBe(true);
    },
  );

  test("a wrong code does not match", async () => {
    expect(await codeMatches("123457", await hashCode("123456"))).toBe(false);
  });

  test("ignores the stored hash's hex case", async () => {
    const upper = (await hashCode("048190")).toUpperCase();
    expect(await codeMatches("0 4 8 1 9 0", upper)).toBe(true);
  });

  test("a read-back with no digits never matches, even the empty string's hash", async () => {
    expect(await codeMatches("I don't know", await hashCode(""))).toBe(false);
  });

  test("a code minted and hashed round-trips through a spoken read-back", async () => {
    const code = mintDigitCode();
    const stored = await hashCode(code);
    expect(await codeMatches(code.split("").join(" "), stored)).toBe(true);
  });
});
