// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { analyticsBootEnv } from "./analytics-boot.ts";

describe("analyticsBootEnv", () => {
  test("names the four keys the guest's shipper reads", () => {
    expect(
      analyticsBootEnv({
        url: "https://platform.test/analytics/ingest",
        token: "tok",
        slug: "demo",
        version: 7,
      }),
    ).toEqual({
      AAI_ANALYTICS_URL: "https://platform.test/analytics/ingest",
      AAI_ANALYTICS_TOKEN: "tok",
      AAI_ANALYTICS_SLUG: "demo",
      AAI_ANALYTICS_VERSION: "7",
    });
  });

  // The guest reads these out of an environment, where everything is a
  // string — a version stamped as a number would reach it as `"[object
  // Object]"`-class garbage or, worse, as `"0"` for a falsy generation.
  test("stringifies version 0 rather than dropping it", () => {
    const env = analyticsBootEnv({ url: "https://p/i", token: "t", slug: "s", version: 0 });
    expect(env.AAI_ANALYTICS_VERSION).toBe("0");
  });
});
