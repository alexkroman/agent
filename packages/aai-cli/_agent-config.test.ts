// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { evalWorkerBundle } from "./_bundler.ts";

describe("evalWorkerBundle", () => {
  test("extracts AgentDef from ESM code string", async () => {
    const code = `const agent = { name: "test-agent", systemPrompt: "Hello", greeting: "Hi", maxSteps: 5, tools: {} };\nexport default agent;\n`;
    const agentDef = await evalWorkerBundle(code, process.cwd());
    expect(agentDef.name).toBe("test-agent");
  });

  test("throws when default export has no name", async () => {
    const code = "export default { tools: {} };\n";
    await expect(evalWorkerBundle(code, process.cwd())).rejects.toThrow(
      "agent.ts must export default agent({ name: ... })",
    );
  });
});
