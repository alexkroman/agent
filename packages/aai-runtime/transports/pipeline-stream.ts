// Copyright 2026 the AAI authors. MIT license.
// TTS-side plumbing for the pipeline transport: the per-turn flush-wait, the
// coalescer that batches word-granularity LLM text into fewer provider sends,
// and the conversation → ModelMessage conversion.
//
// Split out of `pipeline-transport.ts` so that transport owns provider
// lifecycle/turn orchestration while this module owns the per-chunk mechanics.
// The `streamText` half moved on to `pipeline-llm-stream.ts` when preemptive
// generation gave it a second consumer.

import type { Message } from "@alexkroman1/aai";
import type { TtsSession, Unsubscribe } from "@alexkroman1/aai/host-internal";
import {
  DEFAULT_DEAD_AIR_COVER_MS,
  PIPELINE_FLUSH_TIMEOUT_MS,
} from "@alexkroman1/aai/host-internal";
import type { ModelMessage } from "ai";
import pTimeout from "p-timeout";
import type { Logger } from "../runtime-config.ts";
import type { EmitError, SendTtsOptions, SendTtsText } from "./types.ts";

/** Convert an internal conversation {@link Message} to a Vercel AI {@link ModelMessage}. */
export function toModelMessage(m: Message): ModelMessage {
  if (m.role === "user") return { role: "user", content: m.content };
  return { role: "assistant", content: m.content };
}

/**
 * Flush the TTS session and wait for its synthesis to drain. Resolves on TTS
 * `done`, signal abort, or PIPELINE_FLUSH_TIMEOUT_MS elapsed.
 *
 * `done` is anonymous, so this wait leans on the TtsEvents contract that it
 * never fires for a cancelled turn (see TtsEvents.done in sdk/providers.ts);
 * a provider leaking a stale one would end the next turn's reply early.
 */
export async function flushTtsAndWait(args: {
  tts: TtsSession | null;
  signal: AbortSignal;
  log: Logger;
  sid: string;
  emitError: EmitError;
}): Promise<void> {
  const { tts, signal, log, sid, emitError } = args;
  if (!tts) return;
  if (signal.aborted) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  const off: Unsubscribe = tts.on("done", () => resolve());
  tts.flush();
  try {
    await pTimeout(promise, { milliseconds: PIPELINE_FLUSH_TIMEOUT_MS, signal });
  } catch {
    // Abort resolves silently (barge-in); only a real drain timeout reports.
    if (signal.aborted) return;
    log.warn("TTS flush timeout", { sid, timeoutMs: PIPELINE_FLUSH_TIMEOUT_MS });
    // The caller hears this: the provider stopped mid-utterance, so the reply
    // is audibly clipped and then silent for the whole timeout. Reaching the
    // client (and the error log) as a `tts` error is the only trace — without
    // it a truncated turn is indistinguishable from a short one, in a session
    // that otherwise reports itself healthy.
    // NON-fatal: the reply is clipped, the session is not over — the lines below
    // resynchronize the turn and the conversation continues. Reported as fatal,
    // this cost the user their microphone for a truncated sentence.
    emitError("tts", "Speech synthesis did not finish; the reply may be cut short.", {
      fatal: false,
    });
    // Abandon the turn on the PROVIDER too, not just here. The session's turn
    // accounting still has this turn in flight with acknowledgements
    // outstanding, and `onTurnText` deliberately does not reset a turn it
    // believes is live — so every later turn on this session inherits the
    // desynchronized count. `cancel()` is the existing resynchronization
    // path (it clears the turn state and recycles the socket); text sent for
    // the next turn is queued onto the replacement.
    tts.cancel();
  } finally {
    off();
  }
}

