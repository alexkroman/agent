// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createWorkerEvaluator } from "./_bundler.ts";

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

// buildAgentBundle / executeBuild / evalWorkerBundle behavior is covered by
// _build.test.ts — the `typeof fn === "function"` shape tests that used to
// live here asserted nothing a broken implementation would fail.
