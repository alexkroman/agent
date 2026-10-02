// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { missingEnvMessage } from "./_missing-env.ts";
import { requireEnv } from "./require-env.ts";

describe("requireEnv", () => {
  test("answers the value when it is set", () => {
    expect(requireEnv({ env: { NOTES_API_KEY: "k_1" } }, "NOTES_API_KEY")).toBe("k_1");
  });

  test("throws by NAME when the variable is absent", () => {
    expect(() => requireEnv({ env: {} }, "NOTES_API_KEY")).toThrow(
      missingEnvMessage("NOTES_API_KEY"),
    );
  });

  test("treats an empty string as missing — a blank secret is not a credential", () => {
    expect(() => requireEnv({ env: { NOTES_API_KEY: "" } }, "NOTES_API_KEY")).toThrow(
      /Missing NOTES_API_KEY/,
    );
  });
});
