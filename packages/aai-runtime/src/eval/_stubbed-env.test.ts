// Copyright 2026 the AAI authors. MIT license.
import { agent } from "@alexkroman1/aai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { STUB_ENV_VALUE, stubbedEnv } from "./_stubbed-env.ts";

/** An agent declaring one key, under a name no machine running this has. */
const app = agent({ name: "Keyless", requiredEnv: ["A_KEY_NOBODY_HAS"] });

afterEach(() => {
  vi.unstubAllEnvs();
});

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
