// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI streaming TTS opener (host-only).
 *
 * One long-lived WebSocket per session against
 * `wss://streaming-tts.assemblyai.com/v1/ws/`. Voice, language, and sample
 * rate are fixed at connect time as query params.
 *
 * **Auth.** The streaming sockets (STT and TTS) authenticate with the **raw**
 * API key in `Authorization` — *not* `Bearer <key>`, which is what the Voice
 * Agent socket wants. The raw form is verified working against production; the
 * AssemblyAI CLI additionally reports that a Bearer token upgrades fine and is
 * then refused in-band as an `Error` frame, which would make the mistake look
 * like a runtime failure rather than a handshake rejection.
 *
 * A rejected key arrives the same way — the socket opens, then the server
 * sends `{"type":"Error","error_code":1008,"error":"Unauthorized: Invalid API
 * key"}` — so bad credentials surface as `tts_stream_error`, not
 * `tts_auth_failed` (which only covers a key missing from the agent's env).
 *
 * **Protocol.** The server may open with a `Begin` frame, but this adapter
 * does not wait for one: the rate is already fixed by the `sample_rate` query
 * param, and against production no frame arrives until the client speaks
 * first. (The AssemblyAI CLI blocks on `Begin` before sending anything, which
 * is one reason it treats streaming TTS as sandbox-only.) Client sends
 * `{type:"Generate",text}` per LLM delta and `{type:"Flush"}` to force
 * synthesis of anything buffered; the server replies with `{type:"Audio",
 * audio:<base64 PCM16 LE>}` frames and ends the turn with `FlushDone` (or an
 * `Audio` frame flagged `is_final`). `Warning` frames are informational;
 * `Error` frames carry `error_code` + `error`. `Terminate` closes cleanly.
 *
 * **Flush is what starts synthesis, so this adapter flushes per sentence.**
 * `Generate` only buffers: measured against production, a turn's Generate
 * frames produce *zero* audio and the first `Audio` frame lands ~33ms after a
 * `Flush`. The pipeline's only provider-level flush is the end-of-turn drain
 * (`flushTtsAndWait`, once per reply — after every LLM step *and* every tool
 * call), so relaying deltas verbatim makes time-to-first-audio the length of
 * the entire turn: a tool-chaining reply is total silence for its whole
 * duration, with `holdPhrase` and the dead-air cover mute too, since they are
 * just more buffered text. Cartesia has no equivalent — `continue: true`
 * synthesizes on arrival — so this is the adapter's job, not the pipeline's.
 *
 * The segment size is a measured tradeoff, since each flushed segment is
 * synthesized as its own utterance with its own prosody and padding. For one
 * fixed text: end-of-turn flush only = 5.44s of audio but no sound until the
 * stream ended; flushing every word-granularity delta = 94ms to first audio
 * but 14.16s of audio (2.6x, audibly disjointed); flushing per *sentence* =
 * 6.48s vs 6.24s for the same three sentences, i.e. ~4%. Hence
 * {@link SEGMENT_BOUNDARY_RE} — sentence-terminal punctuation only, never the
 * commas the pipeline's own coalescer breaks on. {@link MIN_SEGMENT_WORDS}
 * then holds off on single-token segments, which are the abbreviation false
 * positives ("Dr. ", "e.g. ") that measured 25% longer audio; they simply wait
 * for the rest of the sentence. Two words is the floor rather than a character
 * count because every hold/cover phrase ("One moment.", "Almost there.") is a
 * short two-word sentence that *must* still flush — being audible mid-turn is
 * the only reason those phrases exist.
 *
 * Text is therefore buffered host-side and `Generate` is only ever sent as the
 * head of a `Generate`+`Flush` pair, which has two consequences worth keeping.
 * First, the segment split is exact and owned here: matching only on the *end*
 * of each incoming delta would outsource segmentation to the pipeline
 * coalescer's own chunking (whose `CLAUSE_BOUNDARY_RE` and 32-char cap can put
 * a sentence end mid-chunk), and a boundary missed that way silently restores
 * the whole-turn lag. Buffering costs nothing because the server does no work
 * before a `Flush` anyway. Second, the server never holds unflushed text, so at
 * end of turn there is either buffered text to synthesize or nothing at all —
 * and in the nothing case this adapter emits `done` itself rather than sending
 * a contentless `Flush` and waiting to be told. Production does answer one (an
 * immediate `FlushDone` carrying no audio), so this is not working around a
 * defect; it removes the dependency. The failure it would buy is bad out of
 * proportion to the frame it saves — an unanswered end-of-turn flush means
 * `done` never fires and `flushTtsAndWait` burns its full
 * PIPELINE_FLUSH_TIMEOUT_MS on every turn, which is worse than the lag being
 * fixed here.
 *
 * Consequence for `done`: every flush earns its own `FlushDone`, but the turn
 * ends only when the *last* one is acknowledged. `flushTtsAndWait` resolves on
 * `done`, so a segment's completion leaking through would advance the
 * orchestrator while audio is still streaming — and, since the end-of-turn
 * flush may have nothing to send, "last" cannot simply mean "the final flush's
 * ack" either. That bookkeeping — including the `is_final`+`FlushDone`
 * double-acknowledgement dedup that would otherwise end the turn mid-reply —
 * lives in `assemblyai-turn.ts` (`createTurnTracker`).
 *
 * **Cancel.** The protocol has no discard/cancel frame, so a mid-turn
 * `cancel()` drops the whole connection and reconnects: text Generate'd but
 * never Flush'ed would otherwise sit in the server-side buffer and be spliced
 * into the NEXT turn's synthesis on its Flush, and Audio frames already in
 * flight would audibly resume the interrupted reply. The cancelled socket's
 * listeners are detached before it closes, so its late frames (audio, a stale
 * `is_final`/`FlushDone` that could end the next turn early, the close
 * itself) are unobservable. Text sent while the replacement socket is still
 * connecting is queued and flushed to it on open.
 */

