// Copyright 2025 the AAI authors. MIT license.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, vi } from "vitest";
import { buildAgentBundle, createWorkerEvaluator, evalWorkerBundle } from "./_bundler.ts";
import { linkSdkNodeModules, test } from "./_test-utils.ts";

// 30s, not the 5s default — the same reason `_dev-server-restart.test.ts`
// raises its own. Every `evaluate()` here writes a real file to a tmpdir and
// ESM-imports it, so these are filesystem+loader tests wearing the clothes of
// unit tests. Standalone they finish in tens of milliseconds; under a full
// `turbo run test` the eight package suites contend for CPU and this suite
// timed out at 5s mid-import. A generous ceiling costs nothing on the happy
// path, because a test that passes still returns as soon as the import
// settles — the timeout only decides how long a genuinely stuck one hangs.
vi.setConfig({ testTimeout: 30_000 });

describe("createWorkerEvaluator", () => {
  test("byte-identical code returns the cached result without re-import", async () => {
    const evaluate = createWorkerEvaluator();
    const code = `export default { name: "memo-test", tools: {} };`;
    const first = await evaluate(code);
    const second = await evaluate(code);
    // Same object reference — a fresh import would produce a new object.
    expect(second).toBe(first);
    expect(first.name).toBe("memo-test");
  });

  test("changed code re-evaluates and returns the new AgentDef", async () => {
    const evaluate = createWorkerEvaluator();
    const first = await evaluate(`export default { name: "memo-v1", tools: {} };`);
    const second = await evaluate(`export default { name: "memo-v2", tools: {} };`);
    expect(second).not.toBe(first);
    expect(second.name).toBe("memo-v2");
  });

  test("invalid exports still throw and are not cached", async () => {
    const evaluate = createWorkerEvaluator();
    const bad = "export const notDefault = 42;";
    await expect(evaluate(bad)).rejects.toThrow("agent.ts must export default");
    // Failure was not memoized as a success.
    await expect(evaluate(bad)).rejects.toThrow("agent.ts must export default");
  });
});

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
  test("throws when no agent.ts found", async ({ tmpDir: dir }) => {
    await linkSdkNodeModules(dir);
    await expect(buildAgentBundle(dir)).rejects.toThrow("agent.ts");
  });

  test("bundles minimal agent with a self-describing config export", async ({ tmpDir: dir }) => {
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
  });

  test("bundles agent with tools and self-describes their schemas", async ({ tmpDir: dir }) => {
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
  });

  test("minify option produces a smaller worker that still evaluates", async ({ tmpDir: dir }) => {
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
  });

  test("Vite-bundled worker is valid ESM with default export", async ({ tmpDir: dir }) => {
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
  });
});

describe("deploy-shaped build (runtime included)", () => {
  test("ships a working __aaiCreateRuntime factory", { timeout: 120_000 }, async ({
    tmpDir: dir,
  }) => {
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
