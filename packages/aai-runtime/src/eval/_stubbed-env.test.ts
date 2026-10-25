// Copyright 2026 the AAI authors. MIT license.
import { agent } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { STUB_ENV_VALUE, stubbedEnv, stubProcessEnv } from "./_stubbed-env.ts";

/** An agent declaring one key, under a name no machine running this has. */
const app = agent({ name: "Keyless", requiredEnv: ["A_KEY_NOBODY_HAS"] });

describe("stubbedEnv", () => {
  test("in stub mode a declared key nobody has is the placeholder", () => {
    vi.stubEnv("A_KEY_NOBODY_HAS", undefined);
    expect(stubbedEnv(app, "stub").A_KEY_NOBODY_HAS).toBe(STUB_ENV_VALUE);
  });

  test("in live mode it is left missing — a placeholder there would be a 401 blamed on the provider", () => {
    vi.stubEnv("A_KEY_NOBODY_HAS", undefined);
    expect(stubbedEnv(app, "live")).not.toHaveProperty("A_KEY_NOBODY_HAS");
  });

  test("a key this machine HAS is passed through as it is, in either mode", () => {
    vi.stubEnv("A_KEY_NOBODY_HAS", "real-key");
    expect(stubbedEnv(app, "stub").A_KEY_NOBODY_HAS).toBe("real-key");
    expect(stubbedEnv(app, "live").A_KEY_NOBODY_HAS).toBe("real-key");
  });
});

describe("stubProcessEnv", () => {
  test("in stub mode a declared key nobody has becomes the placeholder in process.env", () => {
    vi.stubEnv("A_KEY_NOBODY_HAS", undefined);
    stubProcessEnv(app, "stub");
    expect(process.env.A_KEY_NOBODY_HAS).toBe(STUB_ENV_VALUE);
  });

  test("a key this machine HAS is left alone", () => {
    vi.stubEnv("A_KEY_NOBODY_HAS", "real-key");
    stubProcessEnv(app, "stub");
    expect(process.env.A_KEY_NOBODY_HAS).toBe("real-key");
  });

  test("in live mode nothing is written — the mode was chosen because nothing was missing", () => {
    vi.stubEnv("A_KEY_NOBODY_HAS", undefined);
    stubProcessEnv(app, "live");
    expect(process.env.A_KEY_NOBODY_HAS).toBeUndefined();
  });
});
