// Copyright 2025 the AAI authors. MIT license.
/**
 * Vitest custom matchers for AAI testing.
 *
 * Add this to your Vitest setup file to enable `expect(turn).toHaveCalledTool()`:
 *
 * ```ts
 * // vitest.config.ts
 * export default defineConfig({
 *   test: { setupFiles: ["@alexkroman1/aai/testing/matchers"] },
 * });
 * ```
 *
 * Or import directly in your test file:
 * ```ts
 * import "@alexkroman1/aai/testing/matchers";
 * ```
 *
 * @packageDocumentation
 */

import { expect } from "vitest";
import { TurnResult } from "./testing.ts";

expect.extend({
  /**
   * Assert that a TurnResult includes a call to the named tool.
   *
   * Supports partial argument matching: only the specified keys are checked,
   * and extra keys on the actual call are ignored.
   *
   * @example
   * ```ts
   * expect(turn).toHaveCalledTool("add_pizza");
   * expect(turn).toHaveCalledTool("add_pizza", { size: "large" });
   * expect(turn).not.toHaveCalledTool("remove_pizza");
   * ```
   */
  toHaveCalledTool(received: unknown, toolName: string, args?: Record<string, unknown>) {
    if (!(received instanceof TurnResult)) {
      return {
        pass: false,
        message: () => `expected a TurnResult, got ${typeof received}`,
        actual: received,
        expected: "TurnResult",
      };
    }

    const pass = received.toHaveCalledTool(toolName, args);

    const calledTools = received.toolCalls.map((tc) => tc.toolName);
    const argsHint = args ? ` with args ${JSON.stringify(args)}` : "";

    return {
      pass,
      message: () =>
        pass
          ? `expected turn NOT to have called tool "${toolName}"${argsHint}, but it was called.\nCalled tools: ${JSON.stringify(calledTools)}`
          : `expected turn to have called tool "${toolName}"${argsHint}, but it was not.\nCalled tools: ${JSON.stringify(calledTools)}`,
      actual: calledTools,
      expected: toolName,
    };
  },
});
