// Copyright 2025 the AAI authors. MIT license.

import "vitest";

interface AaiMatchers<R = unknown> {
  /**
   * Assert that a `TurnResult` includes a call to the named tool.
   *
   * Supports partial argument matching: only the specified keys are checked.
   *
   * @param toolName - The tool name to look for.
   * @param args - Optional partial args to match against.
   *
   * @example
   * ```ts
   * expect(turn).toHaveCalledTool("add_pizza");
   * expect(turn).toHaveCalledTool("add_pizza", { size: "large" });
   * expect(turn).not.toHaveCalledTool("remove_pizza");
   * ```
   */
  toHaveCalledTool(toolName: string, args?: Record<string, unknown>): R;
}

declare module "vitest" {
  interface Assertion<T = unknown> extends AaiMatchers<T> {}
  interface AsymmetricMatchersContaining extends AaiMatchers {}
}
