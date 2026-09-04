// Copyright 2026 the AAI authors. MIT license.
/**
 * A phone call, presented to the runtime as an ordinary session socket.
 *
 * **The session stack is not changed by telephony, and that is the design.**
 * `SessionCore` talks to a `ClientSink`, `wireSessionSocket` talks to a
 * `SessionWebSocket`, and neither knows what is on the far end. So a
 * carrier's media stream does not need a second session implementation, a
 * second pacer, or a second lifecycle — it needs a socket-shaped adapter that
 * speaks the client protocol on one side and the carrier's framing on the
 * other. Everything the browser path already gets — turn-taking, barge-in,
 * tool calls, the audio pacer and its ordering rules, session eviction,
 * keepalives, start timeouts, teardown — a phone call gets for free, on the
 * same code, because it IS the same code.
 *
 * Two translations, in opposite directions:
 *
 * | direction | carrier | session |
 * | --- | --- | --- |
 * | caller speech | base64 μ-law, 8 kHz, in a JSON `media` frame | raw PCM16 binary at the session's input rate |
 * | agent speech | base64 μ-law, 8 kHz, in a JSON `media` frame | raw PCM16 binary at the session's TTS rate |
 *
 * **The rates are LEARNED, not configured.** The first thing any runtime
 * sends a new session is the protocol `config` frame carrying `sampleRate`
 * and `ttsSampleRate`, so the bridge reads them off the wire and builds its
 * converters then. That is what lets one adapter serve a 16 kHz pipeline
 * agent and a 24 kHz S2S agent with no per-agent configuration and no plumbing
 * through `createRuntimeServer` — which matters because the guest harness hands
 * `createRuntimeServer` a LAZY runtime facade that cannot answer a rate question
 * until the first session has already begun.
 *
 * **Pacing stays ON, deliberately.** A carrier accepts audio far faster than
 * it plays it and buffers the rest, which is precisely the shape that made
 * unpaced host-mode sessions destroy 36% of all agent audio (see
 * "Host-mode audio pacing" in `packages/aai/CLAUDE.md`): the backlog builds
 * on the far side, where `PacedAudioSink.clear()` cannot reach it. Paced, the
 * backlog stays here and a barge-in drops it. The carrier's own buffer is
 * emptied by the `clear` frame — see {@link CarrierCodec.clear}.
 */

import { WS_OPEN } from "@alexkroman1/aai/host-internal";
import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
import { base64ToUint8, uint8ToBase64 } from "../_base64.ts";
import { bytesToPcm16, pcm16ToBytes } from "../_pcm.ts";
import type { Logger } from "../runtime-config.ts";
import { consoleLogger } from "../runtime-config.ts";
import type { SessionWebSocket } from "../ws-frames.ts";
import { type CarrierCodec, type CarrierInbound, isMulawFormat } from "./carriers.ts";
import { mulawToPcm16, pcm16ToMulaw, TELEPHONY_SAMPLE_RATE } from "./mulaw.ts";
import { createResampler, type Resampler } from "./resample.ts";

/** The `audio_ready` frame, synthesized when the carrier's stream starts. */
/**
 * The only four session events this bridge acts on, as a scan over the raw frame.
 *
 * A prefilter and NOT the branch itself: a match still goes through
 * `safeJsonParse` and the `type ===` tests below, so a transcript that happens
 * to quote one of these names costs a parse and is then dropped exactly as
 * before. Kept beside the branches it mirrors — a name added there needs adding
 * here, and the spec asserts the pair.
 */
export const ACTED_ON_EVENTS =
  /"(?:session\.configured|reply\.cancelled|session\.reset|error\.reported)"/;

const AUDIO_READY_FRAME = JSON.stringify({ type: "audio_ready" });

/** Close code sent when the carrier ends the stream (the caller hung up). */
const WS_CLOSE_NORMAL = 1000;

/** Options for {@link createTelephonyBridge}. */
export type TelephonyBridgeOptions = {
  /** Framing for the carrier on the other end — see `carriers.ts`. */
  carrier: CarrierCodec;
  /** Structured logger. Defaults to the console logger. */
  logger?: Logger;
};

