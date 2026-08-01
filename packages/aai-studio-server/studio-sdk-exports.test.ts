// Copyright 2025 the AAI authors. MIT license.

import { afterEach, describe, expect, test } from "vitest";
import {
  _resetSdkSubpathCache,
  isKnownSdkSpecifier,
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

describe("isKnownSdkSpecifier", () => {
  test("accepts the root and real subpaths", () => {
    expect(isKnownSdkSpecifier(SDK_PACKAGE)).toBe(true);
    expect(isKnownSdkSpecifier(`${SDK_PACKAGE}/llm`)).toBe(true);
    expect(isKnownSdkSpecifier(`${SDK_PACKAGE}/tts`)).toBe(true);
  });

  test("rejects the subpath that produced the unactionable rolldown error", () => {
    expect(isKnownSdkSpecifier(`${SDK_PACKAGE}/workflow`)).toBe(false);
    expect(isKnownSdkSpecifier(`${SDK_PACKAGE}/nope`)).toBe(false);
  });

  test("ignores specifiers for other packages", () => {
    // Not this module's business — `ALLOWED_PACKAGES` polices which packages
    // are importable at all.
    expect(isKnownSdkSpecifier("zod")).toBe(true);
    expect(isKnownSdkSpecifier("@alexkroman1/aai-ui")).toBe(true);
  });

  test("fails open when the exports map cannot be read", () => {
    // Diagnostics must never become policy: an unresolvable package.json has
    // to let the build proceed and report whatever Vite finds.
    expect(isKnownSdkSpecifier(`${SDK_PACKAGE}/workflow`, "/")).toBe(true);
  });
});
