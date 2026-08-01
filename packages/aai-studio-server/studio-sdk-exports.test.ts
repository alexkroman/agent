// Copyright 2025 the AAI authors. MIT license.

import { afterEach, describe, expect, test } from "vitest";
import {
  _resetSdkSubpathCache,
  SDK_PACKAGE,
  sdkSpecifiers,
  sdkSubpaths,
} from "./studio-sdk-exports.ts";

afterEach(() => {
  _resetSdkSubpathCache();
});

describe("sdkSubpaths", () => {
  test("reads the real SDK exports map", () => {
    const subpaths = sdkSubpaths();
    // The root entry sorts first and is spelled "" (not ".").
    expect(subpaths[0]).toBe("");
    // A representative spread of the map.
    expect(subpaths).toContain("llm");
    expect(subpaths).toContain("stt");
    expect(subpaths).toContain("manifest");
    // The removed combinator subpaths must NOT appear — if either ever does,
    // the studio's prompt and its build error would both start advertising
    // it again.
    expect(subpaths).not.toContain("patterns");
    expect(subpaths).not.toContain("workflow");
  });

  test("returns [] when no installed SDK is above the start dir", () => {
    // Fails open: an unreadable map means "unknown", never "nothing allowed".
    expect(sdkSubpaths("/")).toEqual([]);
  });
});

describe("sdkSpecifiers", () => {
  test("renders full bare specifiers, root as the bare package name", () => {
    const specs = sdkSpecifiers();
    expect(specs[0]).toBe(SDK_PACKAGE);
    expect(specs).toContain(`${SDK_PACKAGE}/llm`);
    expect(specs).not.toContain(`${SDK_PACKAGE}/workflow`);
    // No "@alexkroman1/aai/" with an empty tail.
    expect(specs.every((s) => !s.endsWith("/"))).toBe(true);
  });
});
