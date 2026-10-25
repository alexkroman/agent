// Copyright 2026 the AAI authors. MIT license.
/**
 * A deploy-shaped worker carries only the speech SDKs its agent declares —
 * the end-to-end half of `_vendor-openers.ts`, over real runtime-bearing
 * builds of small fixtures. Scenario tier: a bundler, three times.
 *
 * The unit spec holds the table and the plugin's hooks; this one holds what
 * they add up to in a bundle Vite actually resolved: the vendor's own modules
 * are absent, the trimmed worker still loads and exports the runtime factory
 * (the stub throws only when a session opens the stage, never at import), and
 * `buildAgentBundle` reads the agent's own config to decide.
 */

import { expect } from "vitest";
import { buildAgentBundle, importWorkerModule } from "./_bundler.ts";
import { linkSdkNodeModules, test, writeFiles } from "./_test-utils.ts";
import { VENDOR_OPENERS } from "./_vendor-openers.ts";
import { buildWorker } from "./worker-bundler.ts";

/**
 * The bundler's own `//#region <path>` marker for a module of `pkg` — the one
 * trace of a vendor SDK that a doc comment quoting its name cannot fake.
 * Unminified builds only, which is why every build here is one.
 */
const regionOf = (pkg: string): RegExp =>
  new RegExp(`^//#region .*node_modules/${pkg.replace(/[/@.]/g, "\\$&")}/`, "m");

/** A project whose `agent.ts` is `body`, with the SDK resolvable. */
async function project(dir: string, body: string): Promise<void> {
  await linkSdkNodeModules(dir);
  await writeFiles(dir, { "agent.ts": body });
}

test("a worker without the vendors its agent cannot reach drops their SDKs and still loads", async ({
  tmpDir: dir,
}) => {
  await project(
    dir,
    'import { agent } from "@alexkroman1/aai";\nexport default agent({ name: "Trim" });\n',
  );
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
  // The regions above are the claim; this only says the bytes went with them.
  expect(trimmed.length).toBeLessThan(full.length);

  const mod = await importWorkerModule(trimmed);
  expect(typeof mod.__aaiCreateRuntime).toBe("function");
  expect((mod.__aaiConfig as { stt?: { kind?: string } }).stt?.kind).toBe("assemblyai");
});

test("a deploy build reads the agent's own config: a declared vendor stays in", async ({
  tmpDir: dir,
}) => {
  await project(
    dir,
    `import { agent } from "@alexkroman1/aai";
import { deepgramStt } from "@alexkroman1/aai/stt";
export default agent({ name: "Keep", stt: deepgramStt() });
`,
  );
  const { worker, config } = await buildAgentBundle(dir, { minify: false });
  expect((config as { stt?: { kind?: string } }).stt?.kind).toBe("deepgram");
  for (const entry of VENDOR_OPENERS) {
    const kept = entry.kind === "deepgram";
    for (const pkg of entry.packages) {
      expect(regionOf(pkg).test(worker), `${pkg} ${kept ? "kept" : "left out"}`).toBe(kept);
    }
    expect(worker.includes(`${entry.label} was left out of this bundle`)).toBe(!kept);
  }
});
