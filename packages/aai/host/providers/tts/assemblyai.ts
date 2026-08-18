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
 * `WordBoundaries` frames carry per-word audio offsets; they are parsed and
 * re-emitted as the `words` TtsEvent (see `assemblyai-words.ts`, which owns the
 * tolerant parse and the rebase onto the turn's timeline). They are NOT
 * acknowledgements — routing one into the turn tracker would end the reply
 * mid-synthesis.
 *
 * **Flush is what starts synthesis, so this adapter flushes per sentence.**
 * `Generate` only buffers: measured against production, a turn's Generate
 * frames produce *zero* audio and the first `Audio` frame lands ~33ms after a
 * `Flush`. The pipeline's only provider-level flush is the end-of-turn drain
 * (`flushTtsAndWait`, once per reply — after every LLM step *and* every tool
 * call), so relaying deltas verbatim makes time-to-first-audio the length of
 * the entire turn: a tool-chaining reply is total silence for its whole
 * duration, with the dead-air cover mute too, since it is
 * just more buffered text. Cartesia has no equivalent — `continue: true`
 * synthesizes on arrival — so this is the adapter's job, not the pipeline's.
 *
 * Where those segments are cut — a sentence end, or a character budget when no
 * sentence end is in sight — is one measured rule with a sharp cliff either
 * side of it, and lives in `assemblyai-segment.ts` (`splitSegment`). Read it
 * before changing the cadence: segments that are too long make
 * time-to-first-audio the length of the reply's first sentence, and segments
 * that are too short are each padded into a ~800ms slot, which is how per-delta
 * "continuous" streaming reaches 3.1x the audio for the same words.
 *
 * Text is therefore buffered host-side and `Generate` is only ever sent as the
 * head of a `Generate`+`Flush` pair, which has two consequences worth keeping.
 * First, the segment split is exact and owned here: matching only on the *end*
 * of each incoming delta would outsource segmentation to the pipeline
 * coalescer's own chunking (whose `TERMINAL_BOUNDARY_RE` and 32-char cap can put
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
  ASSEMBLYAI_TTS_HOST,
  type AssemblyAITtsOptions,
  assemblyAITtsLanguageCodes,
  resolveAssemblyAITtsLanguage,
  resolveAssemblyAITtsSettings,
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
import { PROVIDER_WS_OPTIONS } from "../../_ws.ts";
import { createGuardedWs, dropSocket as dropSocketShared, openGuardedWs } from "../_socket.ts";
import {
  assertPcm16Rate,
  closeOnAbort,
  createTtsSessionShell,
  requireApiKey,
  type SessionShell,
  waitForOpen,
} from "../_utils.ts";
import { splitSegment } from "./assemblyai-segment.ts";
import { createTurnTracker, type SynthesisAck } from "./assemblyai-turn.ts";
import { createWordTimeline, readWordBoundaries } from "./assemblyai-words.ts";

export interface AssemblyAITtsSession extends TtsSession {
  /** @internal Test-only: exposes the underlying raw WebSocket. */
  readonly _ws: WebSocket;
}

interface AssemblyAITtsMessage {
  type: "Begin" | "Audio" | "FlushDone" | "Warning" | "Error" | "WordBoundaries" | string;
  /** Base64 PCM16 LE payload on `Audio` frames. */
  audio?: string;
  /** Word timings on `WordBoundaries` frames — shape read defensively. */
  words?: unknown;
  /** Set on the last `Audio` frame of a synthesis by some server versions. */
  is_final?: boolean;
  error?: string;
  error_code?: string | number;
  warning?: string;
}

/**
 * `(code): reason`, with a fallback so a detail-less frame still reads.
 *
 * Named for the FRAME rather than `errorDetail`, which is the repo-wide helper
 * in `sdk/utils.ts` (a `cause`/`detail` reader over an unknown throwable) and
 * is in scope everywhere — one name meaning two things in one file is how the
 * wrong one gets imported.
 */
function formatErrorFrame(msg: AssemblyAITtsMessage): string {
  const reason = msg.error?.trim() ? msg.error : "unknown";
  return `(${msg.error_code ?? ""}): ${reason}`;
}

function buildUrl(
  opts: AssemblyAITtsOptions,
  sampleRate: number,
  fail: (message: string) => Error,
): string {
  const params = new URLSearchParams({
    voice: resolveAssemblyAITtsSettings(opts).voice,
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
  // Length-checked rather than `??`: an empty `host` is a misconfiguration, and
  // treating it as "unset" beats building `wss:///v1/ws/` and failing at connect.
  const host = (opts.host?.length ?? 0) > 0 ? opts.host : ASSEMBLYAI_TTS_HOST;
  return `wss://${host}/v1/ws/?${params.toString()}`;
}

/**
 * Handle one server frame. Extracted to keep `open()` under the cognitive
 * complexity limit; turn state is threaded through the callbacks.
 *
 * Emits through `shell`, never the raw emitter: this runs inside a socket
 * 'message' handler, where a throw from a downstream listener escapes into
 * Node's EventEmitter as an uncaughtException — taking down a multi-tenant host
 * rather than one session.
 */
function handleMessage(
  raw: WebSocket.Data,
  shell: SessionShell<TtsEvents>,
  onSynthesisComplete: (ack: SynthesisAck) => void,
  onWords: (msg: AssemblyAITtsMessage) => void,
): void {
  const msg = safeJsonParse(typeof raw === "string" ? raw : raw.toString()) as
    | AssemblyAITtsMessage
    | undefined;
  if (msg === undefined) return;

  switch (msg.type) {
    case "Audio": {
      if (typeof msg.audio === "string") {
        const pcm = bytesToPcm16(base64ToUint8(msg.audio));
        if (pcm.length > 0) shell.emit("audio", pcm);
      }
      // Older servers flag the final frame; the live one uses FlushDone.
      if (msg.is_final) onSynthesisComplete("is_final");
      return;
    }
    case "FlushDone":
      onSynthesisComplete("flush_done");
      return;
    case "WordBoundaries":
      // Deliberately NOT an acknowledgement — see the module doc.
      onWords(msg);
      return;
    case "Error":
      shell.streamError(`AssemblyAI TTS ${formatErrorFrame(msg)}`);
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

      // Raw key, not `Bearer` — see the module doc.
      const createSocket = (): WebSocket =>
        new WebSocket(url, {
          headers: { Authorization: apiKey },
          ...PROVIDER_WS_OPTIONS,
        });
      // The guard listener protects against a late socket error with zero
      // listeners crashing the process; the RECONNECT path builds its socket
      // this way and opens it itself, because it must not block `cancel()`.
      const connect = (): WebSocket =>
        createGuardedWs(createSocket, connectError, "AssemblyAI TTS");

      // Bounded and abort-wired: an upgrade that black-holes must not leave
      // `open()` pending with a socket nobody owns — see `openGuardedWs`.
      let ws = await openGuardedWs({
        create: createSocket,
        label: "AssemblyAI TTS",
        makeConnectError: connectError,
        signal: openOpts.signal,
      });

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

      const shell = createTtsSessionShell({
        emitter,
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
        shell.emit("done");
      });

      const onSynthesisComplete = (ack: SynthesisAck): void => turn.onAck(ack);

      // Word timings, rebased onto the turn's own audio timeline. A frame that
      // lands once the turn is over belongs to no reply — dropping it is what
      // keeps a late frame from being attributed to the next one.
      const timeline = createWordTimeline();
      const onWords = (msg: AssemblyAITtsMessage): void => {
        if (!turn.inFlight()) return;
        const words = timeline.rebase(readWordBoundaries(msg));
        if (words.length > 0) shell.emit("words", words);
      };

      const attach = (socket: WebSocket): void => {
        socket.on("message", (raw: WebSocket.Data) => {
          if (shell.isClosed()) return;
          handleMessage(raw, shell, onSynthesisComplete, onWords);
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
        void waitForOpen(next, { timeoutMs: TTS_RECONNECT_TIMEOUT_MS }).then(
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
          // First text of a new turn — nothing from the last one carries over,
          // the word timeline included (it re-anchors this turn's first frame
          // at zero).
          if (!turn.inFlight()) timeline.reset();
          turn.onTurnText();
          buffered += text;
          // Synthesize each segment as it lands rather than waiting for the end
          // of the turn — see the module doc. Loops because one delta can carry
          // more than one segment's worth: the budget split takes ~40 chars at a
          // time, so a burst (a whole buffered sentence, a cover phrase arriving
          // alongside the reply's opening) would otherwise dribble out one segment per
          // later delta and stall completely if no delta followed.
          for (let split = splitSegment(buffered); split; split = splitSegment(buffered)) {
            buffered = split.tail;
            if (!(send({ type: "Generate", text: split.head }) && send({ type: "Flush" }))) return;
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
          timeline.reset();
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

        on: shell.on,

        close: shell.close,

        get _ws() {
          return ws;
        },
      };

      return session;
    },
  };
}
