// Copyright 2026 the AAI authors. MIT license.
/**
 * What one pipeline turn's `streamText` call is described BY.
 *
 * Split out of `pipeline-llm-stream.ts` at the source-length cap, on the seam
 * that file already had: these are declarations, and almost every field on them
 * is a decision with a paragraph attached (which signal a request runs under,
 * what a speculation may hand over, what "the turn failed" means as against
 * "the turn was interrupted"). What is left next door is the two functions.
 *
 * Nothing here is exported from the package. `pipeline-llm-stream.ts`
 * re-exports every name, so no importer moved.
 *
 * @module
 */

import type { ToolChoice } from "@alexkroman1/aai";
import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  PrepareStepFunction,
  Tool,
  ToolCallRepairFunction,
  ToolSet,
} from "ai";
import type { Logger } from "../runtime-config.ts";
import type { FatalToolLatch } from "../tool-error-policy.ts";
import type { ContextBudgetPreparer } from "./pipeline-context-budget.ts";
import type { StreamPart } from "./pipeline-stream-parts.ts";
import type { EmitError, SendTtsText, SystemPromptOption, TransportCallbacks } from "./types.ts";

/** Parameters for {@link consumeLlmStream}, threading session state explicitly. */
export interface ConsumeLlmStreamParams {
  /** LLM provider (Vercel AI SDK LanguageModel). */
  llm: LanguageModel;
  /**
   * System prompt for the turn — a string or a thunk ({@link SystemPromptOption}),
   * resolved in {@link startLlmStream}: the ONE place a `streamText` request is
   * assembled, and so the one place a per-turn prompt can enter without breaking
   * the parity preemption rests on. A caller that resolved it and passed the
   * string would be back to a value frozen at whatever moment that caller ran.
   */
  systemPrompt: SystemPromptOption;
  /** Conversation history in Vercel AI SDK ModelMessage form. */
  messages: ModelMessage[];
  /** Tool set bound to the transport's executeTool. */
  tools: Record<string, Tool>;
  /** Tool selection policy passed to `streamText`. */
  toolChoice: ToolChoice;
  /** LLM sampling temperature; omitted entirely from streamText when unset. */
  temperature: number | undefined;
  /** Per-step output cap; omitted entirely from streamText when unset. */
  maxOutputTokens?: number | undefined;
  /** Provider-retry budget; omitted when unset, leaving the AI SDK's own default. */
  maxRetries?: number | undefined;
  /** Reset a demanding `toolChoice` after step 0 — see `_prepare-step.ts`. */
  resetToolChoice?: boolean | undefined;
  /**
   * Fold one completed step's reported usage into the session's meter.
   *
   * On `onStepFinish`, which is the only place the provider's own counts are
   * handed to this process. Absent for a speculation, whose steps are a request
   * the caller may never adopt — billing is real either way, but a discarded
   * speculation must not move a budget the author reasons about per turn.
   */
  onUsage?: ((usage: LanguageModelUsage) => void) | undefined;
  /** The active dialog state's `toolChoice`/`temperature`, per STEP — see `pipeline-dialog-knobs.ts`. */
  dialogStep?: PrepareStepFunction<ToolSet> | undefined;
  /** Repairs malformed tool-call arguments by re-asking the model. */
  repairToolCall: ToolCallRepairFunction<ToolSet>;
  /** Max LLM tool-call steps for this turn. */
  maxSteps: number;
  /**
   * Bounds what each step SENDS to the model — see `pipeline-context-budget.ts`.
   *
   * A `prepareStep` preparer, composed with `forceFinalAnswer` rather than
   * replacing it (`composePrepareStep`), and `undefined` when the model's
   * context window is not known, at which point nothing is trimmed. It is
   * SESSION-scoped: the fixed cost it learns from one step's reported usage is
   * the right number for the next turn's first step.
   */
  contextBudget?: ContextBudgetPreparer | undefined;
  /**
   * Forwards text to the active TTS session (no-op if none). `record: false`
   * marks dead-air filler: audible, but never part of the record.
   */
  sendTtsText: SendTtsText;
  /** Dead-air cover window (ms); 0 disables — see {@link StreamPartHandlerDeps}. */
  deadAirCoverMs?: number | undefined;
  /** Is the caller speaking right now? Suppresses filler — see StreamPartHandlerDeps. */
  callerSpeaking?: (() => boolean) | undefined;
  /** Tool-call/tool-result observability hooks, forwarded to ServerSession. */
  callbacks: Pick<TransportCallbacks, "report">;
  /** Report an LLM-stream error. */
  emitError: EmitError;
  log: Logger;
  sid: string;
  /** The turn's abort signal (turn cancellation / barge-in / session end). */
  signal: AbortSignal;
  /** Receives each assistant text delta (accumulated into the transcript). */
  onDelta: (delta: string) => void;
  /**
   * Fires after each completed LLM step, once that step's response messages
   * are safe in the collected history. The transport uses it to snapshot how
   * much of the accumulated transcript is already persisted, so an aborted
   * turn's `[interrupted]` marker carries only the unpersisted tail.
   */
  onStepPersisted?: (() => void) | undefined;
  /**
   * The adopted run was abandoned and the turn is starting from the top. This
   * module resets its own copies; `onDelta` has been appending to a string the
   * CALLER owns, and left standing the abandoned preamble sits in front of the
   * restarted text and is committed to history twice. See the late-poison
   * restart in {@link consumeLlmStream}.
   */
  onRestart?: (() => void) | undefined;
  /**
   * A speculative stream, already running against this exact request, to drain
   * instead of launching a new one — see `pipeline-speculation.ts`. Present
   * only when the committed user text matched what the speculation was started
   * from, so the request the caller would have assembled is the request already
   * in flight.
   */
  adopted?: AdoptedLlmStream | undefined;
  /**
   * The turn's fatal-tool latch — see `tool-error-policy.ts`.
   *
   * Its signal is combined into the REQUEST's signal only, never the turn's, so
   * a tool that declares its failure unrecoverable stops the model mid-stream
   * while the turn stays alive and ends through its ordinary failure path (the
   * one that speaks `errorPhrase`). Absent for a speculation, which has no
   * executable tools and therefore no fatal call to make.
   */
  fatalTool?: FatalToolLatch | undefined;
}

