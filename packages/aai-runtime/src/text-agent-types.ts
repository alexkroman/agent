// Copyright 2026 the AAI authors. MIT license.
/**
 * The surface `createTextAgent` is called through: its options, one turn's
 * options, and the handle it returns.
 *
 * Split out of `text-agent.ts` at the source-length cap, on the seam that file
 * already had — every declaration here is a caller-facing contract with a
 * paragraph of argument per field, and what stays next door is the factory that
 * reads them. `text-agent.ts` re-exports all four, so no importer moved.
 *
 * @module
 */

import type { AgentDef, ToolChoice } from "@alexkroman1/aai";
import type { AgentEnv, ProviderEnv, RunCodeExecutor } from "@alexkroman1/aai/host-internal";
import type { Db } from "@alexkroman1/aai/internal";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import type {
  LanguageModel,
  ModelMessage,
  PrepareStepFunction,
  StepResult,
  streamText,
  ToolSet,
} from "ai";
import type { Logger } from "./runtime-config.ts";

/**
 * What one turn hands back: the AI SDK's own `streamText` result, with this
 * SDK's tool set.
 *
 * Spelled as `ReturnType<typeof streamText<ToolSet>>` rather than by naming
 * `StreamTextResult`'s three type parameters, so the two type arguments we
 * have no opinion about (the runtime context and the structured-output shape)
 * keep tracking the vendor's own defaults instead of being pinned to whatever
 * they were on the day this was written.
 */
export type TextTurnResult = ReturnType<typeof streamText<ToolSet>>;

/** Session-fixed configuration for `createTextAgent`. */
export interface TextAgentOptions {
  /** The agent definition. Must declare `text: true`. */
  agent: AgentDef;
  /**
   * Tenant-owned env: what tool code reads as `ctx.env`, and — unless
   * `providerEnv` overrides it — where the LLM credential is read from.
   */
  env?: AgentEnv;
  /**
   * Env used for provider-credential resolution only. Defaults to `env`.
   * Split for the same reason `RuntimeOptions` splits them: a host-fallback
   * env may resolve a model and must never become `ctx.env`.
   */
  providerEnv?: ProviderEnv;
  /**
   * Pre-resolved model, bypassing descriptor resolution entirely. For a
   * caller that already holds a `LanguageModel` (and for tests, which is the
   * majority use — a text agent's whole observable behaviour is what it
   * sends the model).
   */
  model?: LanguageModel;
  /**
   * Accepted and currently UNUSED — a text agent's tools receive no database.
   * There is no `ctx.db`: the context this builds carries the same eleven
   * fields a voice session's tools get, none of them a SQL handle. Kept on the
   * options bag so a caller that already passes one still compiles.
   */
  db?: Db | undefined;
  /** `ctx.workflows`. Absent substitutes a client that rejects with the reason. */
  workflows?: WorkflowClient | undefined;
  /** In-sandbox `run_code` executor, for an agent that enables that builtin. */
  runCode?: RunCodeExecutor;
  /** Override the builtins' fetch. Tests only — see `BuiltinToolOptions`. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to `consoleLogger`. */
  logger?: Logger;
  /**
   * Where this conversation's typed events go — the same {@link SessionEvent}
   * stream a voice session emits, narrowed to what a text agent can honestly
   * report, so every reader in `@alexkroman1/aai-runtime/eval` and every
   * assertion built on them works over a text turn unchanged.
   *
   * ADDITIVE, and deliberately so: {@link TextAgent.stream} still returns the
   * vendor's `StreamTextResult` and nothing about it changes. A chat surface
   * consumes that; this is for whoever is GRADING or auditing the agent.
   * `text-agent-events.ts` carries which events are emitted, which eleven are
   * not, and why the turn terminator fires exactly once.
   *
   * **Conversation-scoped, and the envelope carries no turn coordinate** (see
   * `protocol-events.ts`, which argues that absence), so two overlapping
   * `stream()` calls on ONE text agent interleave into one stream with nothing
   * to tell them apart. A caller that needs them separate builds a text agent
   * per turn — which is what `runTextAgent` does.
   */
  onEvent?: (event: SessionEvent) => void;
  /**
   * Conversation identity for `ctx.sessionId` and the session's `slots`.
   * Defaults to a fresh id per text agent — one instance is one conversation,
   * which is what makes a slot mean the same thing here as in a session.
   */
  sessionId?: string;
  /**
   * Per-tool-call deadline. Defaults to `TOOL_EXECUTION_TIMEOUT_MS`
   * (30s), which is a voice-turn budget; a text agent whose tools install
   * packages or type-check a workspace wants a larger one.
   */
  toolTimeoutMs?: number;
}

/** Per-turn parameters for {@link TextAgent.stream}. */
export interface TextTurnOptions {
  /** The conversation so far, in AI SDK `ModelMessage` form. */
  messages: ModelMessage[];
  /** Aborts the LLM stream and every in-flight tool call. */
  signal?: AbortSignal;
  /** Overrides the agent's `systemPrompt` for this turn. */
  systemPrompt?: string;
  /** Overrides the agent's `maxSteps` for this turn. */
  maxSteps?: number;
  /** Overrides the agent's `temperature` for this turn. */
  temperature?: number;
  /** Overrides the agent's `toolChoice` for this turn. */
  toolChoice?: ToolChoice;
  /**
   * Extra stop conditions, ANDed into the step budget as alternatives — a
   * wall-clock deadline is the usual one, since a step cap says nothing
   * about how long a caller waits.
   */
  stopWhen?: readonly ((options: {
    steps: readonly StepResult<ToolSet>[];
  }) => boolean | PromiseLike<boolean>)[];
  /**
   * Per-step hook, composed WITH this module's own: whatever it returns is
   * applied first, and the forced final answer is layered over the result, so
   * a caller may rewrite the step's messages (compaction, an injected notice)
   * without being able to hand the model tools on the step the budget
   * reserved for answering.
   */
  prepareStep?: PrepareStepFunction<ToolSet>;
  /** Fires after each completed step, with that step's result. */
  onStepFinish?: (step: StepResult<ToolSet>) => void | Promise<void>;
}

/** A text agent bound to one conversation — see {@link createTextAgent}. */
export interface TextAgent {
  /** The resolved model every turn runs on. */
  readonly model: LanguageModel;
  /**
   * The agent's tools as the AI SDK sees them — its own plus its enabled
   * builtins, each bound to the shared executor. Exposed because a caller
   * rendering a tool console needs the names it will see in the stream.
   *
   * These declarations belong to NO turn: {@link TextAgent.stream} builds its
   * own set bound to that turn's messages, so `ctx.messages` cannot be handed a
   * conversation from a concurrent turn. A tool invoked through this copy reads
   * an empty `ctx.messages`.
   */
  readonly tools: ToolSet;
  /** This conversation's id — `ctx.sessionId` for every tool call. */
  readonly sessionId: string;
  /** Run one turn, streaming. */
  stream(turn: TextTurnOptions): TextTurnResult;
}
