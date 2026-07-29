// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createWorkerEvaluator } from "./_bundler.ts";
import { withTempDir } from "./_test-utils.ts";

describe("createWorkerEvaluator", () => {
  test("byte-identical code returns the cached AgentDef without re-import", async () => {
    await withTempDir(async (dir) => {
      const evaluate = createWorkerEvaluator(dir);
      const code = `export default { name: "memo-test", tools: {} };`;
      const first = await evaluate(code);
      const second = await evaluate(code);
      // Same object reference — a fresh import would produce a new object.
      expect(second).toBe(first);
      expect(first.name).toBe("memo-test");
    });
  });

  test("changed code re-evaluates and returns the new AgentDef", async () => {
    await withTempDir(async (dir) => {
      const evaluate = createWorkerEvaluator(dir);
      const first = await evaluate(`export default { name: "memo-v1", tools: {} };`);
      const second = await evaluate(`export default { name: "memo-v2", tools: {} };`);
      expect(second).not.toBe(first);
      expect(second.name).toBe("memo-v2");
    });
  });

  test("invalid exports still throw and are not cached", async () => {
    await withTempDir(async (dir) => {
      const evaluate = createWorkerEvaluator(dir);
      const bad = "export const notDefault = 42;";
      await expect(evaluate(bad)).rejects.toThrow("agent.ts must export default");
      // Failure was not memoized as a success.
      await expect(evaluate(bad)).rejects.toThrow("agent.ts must export default");
    });
  });
});

describe("buildAgentBundle", () => {
  test("module exports buildAgentBundle function", async () => {
    const mod = await import("./_bundler.ts");
    expect(typeof mod.buildAgentBundle).toBe("function");
  });

  test("module exports executeBuild function", async () => {
    const mod = await import("./_bundler.ts");
    expect(typeof mod.executeBuild).toBe("function");
  });

  test("module exports evalWorkerBundle function", async () => {
    const mod = await import("./_bundler.ts");
    expect(typeof mod.evalWorkerBundle).toBe("function");
  });
});