/** Outcome of one {@link consumeLlmStream} turn. */
export interface LlmStreamResult {
  /**
   * Response messages of every step that COMPLETED, for history.
   *
   * On abort or stream error this holds the steps finished before the
   * interruption (tool calls with their results) — never `undefined` — so
   * barge-in does not erase work already done: the next turn's LLM still sees
   * which tools ran and what they returned. An in-flight step is dropped whole
   * (no dangling tool call without its result).
   */
  messages: ModelMessage[];
  /**
   * The stream errored out rather than completing or being aborted.
   *
   * The caller needs this to speak a recovery phrase: a failed turn usually
   * produces no text at all, so nothing reaches TTS and the caller hears
   * silence. An empty `messages` array cannot express it — a successful turn
   * that produced no tool steps looks identical. A deliberate barge-in is NOT
   * a failure; it has its own recovery path.
   */
  failed: boolean;
}

/** One completed `streamText` step, narrowed to the part history needs. */
export interface StepResult {
  response: { messages: ModelMessage[] };
}

/**
 * A speculative stream handed over to the real turn that adopted it.
 *
 * `entries()` replays what the speculation already drained and then FOLLOWS the
 * same live run — one continuous sequence, which is why preemption is a head
 * START rather than a cache lookup. See `pipeline-speculative-stream.ts` for why
 * the speculation stays the sole reader of the underlying stream.
 */
export interface AdoptedLlmStream {
  /** Taped entries then live ones, in arrival order, ending when the run does. */
  entries(): AsyncIterable<TapeEntry>;
  /** `result.steps`, for the same final gather the ordinary path does. */
  steps(): Promise<readonly StepResult[]>;
  /**
   * Abandon the adopted run WITHOUT aborting the turn that adopted it.
   *
   * `adopt()` re-parents the speculation onto the turn's signal, so by this
   * point aborting the turn is the only other way to stop the request — and the
   * turn is precisely what must survive. See the late-poison restart in
   * {@link consumeLlmStream}.
   */
  abandon(): void;
}

/**
 * One entry of a speculation's tape. `step` markers keep `onStepPersisted`
 * ordering exact on replay: the transport snapshots how much text a completed
 * step covers, and taping only the parts would put that snapshot in the wrong
 * place.
 */
export type TapeEntry =
  | { readonly kind: "part"; readonly part: StreamPart }
  | { readonly kind: "step"; readonly messages: readonly ModelMessage[] };

/** What {@link startLlmStream} hands back to whoever drains it. */
export interface StartedLlmStream {
  /** Parts as `streamText` produces them. */
  fullStream: AsyncIterable<StreamPart>;
  /** Settles with every step of the turn, after the stream ends. */
  steps: Promise<readonly StepResult[]>;
}

/** The request half of {@link ConsumeLlmStreamParams} — see {@link startLlmStream}. */
export type LlmRequest = Pick<
  ConsumeLlmStreamParams,
  | "llm"
  | "systemPrompt"
  | "messages"
  | "tools"
  | "toolChoice"
  | "temperature"
  | "dialogStep"
  | "repairToolCall"
  | "maxSteps"
  | "contextBudget"
  | "maxOutputTokens"
  | "maxRetries"
  | "resetToolChoice"
  | "onUsage"
  | "log"
  | "sid"
  | "signal"
> & { onStep?: ((messages: readonly ModelMessage[]) => void) | undefined };
