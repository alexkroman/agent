// Copyright 2026 the AAI authors. MIT license.
/**
 * The surface `createTextAgent` is called through: its options, one turn's
 * options, and the handle it returns.
 *
 * Split out of `agent.ts` at the source-length cap, on the seam that file
 * already had — every declaration here is a caller-facing contract with a
 * paragraph of argument per field, and what stays next door is the factory that
 * reads them. `agent.ts` re-exports all four, so no importer moved.
 *
 * @module
 */

import type { SessionEvent, ToolChoice } from "@alexkroman1/aai";
import type { AgentEnv } from "@alexkroman1/aai/host-internal";
import type {
  LanguageModel,
  ModelMessage,
  PrepareStepFunction,
  StepResult,
  streamText,
  ToolSet,
} from "ai";
import type { HostAgentOptions } from "../host-agent-options.ts";
import type { Db } from "../postgres-db.ts";

/**
 * The AI SDK's whole `streamText` result, which is what a turn really returns.
 *
 * Internal: published, every `ai` minor that touched any of its forty-odd
 * members was a break of `text`. The runtime's own harnesses (`runTextAgent`)
 * and the studio's coding agent (which pipes a UI-message stream) read it
 * through {@link HostTextAgent}; a caller gets {@link TextTurnResult}.
 *
 * @internal
 */
export type FullTextTurnResult = ReturnType<typeof streamText<ToolSet>>;

/**
 * What one turn hands back: the slice of the AI SDK's streaming result a
 * caller drives — the text as it arrives, the turn's messages once it settles,
 * and draining it.
 *
 * DECLARED here rather than `ReturnType<typeof streamText>`, so an `ai` minor
 * that reshapes the rest of that result is not a break of this contract. The
 * object IS the AI SDK's result, so a member this slice lacks is a request to
 * add one, not a cast to write.
 *
 * @sealed
 */
export type TextTurnResult = {
  /** The model's text, delta by delta, across every step of the turn. */
  readonly textStream: AsyncIterable<string>;
  /** The whole turn's text, once it settles. */
  readonly text: PromiseLike<string>;
  /** What the turn added to the conversation — append these to the next turn's `messages`. */
  readonly response: PromiseLike<{ readonly messages: readonly ModelMessage[] }>;
  /**
   * Drive the turn to completion without reading it. The stream is LAZY:
   * nothing settles, and no tool runs, until something consumes it.
   */
  consumeStream(options?: { onError?: ((error: unknown) => void) | undefined }): PromiseLike<void>;
};

/**
 * Session-fixed configuration for `createTextAgent`.
 *
 * The fields every way of running an agent shares are {@link HostAgentOptions}.
 * Here: `agent` must declare `mode: "text"`; `providerEnv` defaults to `env`, split
 * for the reason `RuntimeOptions` splits them (a host-fallback env may resolve a
 * model and must never become `ctx.env`); an absent `workflows` substitutes a
 * client that rejects with the reason; `fetch` is for tests (see
 * `BuiltinToolOptions`); `logger` defaults to `consoleLogger`; and a text agent
 * whose tools install packages or type-check a workspace wants a larger
 * `toolTimeoutMs` than the 30s voice-turn default.
 *
 * @input
 */
export interface TextAgentOptions extends HostAgentOptions {
  /**
   * Tenant-owned env: what tool code reads as `ctx.env`, and — unless
   * `providerEnv` overrides it — where the LLM credential is read from.
   */
  env?: AgentEnv;
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
  /**
   * Where this conversation's typed events go — the same {@link SessionEvent}
   * stream a voice session emits, narrowed to what a text agent can honestly
   * report, so every reader in `@alexkroman1/aai-runtime/eval` and every
   * assertion built on them works over a text turn unchanged.
   *
   * ADDITIVE, and deliberately so: {@link TextAgent.stream} still returns the
   * vendor's `StreamTextResult` and nothing about it changes. A chat surface
   * consumes that; this is for whoever is GRADING or auditing the agent.
   * `text-agent/events.ts` carries which events are emitted, which eleven are
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
}

/**
 * Per-turn parameters for {@link TextAgent.stream}.
 *
 * @input
 */
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

/**
 * A text agent bound to one conversation — see {@link createTextAgent}.
 *
 * @sealed
 */
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

/**
 * The text agent as this package's own harnesses hold it: the same object,
 * with the turn typed as the full AI SDK result.
 *
 * @internal
 */
export interface HostTextAgent extends TextAgent {
  stream(turn: TextTurnOptions): FullTextTurnResult;
}
