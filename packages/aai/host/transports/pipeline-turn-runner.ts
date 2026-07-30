// Copyright 2026 the AAI authors. MIT license.
/**
 * Pluggable turn source for the pipeline transport.
 *
 * The pipeline transport's voice machinery — STT endpointing, barge-in,
 * settle windows, TTS coalescing/flush, hold phrases, dead-air cover, the
 * false-interruption recovery — is independent of *where the assistant's
 * reply comes from*. By default a turn is one Vercel AI SDK `streamText`
 * loop (`consumeLlmStream` in `pipeline-stream.ts`). A `PipelineTurnRunner`
 * replaces exactly that: given the committed user text and the turn's
 * sinks, it produces the reply stream however it likes — the eve turn
 * runner (`eve-turn-runner.ts`) sources it from an eve agent session's
 * durable event stream.
 *
 * Everything else in the transport stays in charge: the runner must respect
 * `ctl.signal` (barge-in aborts the turn), report deltas through `onDelta`
 * AND `sendTtsText` (transcript and speech are separate sinks), and return
 * `failed: true` when the turn errored so the transport can speak the
 * recovery phrase.
 */

import type { ModelMessage } from "ai";
import type { SessionErrorCode } from "../../sdk/protocol.ts";
import type { Logger } from "../runtime-config.ts";
import type { LlmStreamResult } from "./pipeline-stream.ts";
import type { TransportCallbacks } from "./types.ts";

/** Everything one turn needs from the owning transport. */
export interface PipelineTurnArgs {
  /** The committed user text for this turn (already pushed into history). */
  userText: string;
  /** System prompt for the turn. */
  systemPrompt: string;
  /**
   * The transport's LLM-view history including the just-pushed user turn.
   * Runners with their own durable history (eve) may ignore it.
   */
  messages: readonly ModelMessage[];
  /** Aborts the turn (barge-in / cancel / teardown). MUST be respected. */
  ctl: AbortController;
  /** Receives each assistant text delta (accumulated into the transcript). */
  onDelta: (delta: string) => void;
  /**
   * Fires when a chunk of the accumulated transcript is durably persisted on
   * the runner's side, so an aborted turn's `[interrupted]` marker carries
   * only the unpersisted tail. Runners without step persistence may omit
   * calling it.
   */
  onStepPersisted?: (() => void) | undefined;
  /** Forwards text to the active TTS session (no-op if none). */
  sendTtsText: (text: string) => void;
  /** Resolved hold phrase ("" disables it and the dead-air cover). */
  holdPhrase: string;
  /** Tool-call observability hooks, forwarded to SessionCore. */
  callbacks: Pick<TransportCallbacks, "onToolCall" | "onToolCallDone">;
  /** Report a turn error to the client. */
  emitError: (code: SessionErrorCode, message: string) => void;
  log: Logger;
  sid: string;
}

/**
 * One reply turn: consume the assistant stream, fan it out to the supplied
 * sinks, and report how the turn ended (see {@link LlmStreamResult}).
 */
export type PipelineTurnRunner = (args: PipelineTurnArgs) => Promise<LlmStreamResult>;
