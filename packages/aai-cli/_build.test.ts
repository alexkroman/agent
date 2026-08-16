// Copyright 2025 the AAI authors. MIT license.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { buildAgentBundle, evalWorkerBundle } from "./_bundler.ts";
import { linkSdkNodeModules, silenced, withTempDir } from "./_test-utils.ts";
import { executeBuild, WORKER_ARTIFACT_REL } from "./build.ts";

/** Import a built worker and return its `__aaiConfig` self-description. */
async function extractConfig(worker: string): Promise<Record<string, unknown>> {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(worker).toString("base64")}`);
  return mod.__aaiConfig as Record<string, unknown>;
}

/**
 * Most cases below pass `runtime: false`: they assert config self-description
 * and bundle shape, which are orthogonal to the runtime, and inlining the
 * runtime + provider SDKs takes ~10s per build. The deploy-shaped build
 * (runtime included) is covered by the dedicated "ships its runtime" test
 * and `executeBuild`, each with an explicit timeout.
 */
describe("buildAgentBundle", () => {
  test("throws when no agent.ts found", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
      await expect(silenced(() => buildAgentBundle(dir))(dir)).rejects.toThrow("agent.ts");
    });
  });

  test("bundles minimal agent with a self-describing config export", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "build-test-agent", systemPrompt: "Test prompt", greeting: "Hello", maxSteps: 5, tools: {} };`,
        );
        const bundle = await buildAgentBundle(dir, { runtime: false });
        const config = await extractConfig(bundle.worker);
        expect(config.name).toBe("build-test-agent");
        expect(config.systemPrompt).toBe("Test prompt");
        expect(config.greeting).toBe("Hello");
        expect(config.maxSteps).toBe(5);
        expect(config.toolSchemas).toEqual([]);
        expect(bundle.worker).toContain("export");
        expect(bundle.clientFiles).toEqual({});
      }),
    );
  });

  test("bundles agent with tools and self-describes their schemas", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `
import { z } from "zod";

const greetTool = {
  description: "Greet someone by name",
  inputSchema: z.object({ name: z.string() }),
  execute: ({ name }) => "Hello, " + name,
};

export default {
  name: "tool-test-agent",
  systemPrompt: "Test",
  greeting: "Hi",
  maxSteps: 5,
  tools: { greet: greetTool },
};
`,
        );
        const bundle = await buildAgentBundle(dir, { runtime: false });
        const config = await extractConfig(bundle.worker);
        expect(config.name).toBe("tool-test-agent");
        expect(config.toolSchemas).toEqual([
          {
            type: "function",
            name: "greet",
            description: "Greet someone by name",
            parameters: expect.objectContaining({ type: "object" }),
          },
        ]);
        // Worker should contain the tool code
        expect(bundle.worker).toContain("greet");
        expect(bundle.worker.length).toBeGreaterThan(50);
      }),
    );
  });

  test("minify option produces a smaller worker that still evaluates", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `const longDescriptiveVariableName = "Test prompt";
export default { name: "minify-test-agent", systemPrompt: longDescriptiveVariableName, greeting: "Hello", maxSteps: 5, tools: {} };`,
        );
        const plain = await buildAgentBundle(dir, { runtime: false });
        const minified = await buildAgentBundle(dir, { minify: true, runtime: false });
        // Minified bundle still evaluates to the same agent config.
        const config = await extractConfig(minified.worker);
        expect(config.name).toBe("minify-test-agent");
        expect(config.systemPrompt).toBe("Test prompt");
        // And it is no larger than the unminified build.
        expect(minified.worker.length).toBeLessThanOrEqual(plain.worker.length);
      }),
    );
  });

  test("Vite-bundled worker is valid ESM with default export", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "vite-test", systemPrompt: "Test", greeting: "Hi", maxSteps: 5, tools: {} };`,
        );
        const bundle = await buildAgentBundle(dir, { runtime: false });
        // Worker must be valid ESM — check for export syntax
        expect(bundle.worker).toMatch(/export/);
        // Must be a non-trivial bundle
        expect(bundle.worker.length).toBeGreaterThan(20);
      }),
    );
  });
});

describe("deploy-shaped build (runtime included)", () => {
  test("ships a working __aaiCreateRuntime factory", { timeout: 120_000 }, async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "runtime-ship", systemPrompt: "Test", greeting: "Hi", tools: {} };`,
        );
        const bundle = await buildAgentBundle(dir);
        // Evaluate exactly as the guest harness does: a real file import
        // (the bundled runtime's CJS interop rejects data: URLs).
        const agentDef = await evalWorkerBundle(bundle.worker);
        expect(agentDef.name).toBe("runtime-ship");

        const workerPath = path.join(dir, "worker-under-test.mjs");
        await writeFile(workerPath, bundle.worker, "utf-8");
        const mod = await import(pathToFileURL(workerPath).href);
        const factory = mod.__aaiCreateRuntime as (opts: Record<string, unknown>) => {
          startSession: unknown;
          shutdown: () => Promise<void>;
        };
        expect(typeof factory).toBe("function");
        // The factory builds a real runtime from the BUNDLED SDK — the
        // harness↔bundle contract: { env, db?, runCode? } in,
        // { startSession, shutdown } out.
        const runtime = factory({ env: { ASSEMBLYAI_API_KEY: "test-key" } });
        expect(typeof runtime.startSession).toBe("function");
        await runtime.shutdown();
      }),
    );
  });
});

describe("executeBuild", () => {
  test("returns the agent name and worker size", { timeout: 120_000 }, async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "exec-build", systemPrompt: "Test", greeting: "Hi", tools: {} };`,
        );
        // Skip the gates — this test covers the bundle+eval step, and the
        // temp project has no test file or tsconfig anyway.
        const result = await executeBuild({ cwd: dir, skipTests: true, skipTypecheck: true });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.name).toBe("exec-build");
          expect(result.data.workerBytes).toBeGreaterThan(20);
        }
      }),
    );
  });

  test("leaves the built worker on disk, importable, where server.mjs looks for it", {
    timeout: 120_000,
  }, async () => {
    // The self-hosting contract: `npm start` runs `aai build` and then
    // imports this exact path. The scaffold's `server.mjs` hardcodes it (it
    // cannot import from the CLI), so nothing but a test holds the two ends
    // together in-tree — the `npm start` leg of e2e.test.ts is the only tier
    // that runs both as a user does.
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "on-disk", systemPrompt: "Test", greeting: "Hi", tools: {} };`,
        );

        const result = await executeBuild({ cwd: dir, skipTests: true, skipTypecheck: true });

        const written = path.join(dir, WORKER_ARTIFACT_REL);
        expect(result.ok && result.data.worker).toBe(written);
        // Importable, not merely present: this is the module `npm start`
        // boots, and its default export is the agent with its tools already
        // attached by the generated entry.
        const mod = await import(pathToFileURL(written).href);
        expect((mod.default as { name: string }).name).toBe("on-disk");
      }),
    );
  });
});

describe("evalWorkerBundle", () => {
  // An explicit budget, like the two bundling specs above: this writes a temp
  // module and imports it, which is fast alone and not when the rest of this
  // file's Vite builds are running beside it. At the default 5s it was the one
  // test in the repo that failed under load and passed on a rerun — a flake
  // that reads as a broken change to whatever happens to be in flight.
  test("evaluates a worker bundle without touching the filesystem", {
    timeout: 30_000,
  }, async () => {
    const agent = await evalWorkerBundle(
      `export default { name: "evaled", systemPrompt: "p", greeting: "g", tools: {} };`,
    );
    expect(agent.name).toBe("evaled");
  });
});
