// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI streaming TTS opener (host-only).
 *
 * One long-lived WebSocket per session against `wss://tts.us.assemblyai.com/v1/ws`
 * (or the EU host), per https://www.assemblyai.com/docs/tts. Voice
 * (`voice_id`), language and sample rate are fixed at connect time as query
 * params — `assemblyai-wire.ts` builds the URL.
 *
 * **Auth.** The raw API key in `Authorization`, as the docs show (they accept a
 * `Bearer ` prefix too). A rejected key — or a rejected param, such as an
 * unknown `voice_id` (3012) — arrives AFTER the upgrade: the server sends an
 * `Error` frame instead of `Begin` and closes, so bad credentials surface as
 * `tts_stream_error`, not `tts_auth_failed` (which only covers a key missing
 * from the agent's env).
 *
 * **Protocol.** The server opens with `Begin`, but this adapter does not wait
 * for it: the rate is already fixed by the `sample_rate` query param, and a
 * frame sent before `Begin` is processed in order. Client sends
 * `{type:"Generate",text}` and `{type:"Flush"}`; the server replies with
 * `{type:"Audio", audio:<base64 PCM16 LE>, flush_id}` frames and ends each
 * flush with `FlushDone`. `Error` frames carry `error_code` + `error`.
 * `Terminate` closes cleanly.
 * `WordBoundaries` frames carry per-word audio offsets; they are parsed and
 * re-emitted as the `words` TtsEvent (see `assemblyai-words.ts`, which owns the
 * tolerant parse and the rebase onto the turn's timeline). They are NOT
 * acknowledgements — routing one into the turn tracker would end the reply
 * mid-synthesis.
 *
 * See `assemblyai-frames.ts` for the frame vocabulary, which is read back
 * from the SERVICE rather than inferred — including why there is no
 * continuous/streaming mode to switch on.
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
 * ack" either. That bookkeeping lives in `assemblyai-turn.ts`
 * (`createTurnTracker`).
 *
 * **Cancel.** A mid-turn `cancel()` sends a `Cancel` frame and KEEPS the
 * socket; the service's `Cancelled` is the boundary past which the abandoned
 * turn's frames stop arriving, and until it lands this adapter drops that
 * turn's audio, acks and word timings (never its `Error` frames, which
 * describe the socket rather than the turn). Dropping the connection and
 * reconnecting is the FALLBACK, for a socket that cannot carry the frame or
 * will not answer one. That is one measured rule, and when the socket is
 * replaced is a statechart in `assemblyai-lifecycle.ts` — read it before
 * changing the barge-in path; this doc claimed for a long time that no cancel
 * frame existed. Text sent while a replacement socket is still connecting is
 * queued and flushed to it on open.
 *
 * **Control frames are budgeted.** `Flush`, `Cancel` and `KeepAlive` share one
 * service-side rate limit, and a session over it is closed with `3010`. A fast
 * LLM emitting many short sentences used to send one `Flush` per sentence
 * straight into it; `assemblyai-control-budget.ts` holds the budget and why,
 * and when a `Flush` would overspend it the adapter keeps buffering and merges
 * what accumulated into the next one. A reply's FIRST flush may spend the
 * reserve, so the budget never delays first audio. A `3010` that happens anyway
 * is RECOVERED, not fatal: the socket is replaced (`RECOVER` in
 * `assemblyai-lifecycle.ts`) and the flushes it still owed are re-sent, minus
 * the one that was mid-synthesis — see `recoverPacing`.
 */

import {
  ASSEMBLYAI_TTS_API_KEY_ENV,
  resolveAssemblyAITtsSettings,
  TTS_KEEPALIVE_INTERVAL_MS,
  TTS_RECONNECT_TIMEOUT_MS,
} from "@alexkroman1/aai/host-internal";
import type { AssemblyAITtsOptions } from "@alexkroman1/aai/tts";
import { errorMessage } from "@alexkroman1/aai/utils";
import { createNanoEvents, type Emitter } from "nanoevents";
import WebSocket from "ws";
import { PROVIDER_WS_OPTIONS } from "../../_ws.ts";
import {
  type CreateProviderSocket,
  createGuardedWs,
  createProviderSocket,
  dropSocket as dropSocketShared,
  openGuardedWs,
} from "../_socket.ts";
import {
  assertPcm16Rate,
  closeOnAbort,
  createTtsSessionShell,
  type ProviderSocket,
  requireApiKey,
  waitForOpen,
} from "../_utils.ts";
import {
  createTtsError,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
} from "../openers.ts";
import { CONTROL_FRAME_RESERVE, createControlBudget } from "./assemblyai-control-budget.ts";
import {
  type AssemblyAITtsMessage,
  type CancelWindow,
  handleMessage,
  TTS_PACING_CLOSE_CODE,
} from "./assemblyai-frames.ts";
import { createAssemblyAITtsLifecycle } from "./assemblyai-lifecycle.ts";
import { splitSegment } from "./assemblyai-segment.ts";
import { createTurnTracker } from "./assemblyai-turn.ts";
import { assemblyAITtsUrl, generateFrames } from "./assemblyai-wire.ts";
import { createWordTimeline, readWordBoundaries } from "./assemblyai-words.ts";

/**
 * A second pacing close inside this window is fatal rather than recovered:
 * whatever is sending too fast is not something a reconnect fixes, and every
 * reconnect is a new session start against the account's per-minute allowance
 * (3009).
 */
export const TTS_PACING_RECOVERY_WINDOW_MS = 10_000;

/** Every complete segment at the front of `buffered`, merged, and what is left. */
function mergeSegments(buffered: string): { head: string; tail: string } {
  let head = "";
  let tail = buffered;
  for (let split = splitSegment(tail); split; split = splitSegment(tail)) {
    head += split.head;
    tail = split.tail;
  }
  return { head, tail };
}

export interface AssemblyAITtsSession extends TtsSession {
  /** @internal Test-only: exposes the underlying raw WebSocket. */
  readonly _ws: ProviderSocket;
}

export function openAssemblyAITts(
  opts: AssemblyAITtsOptions,
  newSocket: CreateProviderSocket = createProviderSocket,
): TtsOpener {
  return {
    name: "assemblyai",
    async open(openOpts: TtsOpenOptions): Promise<TtsSession> {
      const apiKey = requireApiKey(
        openOpts.apiKey,
        ASSEMBLYAI_TTS_API_KEY_ENV,
        "AssemblyAI TTS",
        (msg) => createTtsError("tts_auth_failed", msg),
      );
      const connectError = (msg: string) => createTtsError("tts_connect_failed", msg);
      const sampleRate = assertPcm16Rate(openOpts.sampleRate, "AssemblyAI TTS", connectError);
      // Built once so an unsupported language throws here, at open, rather
      // than on a cancel-triggered reconnect mid-conversation.
      const settings = resolveAssemblyAITtsSettings(opts);
      const url = assemblyAITtsUrl(
        { voice: settings.voice, language: settings.language, sampleRate, host: opts.host },
        (msg) => connectError(`AssemblyAI TTS: ${msg}`),
      );

      // The raw key, as the docs show — see the module doc.
      const createSocket = (): ProviderSocket =>
        newSocket(url, {
          headers: { Authorization: apiKey },
          ...PROVIDER_WS_OPTIONS,
        });
      // The guard listener protects against a late socket error with zero
      // listeners crashing the process; the RECONNECT path builds its socket
      // this way and opens it itself, because it must not block `cancel()`.
      const connect = (): ProviderSocket =>
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
      // Frames for a post-cancel replacement socket that is still connecting
      // (the lifecycle's `queueing()`), flushed to it on open in order.
      const queued: Record<string, unknown>[] = [];
      // Accepted text not yet sent: `Generate` goes out only paired with a
      // `Flush`, so the server never holds unsynthesized text.
      let buffered = "";
      // When this session last put a frame on the wire, and the timer that
      // sends a `KeepAlive` once it has been quiet too long — see `send`.
      let lastSentAt = Date.now();
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      // Control frames (`Flush`, `Cancel`, `KeepAlive`) against the service's
      // rate limit — see `assemblyai-control-budget.ts`.
      const budget = createControlBudget();
      // Set while a segment is waiting on the budget: the timer that sends
      // the accumulated backlog as one merged flush (`pump`).
      let pumpTimer: ReturnType<typeof setTimeout> | undefined;
      // `flush()` ran while that backlog was waiting, so the pump also sends
      // the remainder and closes the turn.
      let closePending = false;
      // The reply has not flushed yet: its first flush may spend the reserve,
      // so the budget never delays first audio.
      let firstFlushOfTurn = false;
      // Text of each flush sent and not yet acknowledged, oldest first — what
      // a pacing recovery re-sends (`recoverPacing`).
      let unacked: string[] = [];
      // When a pacing close was last recovered; a second inside the window is fatal.
      let lastRecoveryAt: number | undefined;
      // Set by `recoverPacing` for the `replaceSocket` it triggers.
      let resendOnReplace: string | undefined;

      /** Forget everything waiting on the budget. */
      const clearBacklog = (): void => {
        clearTimeout(pumpTimer);
        pumpTimer = undefined;
        closePending = false;
      };

      /** Detach + politely close a socket without emitting anything for it. */
      const dropSocket = (socket: ProviderSocket): void =>
        dropSocketShared(socket, () => socket.send(JSON.stringify({ type: "Terminate" })));

      const shell = createTtsSessionShell({
        emitter,
        // `ws` is read at teardown time so a close after a cancel-reconnect
        // releases the replacement socket, not the one already dropped.
        // Closing the lifecycle first stops the ack deadline and any reconnect.
        teardown: () => {
          clearInterval(keepAlive);
          clearBacklog();
          lifecycle.send({ type: "CLOSE" });
          dropSocket(ws);
        },
      });

      // Flush/acknowledgement bookkeeping — which ack ends the turn — lives in
      // assemblyai-turn.ts. No closed
      // check: the shell's `emit` is already a no-op once the session closes.
      const turn = createTurnTracker(() => {
        // The turn is over, so text still held here belongs to nothing. Keeping
        // it would splice it into the next turn's first segment.
        buffered = "";
        unacked = [];
        clearBacklog();
        shell.emit("done");
      });

      const onSynthesisComplete = (): void => {
        unacked.shift();
        turn.onAck();
      };

      // Word timings, rebased onto the turn's own audio timeline.
      //
      // **A `WordBoundaries` frame may TRAIL its own flush's `FlushDone`, so the
      // turn being over is NOT a reason to drop one.** This guard was
      // `if (!turn.inFlight()) return`, and measured against the sandbox host
      // (2026-08-27) that dropped the final segment's frame on EVERY reply: the
      // frame lands ~20ms after the ack that ends the turn (`+5182 ms`
      // FlushDone, `+5205 ms` WordBoundaries), so the kept timings covered
      // 14.19s of 17.76s of audio and the reply's last segment always degraded
      // to `heardChars`'s proportional estimate — over exactly the span where
      // per-flush padding makes that estimate worst, which is the error word
      // timings exist to model (see `assemblyai-segment.ts`). It reaches
      // `buildTailResumePrompt` too, which is the one reader still live after
      // the turn's history is committed.
      //
      // What must be dropped instead is a frame belonging to a turn the NEXT
      // one has already replaced: the timeline has been reset by then, so
      // rebasing would anchor the old turn's offsets at zero on the new reply
      // and walk the heard cursor through text this turn never spoke. Note
      // `turn.inFlight()` never prevented THAT — a stale frame arriving once
      // the next turn has begun sees a turn in flight and passes — so the
      // window it closed was only the gap between `done` and the next turn's
      // first text, which is precisely where a trailing frame belongs.
      //
      // The residual is unchanged and unclosable from here: the socket answers
      // in order, so a stale frame still arrives before any of the new turn's
      // own, and nothing in the parse distinguishes them. The service does send
      // a `flush_id`, which is the field that would.
      const timeline = createWordTimeline();
      // Closed while no turn owns the word timeline: before the first turn, and
      // from a cancel until the next turn's first text (`turn.wordsOpen()`).
      const onWords = (msg: AssemblyAITtsMessage): void => {
        if (!turn.wordsOpen()) return;
        const words = timeline.rebase(readWordBoundaries(msg));
        if (words.length > 0) shell.emit("words", words);
      };

      // The `Cancel` → `Cancelled` window, as the frame handler reads it.
      const cancels: CancelWindow = {
        abandoned: () => lifecycle.abandoned(),
        onCancelled: () => lifecycle.send({ type: "CANCELLED" }),
      };

      // No closed checks in these handlers: every socket is detached by
      // `dropSocket` before it is released, the session's own included, and
      // what a late frame could reach — the shell, the turn, the lifecycle — is
      // inert once the session has closed.
      const attach = (socket: ProviderSocket): void => {
        socket.on("message", (raw: WebSocket.Data) => {
          handleMessage(raw, shell, onSynthesisComplete, onWords, cancels, recoverPacing);
        });
        socket.on("error", (err: Error) => shell.onSocketError(err));
        socket.on("close", (code: number) => {
          // A pacing close with no `Error` frame before it: same recovery.
          if (code === TTS_PACING_CLOSE_CODE && recoverPacing()) return;
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

      // Barge-in, and the reconnect that is its fallback — WHEN is the
      // statechart in assemblyai-lifecycle.ts; HOW is here. The socket survives
      // a cancel, so the abandoned turn's trailing frames are filtered until
      // the service acknowledges; a socket that cannot carry the `Cancel`, or
      // does not answer it in time, is replaced.
      const lifecycle = createAssemblyAITtsLifecycle({
        socketOpen: () => ws.readyState === WebSocket.OPEN,
        sendCancel: () => {
          // Spent unconditionally: a barge-in never waits on the budget, and
          // the reserve flushes cannot touch is what it spends.
          budget.take();
          ws.send(JSON.stringify({ type: "Cancel" }));
          lastSentAt = Date.now();
        },
        replaceSocket: (signal) => {
          // The abandoned turn's frames die with the socket, so nothing is left
          // to filter or to send.
          dropSocket(ws);
          queued.length = 0;
          const resend = resendOnReplace;
          resendOnReplace = undefined;
          let opened: Promise<void>;
          try {
            ws = connect();
            // Deadline, not just open-or-error: this open runs mid-session
            // with nothing upstream bounding it, and a black-holed connect (no
            // `open`, no `error`) would leave the session queueing forever —
            // every later turn's frames queue "successfully" while nothing
            // reaches the wire.
            opened = waitForOpen(ws, { timeoutMs: TTS_RECONNECT_TIMEOUT_MS, signal });
          } catch (cause) {
            opened = Promise.reject(cause);
          }
          // A turn begun since an unanswered `Cancel` sent its flushes on the
          // socket just dropped, and the shut window filtered their acks: none
          // will ever arrive, so without this its `done` never fires and the
          // pipeline's flush-wait hangs (`assemblyai-cancel-race.test.ts`).
          // After a `Cancel` that could not be sent, `turn.cancel()` has
          // already forgotten them and this changes nothing.
          //
          // A pacing recovery instead re-sends what the dropped socket owed,
          // as ONE flush queued ahead of anything else for the replacement.
          if (resend === undefined || resend.length === 0) {
            unacked = [];
            turn.abandonFlushes();
          } else {
            budget.take();
            queued.push(...generateFrames(resend), { type: "Flush" });
            unacked = [resend];
            turn.abandonFlushes(1);
          }
          return opened;
        },
        adoptSocket: () => {
          attach(ws);
          for (const frame of queued.splice(0)) ws.send(JSON.stringify(frame));
        },
        dropQueue: () => {
          queued.length = 0;
        },
        reconnectFailed: (cause) => {
          // Release the failed socket now — on timeout it may still open later
          // and would otherwise linger connected until session close.
          dropSocket(ws);
          shell.streamError(
            `AssemblyAI TTS: reconnect after cancel failed: ${errorMessage(cause)}`,
          );
        },
      });

      // No closed check: every caller is a session method that makes its own.
      const send = (payload: Record<string, unknown>): boolean => {
        if (lifecycle.queueing()) {
          queued.push(payload);
          return true;
        }
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(payload));
        lastSentAt = Date.now();
        return true;
      };

      // The service closes a socket that has received nothing for 120 s, and an
      // idle close is fatal to the session (see `attach`'s close handler) — so
      // a caller who talks for two minutes, or a harness that stalls, used to
      // end the call. A `KeepAlive` whenever the socket has been quiet for a
      // whole interval keeps the longest gap under two intervals, well inside
      // the window. Not while a replacement socket is still connecting: it has
      // nothing to keep alive yet, and `send` would only queue the frame.
      keepAlive = setInterval(() => {
        if (shell.isClosed() || lifecycle.queueing()) return;
        if (Date.now() - lastSentAt < TTS_KEEPALIVE_INTERVAL_MS) return;
        budget.take();
        send({ type: "KeepAlive" });
      }, TTS_KEEPALIVE_INTERVAL_MS);
      keepAlive.unref?.();

      /**
       * The service closed the socket for pacing (`3010`). Replace it and
       * re-send what it still owed, instead of ending the session.
       *
       * The OLDEST unacknowledged flush is the one being synthesized when the
       * close landed, and its audio has partly reached the caller already;
       * re-sending it would repeat the start of a sentence they just heard, so
       * it is dropped and the reply resumes at the next one. Everything after
       * it produced no audio yet and is re-sent as one merged flush. Returns
       * `false` — leaving the error fatal — when the session is closed or a
       * pacing close was already recovered within
       * {@link TTS_PACING_RECOVERY_WINDOW_MS}.
       */
      function recoverPacing(): boolean {
        if (shell.isClosed()) return false;
        const now = Date.now();
        if (lastRecoveryAt !== undefined && now - lastRecoveryAt < TTS_PACING_RECOVERY_WINDOW_MS) {
          return false;
        }
        lastRecoveryAt = now;
        resendOnReplace = turn.inFlight() ? unacked.slice(1).join("") : "";
        lifecycle.send({ type: "RECOVER" });
        return true;
      }

      /** Send `text` as one `Generate`+`Flush`; `false` when the socket refused it. */
      const sendFlush = (text: string): boolean => {
        // A segment can outgrow one `Generate` (a long run with no boundary,
        // or a merged backlog), so it is framed under the per-frame cap.
        if (!(generateFrames(text).every((frame) => send(frame)) && send({ type: "Flush" }))) {
          return false;
        }
        firstFlushOfTurn = false;
        unacked.push(text);
        turn.onFlushSent();
        return true;
      };

      /** The floor a `Flush` may spend the budget down to — see `firstFlushOfTurn`. */
      const flushFloor = (): number => (firstFlushOfTurn ? 0 : CONTROL_FRAME_RESERVE);

      /** Wake when the budget can pay for the next flush. */
      const schedulePump = (): void => {
        if (pumpTimer !== undefined) return;
        pumpTimer = setTimeout(pump, Math.max(1, budget.msUntil(flushFloor())));
        pumpTimer.unref?.();
      };

      /**
       * Send the backlog that waited on the budget as ONE flush: every complete
       * segment buffered meanwhile, merged, plus the remainder when the turn
       * was closed while it waited. This merge is what bounds the `Flush` rate.
       */
      function pump(): void {
        // No closed check: teardown clears the timer (`clearBacklog`).
        pumpTimer = undefined;
        if (!budget.tryTake(flushFloor())) {
          schedulePump();
          return;
        }
        const closing = closePending;
        closePending = false;
        // Closing: the turn has no more text, so the remainder goes too.
        const backlog = closing ? { head: buffered, tail: "" } : mergeSegments(buffered);
        buffered = backlog.tail;
        if (backlog.head.length > 0) sendFlush(backlog.head);
        // Even when the socket refused it, as `flush()` does: the pipeline has
        // no more text, and a turn left open would hang its flush-wait.
        if (closing) turn.closeTurn();
      }

      /**
       * Synthesize each segment as it lands rather than waiting for the end of
       * the turn — see the module doc. Loops because one delta can carry more
       * than one segment's worth: the budget split takes ~40 chars at a time,
       * so a burst (a whole buffered sentence, a cover phrase arriving alongside
       * the reply's opening) would otherwise dribble out one segment per later
       * delta and stall completely if no delta followed.
       */
      const flushSegments = (): void => {
        for (let split = splitSegment(buffered); split; split = splitSegment(buffered)) {
          // Over budget: keep buffering. What lands before the pump fires is
          // merged into one flush with this segment.
          if (!budget.tryTake(flushFloor())) {
            schedulePump();
            return;
          }
          buffered = split.tail;
          if (!sendFlush(split.head)) return;
        }
      };

      closeOnAbort(openOpts.signal, shell.close);

      const session: AssemblyAITtsSession = {
        sendText(text: string) {
          if (text.length === 0 || shell.isClosed()) return;
          // First text of a new turn — nothing from the last one carries over,
          // the word timeline included (it re-anchors this turn's first frame
          // at zero). This is also what CLOSES the previous turn's word window:
          // a frame arriving from here on is rebased onto THIS turn.
          if (turn.onTurnText()) {
            timeline.reset();
            firstFlushOfTurn = true;
          }
          buffered += text;
          // A backlog is already waiting on the budget: this text joins it and
          // goes out merged with it (`pump`), never ahead of it.
          if (pumpTimer === undefined) flushSegments();
        },

        flush() {
          if (shell.isClosed()) return;
          // A backlog waiting on the budget sends the remainder with it and
          // closes the turn then — closing now would end it with text unsent.
          if (pumpTimer !== undefined) {
            closePending = true;
            return;
          }
          if (buffered.length > 0) {
            if (!budget.tryTake(flushFloor())) {
              closePending = true;
              schedulePump();
              return;
            }
            const text = buffered;
            buffered = "";
            sendFlush(text);
          }
          // Nothing left to synthesize past this point. Every segment already
          // acknowledged means the turn's audio is complete; otherwise the last
          // outstanding acknowledgement ends it. Either way, do NOT send an
          // empty Flush — see the module doc.
          turn.closeTurn();
        },

        cancel() {
          if (shell.isClosed()) return;
          // The cancelled turn's flushes are abandoned: their acknowledgements
          // are either filtered by the cancel window, discarded with the queued
          // frames, or unobservable on a dropped socket. `done` is emitted
          // synchronously — the orchestrator's state machine advances on it,
          // and barge-in must not be microtask-deferred.
          buffered = "";
          unacked = [];
          clearBacklog();
          timeline.reset();
          // Also closes the word window: the abandoned turn's timings must not
          // reach the session (see `TurnTracker.cancel`).
          const turnInFlight = turn.cancel();
          // Idempotent: nothing sent since the last done means nothing is
          // buffered server-side and no audio is in flight.
          if (!turnInFlight) return;
          // `Cancel` discards the server's buffered text AND aborts synthesis
          // in progress, leaving the socket usable — measured; see
          // assemblyai-lifecycle.ts, which also decides what a socket that
          // cannot carry the frame, or one still connecting, gets instead.
          lifecycle.send({ type: "CANCEL" });
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
