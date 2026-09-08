// Copyright 2026 the AAI authors. MIT license.
/**
 * A deployment target BUILDS in a project that installed no optional peer.
 *
 * The failure this pins shipped: `vercel deploy` of a scaffolded project died
 * with twelve `[MISSING_EXPORT]` errors out of
 * `@alexkroman1/aai-runtime/dist/_tracing-otel-*.js`, one per name it imported
 * from the five OpenTelemetry packages. The entry here bundles
 * `@alexkroman1/aai-cli/start`, which calls `startTracing`, whose dynamic
 * `import()` of the OTel module is INLINED by this bundle's own settings
 * (`ssr: { noExternal: true }`, `codeSplitting: false`) — so that module's
 * imports had to resolve at the user's build time, against a project that never
 * installed a peer it never enabled. Vite answers with a stub that exports
 * nothing and rolldown checks every named binding against it.
 *
 * `check:optional-peers` is the fast half of the answer and states the rule an
 * author has to follow. This is the half that cannot be reasoned around: it
 * runs the real bundler over the real published `dist`, in a project shaped
 * like a user's.
 *
 * ## The entry ARMS tracing, deliberately
 *
 * Whether a target's own entry reaches the tracing gate is a TREE-SHAKING
 * decision: `start.js` imports `startTracing` at its top level, and today
 * rolldown drops that import because `createProjectServer` is the only export
 * the entry uses and `@alexkroman1/aai-runtime` declares `sideEffects: false`.
 * That decision is not the property under test — it is what made the shipped
 * failure look impossible from inside this repo — so the entry adds the call
 * itself. A test that let the bundler decide whether to include the module
 * would go quiet the day the answer changed, which is the exact shape of gate
 * this repo keeps paying for.
 *
 * ## Why the runtime is COPIED and not linked
 *
 * Resolution follows a symlink to its realpath, so a linked
 * `@alexkroman1/aai-runtime` resolves `@opentelemetry/api` from
 * `packages/aai-runtime/node_modules`, where this workspace's devDependency
 * really is — which is exactly why every existing build test passes while a
 * user's fails. Copying the package out of the workspace and re-linking its
 * dependencies MINUS the optional peers is what reproduces the install a user
 * has. The stub's own message in the output is what proves it worked; without
 * that assertion a fixture that quietly resolved the peers would pass forever.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { bundleTargetEntry } from "./_target-bundle.ts";
import { linkSdkNodeModules, silenced, withTempDir } from "./_test-utils.ts";
import { VERCEL_ENTRY_SOURCE } from "./_vercel-target.ts";

const PACKAGES = path.resolve(import.meta.dirname, "../..");

/** The optional peers a user's project has no reason to have installed. */
const ABSENT = "@opentelemetry";

/** Symlink every entry of `from` into `into`, skipping the ones named. */
async function linkEach(from: string, into: string, skip: string[]): Promise<void> {
  await fs.mkdir(into, { recursive: true });
  for (const entry of await fs.readdir(from)) {
    if (skip.includes(entry)) continue;
    await fs.symlink(path.join(from, entry), path.join(into, entry), "dir");
  }
}

/**
 * A project that resolves the CLI and the SDK, with a runtime that CANNOT
 * resolve its optional peers.
 */
async function projectWithoutOptionalPeers(dir: string): Promise<void> {
  await linkSdkNodeModules(dir);
  const real = await fs.realpath(path.join(dir, "node_modules"));
  await fs.rm(path.join(dir, "node_modules"), { force: true });
  await linkEach(real, path.join(dir, "node_modules"), ["@alexkroman1"]);

  const scope = path.join(dir, "node_modules", "@alexkroman1");
  await fs.mkdir(scope, { recursive: true });
  for (const pkg of ["aai", "aai-ui", "aai-cli"]) {
    await fs.symlink(path.join(PACKAGES, pkg), path.join(scope, pkg), "dir");
  }

  // The runtime, as a real directory: its published `dist`, its manifest, and
  // its own dependencies re-linked without the peers.
  const runtime = path.join(scope, "aai-runtime");
  const source = path.join(PACKAGES, "aai-runtime");
  await fs.mkdir(runtime, { recursive: true });
  await fs.cp(path.join(source, "dist"), path.join(runtime, "dist"), { recursive: true });
  await fs.copyFile(path.join(source, "package.json"), path.join(runtime, "package.json"));
  await linkEach(path.join(source, "node_modules"), path.join(runtime, "node_modules"), [ABSENT]);

  await fs.mkdir(path.join(dir, ".aai"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".aai", "worker.mjs"),
    `export default { name: "Peerless Probe", systemPrompt: "hi", greeting: "hi", tools: {} };\n`,
  );
  await fs.writeFile(path.join(dir, ".env.example"), "ASSEMBLYAI_API_KEY=\n");
}

/**
 * The real Vercel entry, plus the one call that puts the OTel graph in the
 * bundle — see "The entry ARMS tracing" above. Imports hoist, so prepending the
 * statement to the generated source is still the generated source.
 */
const ENTRY_ARMING_TRACING = `import { startTracing } from "@alexkroman1/aai-runtime/tracing";
await startTracing();
${VERCEL_ENTRY_SOURCE}`;

describe("a deployment target's entry, built without the optional peers", () => {
  test("builds, and carries Vite's stub rather than a MISSING_EXPORT failure", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await projectWithoutOptionalPeers(dir);

        // The whole assertion is that this RESOLVES: the shipped failure was a
        // build error, so a rejection here is the regression.
        const code = await bundleTargetEntry(dir, ENTRY_ARMING_TRACING, "vercel");

        // LIVENESS, and the load-bearing half. Vite emits its optional-peer
        // stub only for a peer it could not resolve, so this line is proof the
        // fixture really is missing them — a project that quietly resolved the
        // peers would build clean and assert nothing at all.
        expect(code).toContain('Could not resolve "@opentelemetry/api"');
        expect(code).toContain("export { handler as default }");
      }),
    );
  }, 120_000);
});
