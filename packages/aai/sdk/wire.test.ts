import { describe, expect, test } from "vitest";
import { C2S, ERROR_CODE, errorCodeFromByte, errorCodeToByte, S2C } from "./wire.ts";

describe("wire type codes", () => {
  test("client→server codes are in 0x00-0x7F", () => {
    for (const v of Object.values(C2S)) expect(v).toBeLessThanOrEqual(0x7f);
  });
  test("server→client codes are in 0x80-0xFF", () => {
    for (const v of Object.values(S2C)) expect(v).toBeGreaterThanOrEqual(0x80);
  });
  test("type codes are unique per direction", () => {
    expect(new Set(Object.values(C2S)).size).toBe(Object.values(C2S).length);
    expect(new Set(Object.values(S2C)).size).toBe(Object.values(S2C).length);
  });
});

describe("error code mapping", () => {
  test("round-trips through name/byte", () => {
    for (const [name, byte] of Object.entries(ERROR_CODE)) {
      expect(errorCodeToByte(name as keyof typeof ERROR_CODE)).toBe(byte);
      expect(errorCodeFromByte(byte)).toBe(name);
    }
  });
  test("unknown byte returns undefined", () => {
    expect(errorCodeFromByte(0xff)).toBeUndefined();
  });
});