/** Batches word-granularity text into fewer TTS sends — see {@link createTtsTextCoalescer}. */
export type TtsTextCoalescer = {
  /**
   * Buffer a text delta, forwarding coalesced chunks as boundaries are hit.
   *
   * `record` marks the text as the model's own words rather than dead-air
   * filler, and is carried through unchanged: a batch must never MIX the two,
   * or the heard cursor could not tell which characters of a coalesced send may
   * be truncated into history (see `pipeline-heard.ts`). `publishTranscript` is
   * the transport's to decide and is not batched — every coalesced send
   * publishes, which is what keeps the caption with the audio.
   */
  send: SendTtsText;
  /** Forward any buffered text. Call before the provider-level TTS flush. */
  flush(): void;
  /**
   * A speech segment ended (`text-end` / a tool call is about to run). Forwards
   * whatever is buffered and re-arms the immediate-first-chunk allowance.
   *
   * Batching may only defer text that more text is still coming for. Holding a
   * sub-threshold fragment ("let me") across a tool call would strand it for the
   * whole execution window — the caller hears the words before it, then dead
   * air, with only the dead-air cover (a whole {@link DEFAULT_DEAD_AIR_COVER_MS}
   * later) to break it. Re-arming also keeps the post-tool reply's first words
   * immediate, since that gap is exactly when time-to-first-audio matters again.
   */
  boundary(): void;
};

/**
 * Trailing sentence boundary — TERMINAL punctuation (optionally inside closing
 * quotes/brackets) at the end of the buffered text. Word-granularity chunks
 * carry their trailing whitespace ("Sure, "), so allow it after the mark.
 *
 * `,;:` are deliberately absent: a comma is mid-sentence, so flushing there
 * hands the provider a fragment to synthesize on its own — and a fragment is
 * given a falling final intonation and its own utterance padding, which is
 * heard as a clipped, over-punctuated read of a sentence the model wrote as
 * one. `assemblyai-segment.ts` had already reached the same conclusion on the
 * provider side of the same text; this is the pipeline half of it.
 *
 * Terminal punctuation is now the ONLY thing that ends a batch. There used to
 * be a 32-character cap beside it, on the theory that it bounded how long an
 * unterminated batch could wait — but a cap cuts wherever the count lands,
 * which is mid-clause far more often than not, and hands the provider exactly
 * the fragment the paragraph above is about: falling intonation plus utterance
 * padding, heard as an obvious pause a few words into a sentence the model
 * wrote as one. Time-to-audio is not what it was protecting either — the first
 * chunk of every segment is forwarded immediately, so audio is already playing
 * while the rest of the sentence buffers, and `boundary()` releases the buffer
 * at every segment end and before every tool call.
 */
// The closer class carries the CURLY quotes as well as the straight ones, and
// must stay in step with `SEGMENT_BOUNDARY_RE` in
// `providers/tts/assemblyai-segment.ts` — that module's doc argues both, and a
// straight-only class made `me.”` invisible as a sentence end, which is the
// spelling an LLM emits by default.
const TERMINAL_BOUNDARY_RE = /[.!?…]["'’”)\]]*\s*$/;

/**
 * Coalesce word-granularity LLM text into fewer, larger TTS provider sends.
 *
 * The smooth-stream transform (pipeline-smooth.ts) chunks LLM text to whole
 * words for pacing; forwarding each word to the TTS provider costs one wire
 * message (plus per-send request overhead) per word. The transcript path is
 * unaffected — this only batches what reaches `sendText`.
 *
 * The first chunk is forwarded immediately (preserves time-to-first-byte);
 * subsequent text batches until a sentence-terminal punctuation boundary, which
 * is the only thing that ends a batch (see `TERMINAL_BOUNDARY_RE`).
 * Callers must `flush()` when the stream ends so a trailing fragment is still
 * spoken.
 */
export function createTtsTextCoalescer(sendRaw: SendTtsText): TtsTextCoalescer {
  let pending = "";
  let pendingRecord = true;
  let firstSent = false;
  const flush = (): void => {
    if (pending.length === 0) return;
    const out = pending;
    pending = "";
    sendRaw(out, { record: pendingRecord });
  };
  return {
    send(text: string, opts?: SendTtsOptions): void {
      const record = opts?.record !== false;
      if (text.length === 0) return;
      // Release what is buffered before the flag flips, so no send ever mixes
      // recordable text with filler — see {@link TtsTextCoalescer.send}.
      if (record !== pendingRecord) flush();
      pendingRecord = record;
      if (!firstSent) {
        firstSent = true;
        sendRaw(text, { record });
        return;
      }
      pending += text;
      if (TERMINAL_BOUNDARY_RE.test(pending)) flush();
    },
    flush,
    boundary(): void {
      flush();
      firstSent = false;
    },
  };
}
