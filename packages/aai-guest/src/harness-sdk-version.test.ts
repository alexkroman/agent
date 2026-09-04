// Copyright 2026 the AAI authors. MIT license.
/**
 * The boot line's version reader.
 *
 * Its whole output is a string in a log, which is the shape of thing that fails
 * silently: a resolver that stopped resolving still prints a line, just one
 * saying `(unresolved: …)` that nobody reads until the next incident. So the
 * happy path is asserted against a real directory tree, and both failure shapes
 * are asserted to REPORT rather than throw — the reader is on the path that
 * decides whether a guest listens at all.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { useTempDir } from "./_test-utils.ts";
import { guestSdkVersion } from "./harness-sdk-version.ts";

/** Write a `node_modules/@alexkroman1/aai/package.json` under `root`. */
function plantSdk(root: string, manifest: unknown): void {
  const dir = join(root, "node_modules", "@alexkroman1", "aai");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest), "utf-8");
}

describe("guestSdkVersion", () => {
  const dir = useTempDir("sdk-version-");

  test("reads the version of the SDK beside the harness", () => {
    plantSdk(dir(), { name: "@alexkroman1/aai", version: "9.9.9" });
    expect(guestSdkVersion(dir())).toBe("9.9.9");
  });

  /**
   * The resolution an agent's own bundle performs, which is the whole reason this
   * walks rather than resolves: the harness sits one or more levels BELOW the
   * `node_modules` that holds its SDK in both deployments (`/opt/aai` in the baked
   * image, this package's own in dev).
   */
  test("finds it in a node_modules ABOVE the starting directory", () => {
    plantSdk(dir(), { name: "@alexkroman1/aai", version: "8.8.8" });
    const nested = join(dir(), "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(guestSdkVersion(nested)).toBe("8.8.8");
  });

  /**
   * The nearer directory wins, and it has to: a workspace materialized under the
   * toolchain root can carry its own copy, and that copy is the one its bundle
   * loads. Answering with the outer one would report a version no agent runs.
   */
  test("prefers the NEAREST node_modules when two hold it", () => {
    plantSdk(dir(), { name: "@alexkroman1/aai", version: "1.0.0" });
    const inner = join(dir(), "workspace");
    mkdirSync(inner, { recursive: true });
    plantSdk(inner, { name: "@alexkroman1/aai", version: "2.0.0" });
    expect(guestSdkVersion(inner)).toBe("2.0.0");
  });

  test("keeps walking past a manifest that is some other package", () => {
    plantSdk(dir(), { name: "@alexkroman1/aai", version: "3.0.0" });
    const inner = join(dir(), "decoy");
    mkdirSync(inner, { recursive: true });
    plantSdk(inner, { name: "something-else", version: "0.0.1" });
    expect(guestSdkVersion(inner)).toBe("3.0.0");
  });

  /**
   * Both failure shapes REPORT. A throw here would fail `server.listen`'s
   * continuation and take a guest down over a diagnostic — the trade this reader's
   * doc rules out.
   */
  test("reports an unresolvable SDK instead of throwing", () => {
    expect(() => guestSdkVersion(dir())).not.toThrow();
    expect(guestSdkVersion(dir())).toMatch(/^\(unresolved: /);
  });

  test("reports a manifest with no version instead of throwing", () => {
    plantSdk(dir(), { name: "@alexkroman1/aai" });
    expect(guestSdkVersion(dir())).toBe("(no version in package.json)");
  });

  /**
   * The default argument is what production uses, and a spec that passed its own
   * `from` everywhere would never touch it. It must resolve to a real version in
   * this repo — the harness's own package has the SDK as a dependency.
   */
  test("resolves a real version from its own module directory by default", () => {
    expect(guestSdkVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