type MessageListener = (event: { data: unknown }) => void;
type CloseListener = (event: { code?: number; reason?: string }) => void;

/**
 * Read a carrier frame's payload as text.
 *
 * `ws` hands text frames over as strings through the EventTarget API, but a
 * carrier is free to send its JSON in a binary frame and at least one proxy
 * in the path may rewrite it — decoding bytes costs nothing and turns a whole
 * class of "the call connects and nothing happens" into working audio.
 */
function frameText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf-8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
  return null;
}

function asBytes(data: string | ArrayBuffer | Uint8Array): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

/**
 * Wrap a carrier's media-stream socket as a `SessionWebSocket`, ready to
 * hand straight to `runtime.startSession`.
 *
 * @example
 * ```ts
 * import { createTelephonyBridge, twilioCodec } from "@alexkroman1/aai-runtime";
 * declare const runtime: import("@alexkroman1/aai-runtime").AgentRuntime;
 * declare const carrierSocket: import("@alexkroman1/aai-runtime").SessionWebSocket;
 *
 * runtime.startSession(createTelephonyBridge(carrierSocket, { carrier: twilioCodec }));
 * ```
 *
 * @public
 */
export function createTelephonyBridge(
  carrierSocket: SessionWebSocket,
  opts: TelephonyBridgeOptions,
): SessionWebSocket {
  const { carrier } = opts;
  const log = opts.logger ?? consoleLogger;

  /** Echoed on outbound frames; Twilio drops frames that omit it. */
  let streamId: string | null = null;
  /** 8 kHz μ-law → the session's input rate. Built from the `config` frame. */
  let toSession: Resampler | null = null;
  /** The session's TTS rate → 8 kHz. Built from the same frame. */
  let toCarrier: Resampler | null = null;

  const messageListeners: MessageListener[] = [];
  /**
   * Frames decoded before the runtime attached its listener.
   *
   * In practice the runtime wires up synchronously in the same tick the
   * bridge is created, so nothing lands here — but a dropped `start` would
   * cost the greeting and, with it, the opening of every call, which is too
   * quiet a failure to leave to event-loop ordering.
   */
  let pending: unknown[] | null = [];

  function emit(data: unknown): void {
    if (pending !== null) {
      pending.push(data);
      return;
    }
    for (const listener of messageListeners) listener({ data });
  }

  function sendToCarrier(frame: unknown): void {
    if (carrierSocket.readyState !== WS_OPEN) return;
    try {
      carrierSocket.send(JSON.stringify(frame));
    } catch (err) {
      log.debug("telephony: carrier send failed", { error: String(err) });
    }
  }

  /**
   * Build the converters from the protocol `config` frame.
   *
   * Idempotent by construction: a runtime sends `config` once per connection,
   * and rebuilding the converters mid-call would reset their filter state and
   * put a click in the audio.
   */
  function configure(sampleRate: number, ttsSampleRate: number): void {
    if (toSession !== null) return;
    toSession = createResampler(TELEPHONY_SAMPLE_RATE, sampleRate);
    toCarrier = createResampler(ttsSampleRate, TELEPHONY_SAMPLE_RATE);
    log.debug("telephony: session rates negotiated", {
      carrier: carrier.name,
      sampleRate,
      ttsSampleRate,
    });
  }

  /**
   * Set both resamplers from a `session.configured` frame.
   *
   * Its own function so {@link handleSessionEvent} stays a flat dispatch —
   * the narrowing costs two conditions, which is what took that function past
   * the cognitive-complexity ceiling when the fatal-error branch arrived.
   */
  function configureFrom(message: Record<string, unknown>): void {
    const { sampleRate, ttsSampleRate } = message;
    if (typeof sampleRate === "number" && typeof ttsSampleRate === "number") {
      configure(sampleRate, ttsSampleRate);
    }
  }

  /** Session → carrier: a protocol text frame. */
  function handleSessionEvent(text: string): void {
    // Scanned before it is PARSED. A session emits ~50 events a turn and this
    // bridge acts on four of them; everything else is "for a screen" (see the
    // tail of this function) and the transcript frames — the largest, and the
    // ones carrying a reply's cumulative text — are the bulk of what is thrown
    // away. One substring scan replaces a full parse plus its object graph for
    // the ~90% that cannot match, for the whole life of every call.
    if (!ACTED_ON_EVENTS.test(text)) return;
    const message = safeJsonParse(text);
    if (!isRecord(message)) return;
    const type = message.type;
    // `session.configured`, which is what `session-core.ts` EMITS. This branch
    // tested `"config"` — the one `config` in the protocol is
    // `HostConfigMessageSchema`, a client-to-SERVER host-mode frame that no
    // session ever sends outbound — so `configure()` never ran on any call: both
    // resamplers stayed null, every agent frame hit the "before the config
    // frame" drop below, and every caller frame was dropped silently by the
    // `toSession === null` guard in `handleCarrierFrame`.
    //
    // Measured against a stub agent over a real `/phone` socket: the call
    // connected, logged "Session ready", dropped the greeting's four audio
    // frames, and delivered ZERO samples to the STT across three seconds of
    // caller audio. Telephony connected and neither end could hear the other.
    //
    // The same file already carries this exact lesson about the reset branch —
    // "spent its life testing a type no runtime emits". That one was fixed and
    // this one was not, because the unit tests mint their own frame: see
    // `configFrame` in the spec, now typed against the protocol so a rename is a
    // compile error rather than a silent dead branch.
    if (type === "session.configured") {
      configureFrom(message);
      return;
    }
    // The caller interrupted, or the conversation was reset. Both mean the
    // audio the carrier is still holding is dead — see CarrierCodec.clear.
    // The reset event is `session.reset` on the wire, not `reset`: this branch
    // spent its life testing a type no runtime emits, so a `reset` command left
    // the carrier playing out a conversation the session had already discarded.
    // `ws-client-sink.ts` clears the pacer on exactly this pair.
    if (type === "reply.cancelled" || type === "session.reset") {
      sendToCarrier(carrier.clear(streamId));
      return;
    }
    // A FATAL error ends the call, and a phone having no screen is exactly why.
    // `error.reported` carries `fatal`, documented as "the session is over",
    // and `aai-ui` answers it by releasing the microphone and ending the call —
    // a person can SEE the banner and hang up. A caller cannot. Sorted with the
    // transcripts below, a session that could never speak left the carrier
    // socket open: measured on `aai dev` over a real `/phone` socket with both
    // providers 403ing, the call was still up 45 seconds after two fatal
    // frames, which on the PSTN is dead air the caller is paying for.
    //
    // Strictly on `fatal === true`. The flag is REQUIRED in the protocol for
    // this reason: a turn-level failure the session survives must not drop a
    // live call.
    if (type === "error.reported" && message.fatal === true) {
      log.warn("telephony: ending the call after a fatal session error", {
        carrier: carrier.name,
        code: typeof message.code === "string" ? message.code : undefined,
      });
      closeCarrier("session failed");
    }
    // Everything else is for a screen: transcripts, tool calls, agent state,
    // reply/turn boundaries. A phone has none, and the audio already carries
    // the conversation.
  }

  /** Session → carrier: one PCM16 chunk of agent speech. */
  function handleSessionAudio(bytes: Uint8Array): void {
    if (toCarrier === null) {
      // Only reachable if a runtime sent audio before its own `config` frame.
      log.warn("telephony: dropping agent audio received before the config frame");
      return;
    }
    const eightKhz = toCarrier.process(bytesToPcm16(bytes));
    if (eightKhz.length === 0) return;
    sendToCarrier(carrier.media(uint8ToBase64(pcm16ToMulaw(eightKhz)), streamId));
  }

  /** The carrier's stream has begun: pin the id and release the greeting. */
  function handleCarrierStart(frame: CarrierInbound & { kind: "start" }): void {
    streamId = frame.streamId === "" ? null : frame.streamId;
    if (!isMulawFormat(frame.encoding)) {
      // Informational, never fatal: the field is a declaration and the bytes
      // are what they are. A wrong guess here should not end a call whose
      // audio would otherwise have decoded fine.
      log.warn("telephony: carrier declared an unexpected media format", {
        carrier: carrier.name,
        encoding: frame.encoding,
        sampleRate: frame.sampleRate,
      });
    }
    log.info("telephony: call connected", { carrier: carrier.name, streamId });
    // What the browser client sends once its audio graph is live. It is what
    // releases the agent's greeting, so the call opens on the agent's own
    // opening line rather than on silence.
    emit(AUDIO_READY_FRAME);
  }

  /**
   * End the carrier's stream, whoever decided to.
   *
   * One spelling because both callers want the same thing and the same
   * swallow: a close that throws has nothing left to tell anyone, the socket
   * being what we were trying to shut.
   */
  function closeCarrier(reason: string): void {
    try {
      carrierSocket.close?.(WS_CLOSE_NORMAL, reason);
    } catch (err) {
      log.debug("telephony: close failed", { reason, error: String(err) });
    }
  }

  /** The carrier hung up. */
  function handleCarrierStop(): void {
    log.info("telephony: carrier ended the stream", { carrier: carrier.name });
    closeCarrier("carrier stopped the stream");
  }

  /** Carrier → session: one decoded carrier frame. */
  function handleCarrierFrame(data: unknown): void {
    const text = frameText(data);
    if (text === null) return;
    const frame = carrier.decode(safeJsonParse(text));
    if (frame.kind === "start") {
      handleCarrierStart(frame);
      return;
    }
    if (frame.kind === "stop") {
      handleCarrierStop();
      return;
    }
    if (frame.kind !== "media" || toSession === null) return;
    // A payload the CARRIER chose, so a drop is the one worth seeing most —
    // through this call's own logger rather than `_base64.ts`'s default.
    const pcm = toSession.process(mulawToPcm16(base64ToUint8(frame.payload, log)));
    if (pcm.length === 0) return;
    emit(pcm16ToBytes(pcm));
  }

  carrierSocket.addEventListener("message", (event) => {
    // This runs off a socket event with no caller to catch for it, and it
    // fans out into base64, DSP and JSON. An escaping throw would surface as
    // an uncaughtException and take the host down over one bad frame.
    try {
      handleCarrierFrame(event.data);
    } catch (err) {
      log.error("telephony: carrier frame handling failed", { error: String(err) });
    }
  });

  return {
    get readyState() {
      return carrierSocket.readyState;
    },
    get bufferedAmount() {
      // Passed through so the sink's stalled-link guard still fires. It reads
      // base64 μ-law rather than PCM16, so the byte budget corresponds to a
      // much longer stretch of audio than it does on the browser path — it
      // remains a stall detector, not a latency bound.
      return carrierSocket.bufferedAmount;
    },
    send(data) {
      if (typeof data === "string") {
        handleSessionEvent(data);
        return;
      }
      const bytes = asBytes(data);
      if (bytes !== null && bytes.byteLength > 0) handleSessionAudio(bytes);
    },
    close(code, reason) {
      carrierSocket.close?.(code, reason);
    },
    ping() {
      carrierSocket.ping?.();
    },
    addEventListener(type: string, listener: (event: never) => void): void {
      if (type === "message") {
        messageListeners.push(listener as MessageListener);
        // First listener: release anything the carrier sent before the
        // runtime was wired up, in arrival order.
        const queued = pending;
        pending = null;
        if (queued) for (const data of queued) (listener as MessageListener)({ data });
        return;
      }
      // `open`, `close` and `error` are the carrier socket's own events —
      // the bridge adds no lifecycle of its own, so they pass straight
      // through and the session's teardown is driven by the real socket.
      if (type === "open") carrierSocket.addEventListener("open", listener as () => void);
      else if (type === "close") carrierSocket.addEventListener("close", listener as CloseListener);
      else if (type === "error")
        carrierSocket.addEventListener("error", listener as (e: { message?: string }) => void);
    },
  } satisfies SessionWebSocket;
}
