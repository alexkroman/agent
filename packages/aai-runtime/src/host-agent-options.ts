// Copyright 2026 the AAI authors. MIT license.
/**
 * The options every way of RUNNING an agent definition takes.
 *
 * Four entry points build a runtime around an `agent()` definition —
 * `createRuntime`, `createTextAgent`, and the two eval harnesses
 * `openEvalSession` and `openEvalTextAgent` — and each declared the same
 * handful of fields by hand. Four copies of one field is four places a doc
 * drifts and four places a new capability has to be remembered, so they
 * extend this.
 *
 * Structurally what each of the four already declared, and deliberately so:
 * an extension that widened or narrowed a field would have been a signature
 * change on four capabilities at once. That is why two fields that LOOK shared
 * are not here. `env` is required on {@link RuntimeOptions} and optional
 * elsewhere, and the eval harnesses take a plain record where the others take
 * `AgentEnv`; `llm` is a descriptor on three of them and absent from
 * `createTextAgent`, which takes a resolved `model` instead. Each declares its
 * own.
 *
 * @module
 */

import type { AgentDef } from "@alexkroman1/aai";
import type { ProviderEnv, RunCodeExecutor } from "@alexkroman1/aai/host-internal";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import type { Logger } from "./runtime-config.ts";

/**
 * What every entry point that runs an agent definition takes — see the module
 * doc for why `env` and `llm` are declared by each rather than here.
 *
 * @public
 */
export interface HostAgentOptions {
  /** The agent to run — an ordinary `agent()` definition. */
  agent: AgentDef;
  /**
   * Where provider credentials (STT/TTS/LLM) are resolved from, when that is
   * not the agent's own env.
   *
   * Exists so a host can let shell-exported credentials reach the provider
   * resolvers without also placing them in `ctx.env`, where agent tool code
   * could read them and come to depend on host-level variables that do not
   * exist in production. Each entry point documents its own default.
   */
  providerEnv?: ProviderEnv;
  /**
   * In-sandbox executor for the `run_code` builtin. Without one the builtin is
   * registered and permanently refuses, exactly as it does off-platform — the
   * Modal container is the security boundary and nothing here pretends
   * otherwise.
   */
  runCode?: RunCodeExecutor;
  /**
   * The `fetch` the builtin web tools use (web_search, visit_webpage,
   * get_page_design, fetch_json). Defaults to an SSRF-screened fetch. Pass one
   * to keep a spec or an eval case off the network.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Per-tool-call deadline. Defaults to `TOOL_EXECUTION_TIMEOUT_MS` (30s),
   * which is a VOICE-turn budget: a caller waiting on speech has left by then.
   * A tool whose work legitimately outruns it — a graded retrieval loop making
   * eleven model calls, measured at 22-30s — needs this raised, and that is the
   * caller's trade to make.
   */
  toolTimeoutMs?: number;
  /**
   * `ctx.workflows`, supplied rather than built — what a tool that starts a
   * durable run calls.
   *
   * Absent, a workflow-declaring agent gets the client the runtime assembles
   * itself, which is what every deployment wants. An eval supplies the
   * in-process client `openEvalWorkflows` builds, because a `"use workflow"`
   * body imported through a test runner was never through the compiler's
   * transform and the real engine cannot start it.
   */
  workflows?: WorkflowClient | undefined;
  /** Structured logger. Each entry point documents its own default. */
  logger?: Logger;
}
