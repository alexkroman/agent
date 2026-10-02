// Copyright 2026 the AAI authors. MIT license.

import { resolveSonioxSttSettings, SONIOX_API_KEY_ENV } from "@alexkroman1/aai/host-internal";
import type { SonioxSttOptions } from "@alexkroman1/aai/stt";
import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
import { createNanoEvents, type Emitter } from "nanoevents";
import type WebSocket from "ws";
import { createRestartableTimer } from "../../_timer.ts";
import { PROVIDER_WS_OPTIONS } from "../../_ws.ts";
import {
  type CreateProviderSocket,
  createProviderSocket,
  dropSocket,
  openGuardedWs,
  wireSttPcmSocket,
} from "../_socket.ts";
import { createSttSessionShell, requireApiKey } from "../_utils.ts";
import {
  createSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../openers.ts";

// `@soniox/speech-to-text-web` is browser-only (MediaRecorder/getUserMedia),
// so we speak the WebSocket protocol directly.
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

// Quiet window after an all-final frame before flushing the batched final on
// its own. Short enough that turn commit isn't perceptibly delayed, long
// enough to still batch a follow-up final that lands a frame or two later.
const SONIOX_FINAL_FLUSH_MS = 300;

interface SonioxToken {
  text?: string;
  is_final?: boolean;
}

interface SonioxResponse {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: number;
  error_message?: string;
}

/** Split one frame's tokens into its final text and its non-final preview. */
function consumeTokens(tokens: SonioxToken[]): { finals: string; nonFinal: string } {
  let finals = "";
  let nonFinal = "";
  for (const tok of tokens) {
    const text = tok.text ?? "";
    if (text.length === 0) continue;
    if (tok.is_final) {
      finals += text;
    } else {
      nonFinal += text;
    }
  }
  return { finals, nonFinal };
}

function buildConfigFrame(
  apiKey: string,
  opts: SonioxSttOptions,
  sampleRate: number,
): Record<string, unknown> {
  const settings = resolveSonioxSttSettings(opts);
  const config: Record<string, unknown> = {
    api_key: apiKey,
    model: settings.model,
    audio_format: "pcm_s16le",
    sample_rate: sampleRate,
    num_channels: 1,
  };
  if (settings.languageHints) {
    config.language_hints = [...settings.languageHints];
  }
  return config;
}

/**
 * Read one server frame, or `null` for anything that is not a JSON object.
 *
 * **The parse layer's contract is to drop — never to throw out of the socket's
 * `message` handler**, which would be an uncaughtException taking down a
 * multi-tenant host rather than one session. That is why the shape is probed
 * field by field from here on rather than trusted: the declared interface is a
 * description of what the service sends today, and `safeJsonParse` returns
 * whatever actually arrived.
 */
function parseFrame(raw: WebSocket.RawData): SonioxResponse | null {
  const parsed = safeJsonParse(raw.toString());
  if (!isRecord(parsed)) return null;
  return parsed as SonioxResponse;
}

/**
 * The batched final, as one explicit state.
 *
 * Soniox streams final tokens a few at a time, and contiguous finals are
 * batched into ONE `final` event, flushed when the next non-final preview
 * starts (or the stream says `finished`). Soniox runs without endpoint
 * detection, so an utterance whose last frames are all-final (the user stops,
 * no more partials) would otherwise sit buffered until the NEXT utterance's
 * first partial flushed it — the pipeline would never get a `final` and the
 * turn would never commit. So a quiet window flushes it on its own.
 *
 * - `idle`: nothing buffered, no quiet window running.
 * - `buffering`: `text` is owed as one `final`; the quiet window is armed for
 *   generation `gen`. A window that elapses for any other generation belongs
 *   to a batch that was already flushed and is dropped.
 */
type BatchState = { phase: "idle" } | { phase: "buffering"; text: string; gen: number };

type BatchEvent =
  /** One frame's final text, and whether the frame ends the batch (a preview or `finished`). */
  | { type: "frame"; finals: string; boundary: boolean }
  /** The quiet window armed for `gen` elapsed. */
  | { type: "quiet"; gen: number }
  /** The session is closing: whatever is buffered is owed now. */
  | { type: "close" };

/** What a transition asks of the timer and the session, in order. */
type BatchEffect =
  | { kind: "arm-quiet"; gen: number }
  | { kind: "clear-quiet" }
  | { kind: "emit-final"; text: string };

const IDLE: BatchState = { phase: "idle" };

/** The one transition function. Pure: `nextGen` is the generation a new batch takes. */
function stepBatch(
  state: BatchState,
  event: BatchEvent,
  nextGen: number,
): { next: BatchState; effects: readonly BatchEffect[] } {
  const buffered = state.phase === "buffering" ? state.text : "";
  switch (event.type) {
    case "frame": {
      const text = buffered + event.finals;
      if (text.length === 0) return { next: state, effects: [] };
      if (event.boundary) {
        return {
          next: IDLE,
          effects: [{ kind: "clear-quiet" }, { kind: "emit-final", text }],
        };
      }
      // Every all-final frame RESTARTS the window: the batch is still growing.
      const gen = state.phase === "buffering" ? state.gen : nextGen;
      return { next: { phase: "buffering", text, gen }, effects: [{ kind: "arm-quiet", gen }] };
    }
    case "quiet":
      if (state.phase !== "buffering" || state.gen !== event.gen)
        return { next: state, effects: [] };
      return { next: IDLE, effects: [{ kind: "emit-final", text: buffered }] };
    default:
      // `close`: flush the batch so the last utterance isn't dropped.
      return {
        next: IDLE,
        effects:
          buffered.length > 0
            ? [{ kind: "clear-quiet" }, { kind: "emit-final", text: buffered }]
            : [{ kind: "clear-quiet" }],
      };
  }
}

/**
 * Read one server frame into the batch: an `error_code` is a stream error, a
 * frame with no token ARRAY is dropped, and anything else steps the batch
 * before its preview (if any) goes out as a `partial`.
 */
function handleResponse(
  res: SonioxResponse,
  on: {
    streamError: (message: string) => void;
    frame: (finals: string, boundary: boolean) => void;
    partial: (text: string) => void;
  },
): void {
  if (res.error_code !== undefined) {
    on.streamError(`Soniox error ${res.error_code}: ${res.error_message ?? "unknown"}`);
    return;
  }
  // ARRAY-checked, not truthy-checked: `tokens.length === 0` is false for a
  // truthy non-array (`undefined === 0`), so `"tokens": 5` — a field with the
  // wrong type, which is what a service shipping a new shape emits — used to
  // reach the `for … of` below and throw "not iterable" straight out of
  // `ws.on("message")`, i.e. an uncaughtException on a multi-tenant host.
  // Dropping it keeps the rest of the frame usable: an `error_code` alongside
  // it is still surfaced above.
  if (!Array.isArray(res.tokens) || res.tokens.length === 0) return;
  const { finals, nonFinal } = consumeTokens(res.tokens);
  // The batched final goes out BEFORE this frame's preview, so a final never
  // lands after the next utterance's first partial.
  on.frame(finals, nonFinal.length > 0 || res.finished === true);
  if (nonFinal.length > 0) on.partial(nonFinal);
}

export function openSoniox(
  opts: SonioxSttOptions = {},
  createSocket: CreateProviderSocket = createProviderSocket,
): SttOpener {
  return {
    name: "soniox",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(openOpts.apiKey, SONIOX_API_KEY_ENV, "Soniox STT", (msg) =>
        createSttError("stt_auth_failed", msg),
      );

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();

      // Bounded and abort-wired: an upgrade that black-holes must not leave
      // `open()` pending with a socket nobody owns — see `openGuardedWs`. The
      // config frame goes out inside the same guarded window, since a failed
      // first send is a failed open.
      const ws = await openGuardedWs({
        create: () => createSocket(SONIOX_WS_URL, PROVIDER_WS_OPTIONS),
        label: "Soniox STT",
        makeConnectError: (msg) => createSttError("stt_connect_failed", msg),
        signal: openOpts.signal,
        onOpen: (socket) =>
          socket.send(JSON.stringify(buildConfigFrame(apiKey, opts, openOpts.sampleRate))),
      });

      let batch: BatchState = IDLE;
      let batchGen = 0;
      let quietGen = 0;
      const quietTimer = createRestartableTimer(() => step({ type: "quiet", gen: quietGen }));

      /**
       * Advance the batch and apply what the transition asks for. Every emit
       * goes through `emitFinal`: the shell's (closed latch, throw containment)
       * on a live session, a direct one during teardown — see below.
       */
      function step(
        event: BatchEvent,
        emitFinal = (text: string) => shell.emit("final", text),
      ): void {
        const { next, effects } = stepBatch(batch, event, batchGen + 1);
        if (next.phase === "buffering") batchGen = next.gen;
        batch = next;
        for (const effect of effects) {
          if (effect.kind === "arm-quiet") {
            quietGen = effect.gen;
            quietTimer.arm(SONIOX_FINAL_FLUSH_MS);
          } else if (effect.kind === "clear-quiet") {
            quietTimer.clear();
          } else {
            emitFinal(effect.text);
          }
        }
      }

      const shell = createSttSessionShell({
        emitter,
        teardown: () => {
          // Flush any batched final so the last utterance isn't dropped. This
          // runs after the shell marked the session closed, so `shell.emit`
          // (gated on `closed`) would swallow it — emit directly, still
          // containing a listener throw so it can't escape teardown.
          step({ type: "close" }, (text) => {
            try {
              emitter.emit("final", text);
            } catch {
              // A listener threw during teardown; nothing further to do.
            }
          });
          // Detach and close, leaving a zero-listener error guard so a late
          // error during the close handshake can't crash the process.
          dropSocket(ws);
        },
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        if (shell.isClosed()) return;
        const res = parseFrame(raw);
        if (!res) return;
        handleResponse(res, {
          streamError: (message) => shell.streamError(message),
          frame: (finals, boundary) => step({ type: "frame", finals, boundary }),
          partial: (text) => shell.emit("partial", text),
        });
      });

      const sendAudio = wireSttPcmSocket(ws, shell, openOpts.signal, "Soniox STT");

      return {
        sendAudio,
        on: shell.on,
        close: shell.close,
      };
    },
  };
}