import { createNanoEvents, type Emitter } from "nanoevents";
import WebSocket from "ws";
import { TTS_RECONNECT_TIMEOUT_MS } from "../../../sdk/constants.ts";
import {
  ASSEMBLYAI_TTS_API_KEY_ENV,
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_HOST,
  type AssemblyAITtsOptions,
  assemblyAITtsLanguageCodes,
  resolveAssemblyAITtsLanguage,
} from "../../../sdk/providers/tts/assemblyai.ts";
import {
  makeTtsError,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
} from "../../../sdk/providers.ts";
import { errorMessage, safeJsonParse } from "../../../sdk/utils.ts";
import { base64ToUint8 } from "../../_base64.ts";
import { bytesToPcm16 } from "../../_pcm.ts";
import {
  assertPcm16Rate,
  closeOnAbort,
  connectOrThrow,
  createGuardedWs,
  createSessionShell,
  dropSocket as dropSocketShared,
  requireApiKey,
  waitForOpen,
} from "../_utils.ts";
import { createTurnTracker, type SynthesisAck } from "./assemblyai-turn.ts";

export interface AssemblyAITtsSession extends TtsSession {
  /** @internal Test-only: exposes the underlying raw WebSocket. */
  readonly _ws: WebSocket;
}

interface AssemblyAITtsMessage {
  type: "Begin" | "Audio" | "FlushDone" | "Warning" | "Error" | string;
  /** Base64 PCM16 LE payload on `Audio` frames. */
  audio?: string;
  /** Set on the last `Audio` frame of a synthesis by some server versions. */
  is_final?: boolean;
  error?: string;
  error_code?: string | number;
  warning?: string;
}

/** `(code): reason`, with a fallback so a detail-less frame still reads. */
function errorDetail(msg: AssemblyAITtsMessage): string {
  const reason = msg.error?.trim() ? msg.error : "unknown";
  return `(${msg.error_code ?? ""}): ${reason}`;
}

