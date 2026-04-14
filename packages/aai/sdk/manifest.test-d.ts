// Copyright 2025 the AAI authors. MIT license.
/**
 * Type-level tests for manifest parsing and tool schema conversion
 * in `@alexkroman1/aai/manifest`.
 *
 * These are checked by tsc (via vitest typecheck) but never executed at runtime.
 */

import type { AgentConfig, Manifest, ToolSchema } from "@alexkroman1/aai/manifest";
import { agentToolsToSchemas, parseManifest, toAgentConfig } from "@alexkroman1/aai/manifest";
import { expectTypeOf, test } from "vitest";

test("parseManifest returns Manifest", () => {
  const result = parseManifest({ name: "test" });
  expectTypeOf(result).toEqualTypeOf<Manifest>();
});

test("parseManifest accepts unknown input", () => {
  // The parameter type should accept `unknown`
  expectTypeOf(parseManifest).parameter(0).toBeUnknown();
});

test("toAgentConfig returns AgentConfig", () => {
  const config = toAgentConfig({
    name: "test",
    systemPrompt: "prompt",
    greeting: "hello",
  });
  expectTypeOf(config).toEqualTypeOf<AgentConfig>();
});

test("agentToolsToSchemas returns ToolSchema[]", () => {
  const schemas = agentToolsToSchemas({});
  expectTypeOf(schemas).toEqualTypeOf<ToolSchema[]>();
});
