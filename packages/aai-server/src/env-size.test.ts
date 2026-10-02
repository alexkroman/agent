// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { MAX_ENV_SIZE } from "./constants.ts";
import { assertEnvFits, EnvTooLargeError, envSize } from "./env-size.ts";

describe("envSize", () => {
  test("is the UTF-8 byte length of the serialized record", () => {
    expect(envSize({})).toBe(2);
    expect(envSize({ A: "b" })).toBe('{"A":"b"}'.length);
    // A two-byte character counts as two bytes, not one code unit.
    expect(envSize({ A: "é" })).toBe(envSize({ A: "e" }) + 1);
  });
});

describe("assertEnvFits", () => {
  const filler = (size: number) => ({ A: "x".repeat(size - envSize({ A: "" })) });

  test("a record exactly at the limit fits", () => {
    expect(() => assertEnvFits(filler(MAX_ENV_SIZE), "Secrets for agent a")).not.toThrow();
  });

  test("one byte over throws a typed error with the byte counts and no value", () => {
    const assertOver = () => assertEnvFits({ ...filler(MAX_ENV_SIZE + 1) }, "Secrets for agent a");
    expect(assertOver).toThrow(EnvTooLargeError);
    expect(assertOver).toThrow(
      expect.objectContaining({
        name: "EnvTooLargeError",
        size: MAX_ENV_SIZE + 1,
        limit: MAX_ENV_SIZE,
        message: `Secrets for agent a would be ${MAX_ENV_SIZE + 1} bytes, over the ${MAX_ENV_SIZE}-byte limit for secrets`,
      }),
    );
  });
});