/**
 * A sentence end anywhere in the buffered text: terminal punctuation, optional
 * closing quotes/brackets, then whitespace or the end of the buffer. The
 * trailing-whitespace requirement is what keeps "3.5" and "v1.2" from matching.
 *
 * Deliberately narrower than the pipeline coalescer's CLAUSE_BOUNDARY_RE, which
 * also breaks on `,;:` — a comma is mid-sentence, and flushing there hands the
 * server a fragment to synthesize with a falling final intonation.
 */
const SEGMENT_BOUNDARY_RE = /[.!?…]["')\]]*(?:\s|$)/g;

/**
 * Words a segment needs before sentence-terminal punctuation flushes it — see
 * the module doc. Single-token segments are abbreviations far more often than
 * sentences.
 */
const MIN_SEGMENT_WORDS = 2;

/** Word count, used to keep abbreviation fragments out of their own utterance. */
function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Split `buffered` at the LAST sentence boundary whose head is a big enough
 * utterance, returning the text to synthesize now and the remainder to hold.
 *
 * The *last* boundary rather than the first: when several sentences arrive
 * before a flush, one larger segment sounds better than several small ones and
 * costs fewer round trips.
 */
function splitSegment(buffered: string): { head: string; tail: string } | undefined {
  let end: number | undefined;
  // matchAll clones the regex, so the shared `lastIndex` is never mutated here.
  for (const m of buffered.matchAll(SEGMENT_BOUNDARY_RE)) {
    const candidate = m.index + m[0].length;
    if (wordCount(buffered.slice(0, candidate)) >= MIN_SEGMENT_WORDS) end = candidate;
  }
  if (end === undefined) return;
  return { head: buffered.slice(0, end), tail: buffered.slice(end) };
}

function buildUrl(
  opts: AssemblyAITtsOptions,
  sampleRate: number,
  fail: (message: string) => Error,
): string {
  const params = new URLSearchParams({
    voice: opts.voice ?? ASSEMBLYAI_TTS_DEFAULT_VOICE,
    sample_rate: String(sampleRate),
  });
  // Omitted unless set: every voice speaks one language, so the server infers
  // it, and a mismatched pair is worse than no hint.
  if (opts.language) {
    // The wire wants `spanish`, not `es` — see ASSEMBLYAI_TTS_LANGUAGES. An
    // unsupported code must throw here: the service's own refusal arrives
    // in-band after the socket is open, which leaves the session "ready" and
    // silently mute instead of failing it.
    const language = resolveAssemblyAITtsLanguage(opts.language);
    if (language === undefined) {
      throw fail(
        `AssemblyAI TTS: unsupported language ${JSON.stringify(opts.language)} ` +
          `(supported: ${assemblyAITtsLanguageCodes().join(", ")})`,
      );
    }
    params.set("language", language);
  }
  return `wss://${ASSEMBLYAI_TTS_HOST}/v1/ws/?${params.toString()}`;
}

/**
 * Handle one server frame. Extracted to keep `open()` under the cognitive
 * complexity limit; turn state is threaded through the callbacks.
 */
function handleMessage(
  raw: WebSocket.Data,
  emitter: Emitter<TtsEvents>,
  onSynthesisComplete: (ack: SynthesisAck) => void,
  streamError: (message: string) => void,
): void {
  const msg = safeJsonParse(typeof raw === "string" ? raw : raw.toString()) as
    | AssemblyAITtsMessage
    | undefined;
  if (msg === undefined) return;

  switch (msg.type) {
    case "Audio": {
      if (typeof msg.audio === "string") {
        const pcm = bytesToPcm16(base64ToUint8(msg.audio));
        if (pcm.length > 0) emitter.emit("audio", pcm);
      }
      // Older servers flag the final frame; the live one uses FlushDone.
      if (msg.is_final) onSynthesisComplete("is_final");
      return;
    }
    case "FlushDone":
      onSynthesisComplete("flush_done");
      return;
    case "Error":
      streamError(`AssemblyAI TTS ${errorDetail(msg)}`);
      return;
    default:
      // Begin is consumed by the handshake below; Warning is informational.
      return;
  }
}

export function openAssemblyAITts(opts: AssemblyAITtsOptions): TtsOpener {
  return {
    name: "assemblyai",
    async open(openOpts: TtsOpenOptions): Promise<TtsSession> {
      const apiKey = requireApiKey(
        openOpts.apiKey,
        ASSEMBLYAI_TTS_API_KEY_ENV,
        "AssemblyAI TTS",
        (msg) => makeTtsError("tts_auth_failed", msg),
      );
      const connectError = (msg: string) => makeTtsError("tts_connect_failed", msg);
      const sampleRate = assertPcm16Rate(openOpts.sampleRate, "AssemblyAI TTS", connectError);
      // Built once so an unsupported language throws here, at open, rather
      // than on a cancel-triggered reconnect mid-conversation.
      const url = buildUrl(opts, sampleRate, connectError);

      const connect = (): WebSocket =>
        // Raw key, not `Bearer` — see the module doc. The guard listener
        // protects against a late socket error with zero listeners crashing
        // the process.
        createGuardedWs(
          () => new WebSocket(url, { headers: { Authorization: apiKey } }),
          connectError,
          "AssemblyAI TTS",
        );

      let ws = connect();
      try {
        await connectOrThrow("AssemblyAI TTS", connectError, () => waitForOpen(ws));
      } catch (err) {
        // Failed connect: close the socket before rethrowing so it can't
        // linger half-open (late errors land in the guard listener).
        dropSocketShared(ws);
        throw err;
      }

      const emitter: Emitter<TtsEvents> = createNanoEvents<TtsEvents>();
      // Non-null while a post-cancel replacement socket is connecting: frames
      // queue here and flush to it on open, preserving order.
      let queued: Record<string, unknown>[] | null = null;
      // Accepted text not yet sent: `Generate` goes out only paired with a
      // `Flush`, so the server never holds unsynthesized text.
      let buffered = "";

      /** Detach + politely close a socket without emitting anything for it. */
      const dropSocket = (socket: WebSocket): void =>
        dropSocketShared(socket, () => socket.send(JSON.stringify({ type: "Terminate" })));

      const shell = createSessionShell({
        makeStreamError: (msg) => makeTtsError("tts_stream_error", msg),
        emitError: (err) => emitter.emit("error", err),
        // `ws` is read at teardown time so a close after a cancel-reconnect
        // releases the replacement socket, not the one already dropped.
        teardown: () => dropSocket(ws),
      });

      // Flush/acknowledgement bookkeeping — which ack ends the turn, and the
      // is_final+FlushDone pair dedup — lives in assemblyai-turn.ts.
      const turn = createTurnTracker(() => {
        if (shell.isClosed()) return;
        // The turn is over, so text still held here belongs to nothing. Keeping
        // it would splice it into the next turn's first segment.
        buffered = "";
        emitter.emit("done");
      });

      const onSynthesisComplete = (ack: SynthesisAck): void => turn.onAck(ack);

      const attach = (socket: WebSocket): void => {
        socket.on("message", (raw: WebSocket.Data) => {
          if (shell.isClosed()) return;
          handleMessage(raw, emitter, onSynthesisComplete, shell.streamError);
        });
        socket.on("error", (err: Error) => shell.onSocketError(err));
        socket.on("close", (code: number) => {
          if (shell.isClosed()) return;
          // Unexpected server-side close: release the turn so the pipeline
          // doesn't wait for an utterance that will never complete.
          turn.forceDone();
          // Any close that reaches this handler is one we did NOT initiate:
          // dropSocket() detaches listeners before every local close and
          // shell.close() latches first. This is one long-lived connection per
          // session, so even a clean 1000 (idle policy, deploy) means every
          // later `send` is silently dropped by the readyState guard — each
          // turn would "complete" with zero audio and no error, the session
          // permanently, silently mute. Surface it regardless of code.
          shell.streamError(`AssemblyAI TTS: socket closed ${code}`);
        });
      };
      attach(ws);

      /** Replace the connection after a mid-turn cancel — see the module doc. */
      const reconnect = (): void => {
        dropSocket(ws);
        const frames: Record<string, unknown>[] = [];
        queued = frames;
        let next: WebSocket;
        try {
          next = connect();
        } catch (cause) {
          queued = null;
          shell.streamError(errorMessage(cause));
          return;
        }
        ws = next;
        // Deadline, not just open-or-error: this open runs mid-session with
        // nothing upstream bounding it, and a black-holed connect (no `open`,
        // no `error`) would leave `queued` non-null forever — every later
        // turn's frames queue "successfully" while nothing reaches the wire.
        void waitForOpen(next, TTS_RECONNECT_TIMEOUT_MS).then(
          () => {
            // Superseded (closed, or cancelled again) — not the live socket.
            if (shell.isClosed() || ws !== next) return;
            attach(next);
            queued = null;
            for (const frame of frames) next.send(JSON.stringify(frame));
          },
          (cause: unknown) => {
            if (shell.isClosed() || ws !== next) return;
            // Release the failed socket now — on timeout it may still open
            // later and would otherwise linger connected until session close.
            dropSocket(next);
            queued = null;
            shell.streamError(
              `AssemblyAI TTS: reconnect after cancel failed: ${errorMessage(cause)}`,
            );
          },
        );
      };

      const send = (payload: Record<string, unknown>): boolean => {
        if (shell.isClosed()) return false;
        if (queued !== null) {
          queued.push(payload);
          return true;
        }
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(payload));
        return true;
      };

      closeOnAbort(openOpts.signal, shell.close);

      const session: AssemblyAITtsSession = {
        sendText(text: string) {
          if (text.length === 0 || shell.isClosed()) return;
          // First text of a new turn — nothing from the last one carries over.
          turn.onTurnText();
          buffered += text;
          // Synthesize each complete sentence as it lands rather than waiting
          // for the end of the turn — see the module doc.
          const split = splitSegment(buffered);
          if (!split) return;
          buffered = split.tail;
          if (send({ type: "Generate", text: split.head }) && send({ type: "Flush" })) {
            turn.onFlushSent();
          }
        },

        flush() {
          if (shell.isClosed()) return;
          if (buffered.length > 0) {
            const text = buffered;
            buffered = "";
            if (send({ type: "Generate", text }) && send({ type: "Flush" })) {
              turn.onFlushSent();
            }
          }
          // Nothing left to synthesize past this point. Every segment already
          // acknowledged means the turn's audio is complete; otherwise the last
          // outstanding acknowledgement ends it. Either way, do NOT send an
          // empty Flush — see the module doc.
          turn.closeTurn();
        },

        cancel() {
          if (shell.isClosed()) return;
          // The cancelled turn's flushes are abandoned: either the socket is
          // dropped below (its late frames unobservable) or the queued frames
          // are discarded, so no acknowledgement for them will ever arrive.
          // `done` is emitted synchronously — the orchestrator's state machine
          // advances on it, and barge-in must not be microtask-deferred.
          buffered = "";
          const turnInFlight = turn.cancel();
          // Idempotent: nothing sent since the last done means nothing is
          // buffered server-side and no audio is in flight.
          if (!turnInFlight) return;
          if (queued !== null) {
            // The replacement socket is still connecting, so the cancelled
            // turn's frames never left the process — dropping them IS the cancel.
            queued.length = 0;
            return;
          }
          reconnect();
        },

        on(event, fn) {
          return emitter.on(event, fn);
        },

        close: shell.close,

        get _ws() {
          return ws;
        },
      };

      return session;
    },
  };
}
