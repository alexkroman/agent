// Copyright 2026 the AAI authors. MIT license.
// The TAPE half of preemptive generation: one speculative `streamText` run,
// drained into memory and never anywhere else.
//
// **Guardrail 1 (no speculative speech) is structural, and this file is where
// that is true.** `createStreamPartHandler` is the only path from a stream part
// to `sendTtsText`, and it is constructed only inside `consumeLlmStream`.
// Nothing in this module has `sendTtsText`, `callbacks` or `providers` in
// scope; its only sink is an array. `sendTtsText` is in turn the only caller of
// `providers.tts.sendText` and `turns.openAudioGate()`, so no text sent means no
// audio synthesised, let alone forwarded to the client. ADOPTION IS the act of
// connecting the tape to the handler — see `pipeline-llm-stream.ts`.
//
// **There is exactly ONE consumer of the underlying `fullStream`: the drain
// loop below.** An adopter reads the TAPE, replaying what is already there and
// then following it as the same loop keeps filling it. Handing the raw iterator
// over instead loses whichever part the parked `next()` had already taken.
//
// The policy that decides when to start one, and whether to adopt it, lives in
// `pipeline-speculation.ts`. This module only knows how to run one and hold it.

import type { Logger } from "../runtime-config.ts";
import type { AdoptedLlmStream, LlmRequest, StepResult, TapeEntry } from "./pipeline-llm-stream.ts";
import { startLlmStream } from "./pipeline-llm-stream.ts";

/** One in-flight (or settled) speculative generation. */
export interface SpeculativeStream {
  /** The user text this was started from — the match rule compares against it. */
  readonly prompt: string;
  /** ms since the speculation was launched, for the adoption log's head start. */
  ageMs(): number;
  /**
   * The tape saw something that makes the whole speculation unusable: a
   * `tool-call` part, or an `error` part.
   *
   * A tool call poisons the run rather than truncating it, PREAMBLE INCLUDED.
   * Adopting just the text before it would mean re-running the turn with the
   * assistant's partial message prefilled, which changes the request shape —
   * and request parity is the entire reason adoption is legitimate.
   *
   * **This is a lifetime property, not an adoption-time one.** The speculation
   * is still streaming when a turn adopts it, so poison can arrive AFTER
   * `take()` consulted this and let the adoption through. Consumers must handle
   * that case as well as this predicate — see the late-poison restart in
   * `consumeLlmStream`, which is what keeps a post-adoption tool call from
   * killing the real turn with "Tool result is missing for tool call <id>".
   */
  poisoned(): boolean;
  /** Abort the underlying request. Idempotent. */
  abort(): void;
  /** True once {@link abort} has been called. */
  aborted(): boolean;
  /**
   * Hand the live stream over to the turn that adopted it, re-parented onto
   * that turn's abort signal.
   */
  adopt(turnSignal: AbortSignal): AdoptedLlmStream;
}

/** What a speculation needs beyond {@link LlmRequest}'s per-turn fields. */
export type SpeculativeRequest = Omit<LlmRequest, "signal" | "onStep">;

/**
 * Launch a speculative generation and start draining it into a tape.
 *
 * The drain runs detached: a speculation is not awaited by anything, and a
 * caller that never adopts it simply aborts it. Every failure mode — a provider
 * error, an abort, a malformed stream — resolves the drain quietly. **A
 * speculation must NEVER call `emitError`**: it has no reply id, no client-side
 * turn and no history entry, so a client-visible error for it would be worse
 * than the outage it reports. The real turn reports the same failure normally,
 * through `errorPhrase`.
 */
export function startSpeculativeStream(
  req: SpeculativeRequest,
  userText: string,
  log: Logger,
  /**
   * Session-lifetime signal. Combined with the speculation's own controller so
   * a billed request can never outlive the session even on a path that forgot
   * to discard — the policy's `discard` is the ordinary route, this is the
   * backstop. `AbortSignal.any` holds its sources weakly, so a settled
   * speculation leaves no listener behind.
   */
  sessionSignal: AbortSignal,
): SpeculativeStream {
  const ctl = new AbortController();
  const startedAt = Date.now();
  const tape: TapeEntry[] = [];
  let poisoned = false;
  let finished = false;
  // Woken on every append and on completion, so a follower parked on an empty
  // tape resumes without polling. Replaced (not reused) per notification.
  let arrival = Promise.withResolvers<void>();

  function append(entry: TapeEntry): void {
    tape.push(entry);
    arrival.resolve();
    arrival = Promise.withResolvers<void>();
  }
  function finish(): void {
    finished = true;
    arrival.resolve();
  }

  const started = startLlmStream({
    ...req,
    signal: AbortSignal.any([sessionSignal, ctl.signal]),
    // Step markers are taped in arrival order so a replay fires
    // `onStepPersisted` exactly where the live run would have. With no
    // `execute` on any tool there can be at most one.
    onStep: (messages) => append({ kind: "step", messages }),
  });

  const drain = async (): Promise<void> => {
    try {
      for await (const part of started.fullStream) {
        // Poison is recorded but taping continues: a poisoned speculation is
        // never adopted, so the tape's contents stop mattering, and a second
        // branch here would only be a place to get the ordering wrong.
        if (part.type === "tool-call" || part.type === "error") poisoned = true;
        append({ kind: "part", part });
      }
    } finally {
      finish();
    }
  };
  void drain().catch((err: unknown) => {
    poisoned = true;
    finish();
    log.debug("Pipeline speculation stream ended", { error: String(err) });
  });

  /** Replay the tape, then follow it as the drain loop keeps filling it. */
  async function* follow(): AsyncGenerator<TapeEntry> {
    let i = 0;
    for (;;) {
      while (i < tape.length) yield tape[i++] as TapeEntry;
      if (finished) return;
      await arrival.promise;
    }
  }

  return {
    prompt: userText,
    ageMs: () => Date.now() - startedAt,
    poisoned: () => poisoned,
    aborted: () => ctl.signal.aborted || sessionSignal.aborted,
    abort: () => ctl.abort(),
    adopt(turnSignal: AbortSignal): AdoptedLlmStream {
      // The speculation's own controller becomes a child of the turn's signal,
      // so a barge-in on the adopted turn kills the same request the
      // speculation started. Not `AbortSignal.any`: the controller has to stay
      // independently abortable right up to this instant, which is what the
      // discard paths use.
      if (turnSignal.aborted) ctl.abort();
      else turnSignal.addEventListener("abort", () => ctl.abort(), { once: true });
      return {
        entries: follow,
        steps: (): Promise<readonly StepResult[]> => started.steps,
        // The turn keeps running; only this request stops. `startLlmStream`
        // already observes `steps`' rejection, so the AbortError it settles
        // with cannot surface as an unhandled rejection.
        abandon: () => ctl.abort(),
      };
    },
  };
}
