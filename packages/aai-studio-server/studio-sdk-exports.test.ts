// Copyright 2025 the AAI authors. MIT license.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  _resetSdkSubpathCache,
  SDK_PACKAGE,
  sdkSpecifiers,
  sdkSubpaths,
} from "./studio-sdk-exports.ts";

afterEach(() => {
  _resetSdkSubpathCache();
});

/**
 * A throwaway project tree with an installed SDK whose exports map we choose.
 * The real map is well-behaved, so it can only exercise the happy path — every
 * "unreadable map" branch exists for a package.json this test has to author.
 */
describe("with a synthetic installed SDK", () => {
  let root = "";
  /** Deep enough that finding the SDK requires walking up several levels. */
  let startDir = "";

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "aai-sdk-exports-"));
    startDir = path.join(root, "project", "src", "deep");
    mkdirSync(startDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Install `contents` as the SDK's package.json at the tree root. */
  function installSdk(contents: string) {
    const dir = path.join(root, "node_modules", "@alexkroman1", "aai");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), contents);
  }

  test("walks up from the start dir to the installed package", () => {
    // The SDK sits three levels above `startDir`, so a lookup that only ever
    // probed the start directory — or gave up after one miss — finds nothing.
    installSdk(JSON.stringify({ exports: { ".": {}, "./llm": {} } }));
    expect(sdkSubpaths(startDir)).toEqual(["", "llm"]);
  });

  test("puts the root entry first and sorts the rest alphabetically", () => {
    // Declared out of order on purpose: the prompt lists these to the coding
    // agent, so a stable, readable order is the whole point.
    installSdk(
      JSON.stringify({
        exports: { "./stt": {}, "./manifest": {}, ".": {}, "./llm": {}, "./tts": {} },
      }),
    );
    expect(sdkSubpaths(startDir)).toEqual(["", "llm", "manifest", "stt", "tts"]);
  });

  test("sorts correctly when the root entry is declared last", () => {
    installSdk(JSON.stringify({ exports: { "./tts": {}, "./llm": {}, ".": {} } }));
    expect(sdkSubpaths(startDir)).toEqual(["", "llm", "tts"]);
  });

  test("keeps only the root and `./`-prefixed keys", () => {
    // An exports map carries non-subpath keys too; advertising them would
    // teach the agent import specifiers that cannot resolve.
    installSdk(
      JSON.stringify({
        exports: { ".": {}, "./llm": {}, types: "./dist/index.d.ts", import: "./dist/index.js" },
      }),
    );
    expect(sdkSubpaths(startDir)).toEqual(["", "llm"]);
  });

  test.each([
    ["a map that is a string", JSON.stringify({ exports: "./dist/index.js" })],
    ["a null map", JSON.stringify({ exports: null })],
    ["no exports field at all", JSON.stringify({ name: "@alexkroman1/aai" })],
    ["unparsable JSON", "{ not json"],
    ["an empty file", ""],
  ])("fails open on %s", (_label, contents) => {
    // Empty means "unknown": callers skip their check rather than reject, so
    // an unreadable map can never turn a legal import into a build error.
    installSdk(contents);
    expect(sdkSubpaths(startDir)).toEqual([]);
  });

  test("memoizes the first successful read", () => {
    installSdk(JSON.stringify({ exports: { ".": {}, "./llm": {} } }));
    expect(sdkSubpaths(startDir)).toEqual(["", "llm"]);
    // A different start dir with no SDK above it still gets the cached list —
    // the map is fixed for the process lifetime.
    expect(sdkSubpaths("/")).toEqual(["", "llm"]);
  });

  test("renders specifiers from a synthetic map", () => {
    installSdk(JSON.stringify({ exports: { ".": {}, "./llm": {} } }));
    expect(sdkSpecifiers(startDir)).toEqual([SDK_PACKAGE, `${SDK_PACKAGE}/llm`]);
  });
});

describe("sdkSubpaths", () => {
  test("names the SDK package it reads", () => {
    expect(SDK_PACKAGE).toBe("@alexkroman1/aai");
  });

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
    // No key survives with its `./` prefix intact.
    expect(subpaths.every((s) => !s.startsWith("."))).toBe(true);
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
