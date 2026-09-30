// Copyright 2026 the AAI authors. MIT license.
import { defaultClientConditions, defaultServerConditions } from "vite";
import { describe, expect, test } from "vitest";
import { devSourceEnabled, devSourceViteConfig } from "./_dev-source.ts";

describe("devSourceEnabled", () => {
  test.each(["1", "true", "YES", " on "])("%j turns it on", (value) => {
    expect(devSourceEnabled({ AAI_DEV_SOURCE: value })).toBe(true);
  });

  test.each([undefined, "", "0", "false", "no", "src"])("%j leaves it off", (value) => {
    expect(devSourceEnabled({ AAI_DEV_SOURCE: value })).toBe(false);
  });
});

describe("devSourceViteConfig", () => {
  test("is empty when off, so an installed project's resolution is untouched", () => {
    expect(devSourceViteConfig({})).toEqual({});
  });

  test("adds @dev/source to BOTH resolvers without dropping Vite's defaults", () => {
    // `resolve.conditions` replaces the defaults, so a bare ["@dev/source"]
    // would drop `node`/`module` for every third-party package.
    expect(devSourceViteConfig({ AAI_DEV_SOURCE: "1" })).toEqual({
      resolve: { conditions: [...defaultClientConditions, "@dev/source"] },
      ssr: { resolve: { conditions: [...defaultServerConditions, "@dev/source"] } },
    });
  });
});
