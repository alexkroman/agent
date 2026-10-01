// Copyright 2026 the AAI authors. MIT license.
/**
 * The ONE field that says what kind of agent a declaration is.
 *
 * `agent()` is overloaded over a union discriminated by {@link AgentMode}, and
 * every legality rule a declaration can break is a consequence of which member
 * it is in: a pipeline-only knob simply does not exist on the S2S member, so an
 * S2S agent that sets one is an excess-property error naming the member, and
 * the runtime refusal for an untyped caller (`_agent-modes.ts`) is derived from
 * the same field lists the members are cut from. Before this, the union was
 * expressed as EXCLUSIONS — string-literal error types and a hand-kept runtime
 * table — and the mode itself was spelled four ways (`s2s:` presence,
 * `text: true`, `page: "static"`, and the absence of all three).
 *
 * Split out of `types.ts`, which is at its source-length cap.
 */

/**
 * Which kind of agent this is — the discriminant `agent()` is overloaded over,
 * and the `mode` an {@link AgentDef} and its serialized config carry.
 *
 * - `"pipeline"` (the DEFAULT, when `mode` is absent) — STT → LLM → TTS, each
 *   stage individually optional and filled from the all-AssemblyAI pipeline.
 *   The only mode with the turn-taking tuning, the phrases and guardrails.
 * - `"s2s"` — one speech-to-speech provider socket (`s2s: assemblyAIS2s()`).
 *   Carries the `s2s` descriptor and nothing pipeline-shaped: the service owns
 *   STT, the model loop and TTS.
 * - `"text"` — no audio path at all; driven over a message list by
 *   `createTextAgent` (`@alexkroman1/aai-runtime`). `llm` is its one stage.
 * - `"workflow-app"` — a page over the workflow HTTP API, with no session, no
 *   socket and no model. `workflowApp()` is this member with `mode` already set.
 *
 * Explicit for every mode but the default, and never derived from a field
 * going missing: a mode reachable by omission is one a config lands in when it
 * loses a field (see "Never let S2S be a fallback" in `packages/aai/CLAUDE.md`).
 *
 * @public
 */
export type AgentMode = "pipeline" | "s2s" | "text" | "workflow-app";

/**
 * Every {@link AgentMode}, as a run-time list — what the config schema and the
 * mode check validate against.
 *
 * @internal
 */
export const AGENT_MODES = [
  "pipeline",
  "s2s",
  "text",
  "workflow-app",
] as const satisfies readonly AgentMode[];
