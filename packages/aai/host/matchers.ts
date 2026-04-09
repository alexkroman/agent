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
import { toHaveCalledTool } from "./testing.ts";

expect.extend({ toHaveCalledTool });
