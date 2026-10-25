// Copyright 2026 the AAI authors. MIT license.
/**
 * A deploy-shaped worker carries only the speech SDKs its agent declares —
 * the end-to-end half of `_vendor-openers.ts`, over two real runtime-bearing
 * builds of one fixture. Scenario tier: a bundler, twice.
 *
 * The unit spec holds the table and the plugin's hooks; this one holds what
 * they add up to in a bundle Vite actually resolved: the vendor's own marker
 * strings are absent, the bytes went with them, and the trimmed worker still
 * loads and exports the runtime factory — the stub throws only when a
 * session opens the stage, never at import.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect } from "vitest";
import { buildAgentBundle } from "./_bundler.ts";
import { linkSdkNodeModules, test } from "./_test-utils.ts";
import { VENDOR_OPENERS } from "./_vendor-openers.ts";
import { buildWorker } from "./worker-bundler.ts";

/**
 * The bundler's own `//#region <path>` marker for a module of `pkg` — the one
 * trace of a vendor SDK that a doc comment quoting its name cannot fake.
 * Unminified builds only, which is why the test builds that way.
 */
const regionOf = (pkg: string): RegExp =>
  new RegExp(`^//#region .*node_modules/${pkg.replace(/[/@.]/g, "\\$&")}/`, "m");

const AGENT = `import { agent } from "@alexkroman1/aai";\nexport default agent({ name: "Trim" });\n`;

describe("a worker without the vendors its agent cannot reach", () => {
  test("drops their SDKs, keeps loading, and keeps the runtime factory", async ({
    tmpDir: dir,
  }) => {
    await linkSdkNodeModules(dir);
    await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
    const kinds = VENDOR_OPENERS.map((entry) => entry.kind);

    const full = await buildWorker(dir, { minify: false });
    const trimmed = await buildWorker(dir, { minify: false, omitVendors: kinds });

    for (const entry of VENDOR_OPENERS) {
      for (const pkg of entry.packages) {
        expect(full, `${pkg} should be in the untrimmed worker`).toMatch(regionOf(pkg));
        expect(trimmed, `${pkg} should be out of the trimmed worker`).not.toMatch(regionOf(pkg));
      }
      // The stub stands where the opener was, and says so.
      expect(trimmed).toContain(`${entry.label} was left out of this bundle`);
    }
    // The point of the exercise, as a floor rather than a number: the three
    // SDKs were ~45% of the quickstart's minified worker when this landed.
    expect(trimmed.length).toBeLessThan(full.length * 0.7);

    const out = path.join(dir, "worker.mjs");
    await fs.writeFile(out, trimmed, "utf-8");
    const mod = (await import(pathToFileURL(out).href)) as {
      __aaiCreateRuntime?: unknown;
      __aaiConfig?: { stt?: { kind?: string } };
    };
    expect(typeof mod.__aaiCreateRuntime).toBe("function");
    expect(mod.__aaiConfig?.stt?.kind).toBe("assemblyai");
  });

  test("a deploy build reads the agent's own config: a declared vendor stays in", async ({
    tmpDir: dir,
  }) => {
    await linkSdkNodeModules(dir);
    await fs.writeFile(
      path.join(dir, "agent.ts"),
      `import { agent } from "@alexkroman1/aai";
` +
        `import { deepgramStt } from "@alexkroman1/aai/stt";
` +
        `export default agent({ name: "Keep", stt: deepgramStt() });
`,
      "utf-8",
    );
    const { worker } = await buildAgentBundle(dir, { minify: false });
    for (const entry of VENDOR_OPENERS) {
      const kept = entry.kind === "deepgram";
      for (const pkg of entry.packages) {
        expect(regionOf(pkg).test(worker), `${pkg} ${kept ? "kept" : "left out"}`).toBe(kept);
      }
      expect(worker.includes(`${entry.label} was left out of this bundle`)).toBe(!kept);
    }
  });
});
