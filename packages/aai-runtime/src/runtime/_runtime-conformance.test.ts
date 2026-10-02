// Copyright 2026 the AAI authors. MIT license.
/**
 * The runtime conformance case list, run over a direct (in-process) runtime
 * built from its own conformance agent.
 */

import { CONFORMANCE_AGENT, testRuntime } from "./_runtime-conformance.ts";
import { createRuntimeWithSeams } from "./runtime.ts";

// ── Shared conformance suite (same tests run against sandbox in integration) ─

const directExec = createRuntimeWithSeams({
  agent: CONFORMANCE_AGENT,
  // ASSEMBLYAI_API_KEY: a provider-less agent now defaults to the AssemblyAI
  // pipeline, whose LLM resolves (and requires its key) at runtime creation.
  env: { MY_VAR: "test-value", ASSEMBLYAI_API_KEY: "test" },
});

testRuntime("direct", () => ({
  executeTool: directExec.executeTool,
}));
