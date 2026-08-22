// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:telephony` epoch 1.
 *
 * **"Frozen" means this file must keep compiling against current source for as
 * long as epoch 1 is advertised as supported.** A compile error here is the
 * finding, not something to edit away — `pnpm typecheck` is the
 * backward-compatibility gate for this capability. Imports are RELATIVE
 * (`../../../runtime-barrel.ts`) because the package cannot resolve itself by
 * name.
 *
 * What a host writes at this seam, in the order it writes it:
 *
 * - **A {@link CarrierCodec} for a carrier this build does not ship.** That is
 *   the whole of adding one: everything downstream of the codec is
 *   vendor-neutral, so a third carrier is a codec and no change anywhere else.
 *   The two obligations are stated on the type and both are load-bearing here —
 *   `decode` NEVER throws (a carrier is free to add frame types, and an
 *   unrecognized one must degrade to `"ignore"` rather than take down a live
 *   call), and `clear` must really produce the carrier's discard-buffered-audio
 *   frame, because that is what makes barge-in audible on a phone: the carrier
 *   holds seconds of the agent's reply beyond the reach of anything the session
 *   drops on its side.
 * - **A route that picks the codec off the query string** and refuses an
 *   unknown value instead of guessing. Serving one carrier's framing to another
 *   connects a socket that then exchanges nothing in either direction, which is
 *   much worse to debug than a refused upgrade.
 * - **`startTelephonySession` for the ordinary case, `createTelephonyBridge`
 *   when the host wants its own session options.** The bridge IS the socket the
 *   runtime sees, so a phone call needs no second session implementation.
 */

import { isRecord } from "@alexkroman1/aai/utils";

import {
  CARRIER_CODECS,
  CARRIER_PARAM,
  type CarrierCodec,
  type CarrierInbound,
  type CarrierName,
  carrierByName,
  createTelephonyBridge,
  type SessionRuntime,
  type SessionWebSocket,
  startTelephonySession,
  TELEPHONY_PATH,
  TELEPHONY_SAMPLE_RATE,
  type TelephonyBridgeOptions,
  telnyxCodec,
  twilioCodec,
} from "../../../runtime-barrel.ts";

/** Close code sent when we refuse a media stream we cannot frame. */
const WS_CLOSE_POLICY = 1008;

function recordAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function stringAt(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function numberAt(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

/**
 * A third carrier: same protocol in outline as the two shipped ones — a
 * WebSocket the carrier opens to us carrying JSON that wraps base64 μ-law —
 * and different only in field names and in which identifier an outbound frame
 * has to echo. This one discriminates on `type` rather than `event`, nests the
 * audio under `audio.data`, and requires its `stream_id` back on everything we
 * send.
 */
export const vocalisCodec: CarrierCodec = {
  name: "vocalis",

  decode: (frame): CarrierInbound => {
    // No Zod, deliberately: this runs 50 times a second for the life of every
    // call, and the shapes are three fields deep. Every path returns a value —
    // there is no `throw` anywhere in here, and an unreadable frame is
    // "ignore".
    const type = stringAt(frame, "type");
    if (type === "audio") {
      const payload = stringAt(recordAt(frame, "audio"), "data");
      // A carrier streaming both directions echoes the agent's own speech back
      // on a second track. Transcribing that would read every reply as a
      // barge-in against itself, so anything not the caller's track is ignored.
      const track = stringAt(recordAt(frame, "audio"), "track");
      if (payload === null || (track !== null && track !== "caller")) return { kind: "ignore" };
      return { kind: "media", payload };
    }
    if (type === "start") {
      const stream = recordAt(frame, "stream");
      const format = recordAt(stream, "format");
      return {
        kind: "start",
        // An unusable id is not a reason to refuse a call whose audio is
        // otherwise fine — the empty string is what the shipped codecs fall
        // back to as well.
        streamId: stringAt(stream, "id") ?? "",
        encoding: stringAt(format, "codec"),
        sampleRate: numberAt(format, "rate"),
      };
    }
    if (type === "end") return { kind: "stop" };
    return { kind: "ignore" };
  },

  media: (payload, streamId) => ({
    type: "audio",
    stream_id: streamId ?? "",
    audio: { data: payload },
  }),

  // The barge-in frame. Without it the caller talks over an agent that keeps
  // speaking for several seconds after being interrupted, because the audio
  // they are hearing is already in the carrier's buffer.
  clear: (streamId) => ({ type: "flush", stream_id: streamId ?? "" }),
};

/** Every carrier THIS build serves: the two shipped ones plus ours. */
export const CARRIERS: Record<string, CarrierCodec> = {
  ...CARRIER_CODECS,
  [vocalisCodec.name]: vocalisCodec,
};

/** The names that came with the SDK, for a health endpoint or a startup log. */
export const SHIPPED_CARRIERS: readonly CarrierName[] = [twilioCodec.name, telnyxCodec.name];

/**
 * The codec for a `?carrier=` value, ours first.
 *
 * `carrierByName` is what supplies the two shipped codecs AND the default for
 * an absent value (Twilio, so hand-written TwiML needs no query string). An
 * unknown value stays null rather than falling back — see the module doc.
 */
export function carrierFor(requested: string | null): CarrierCodec | null {
  if (requested === null || requested === "") return carrierByName(requested);
  return CARRIERS[requested] ?? null;
}

/**
 * Whether a carrier's declared media format is one the bridge's μ-law
 * arithmetic holds for. Informational only: the audio is what it is, and an
 * absent rate means the carrier did not say.
 */
export function declaresTelephonyAudio(inbound: CarrierInbound): boolean {
  if (inbound.kind !== "start") return true;
  return inbound.sampleRate === null || inbound.sampleRate === TELEPHONY_SAMPLE_RATE;
}

/**
 * The `/phone` front door, for a host that routes its own upgrades.
 *
 * Returns whether this route claimed the request — a refusal is still this
 * route's to answer.
 */
export function serveCarrierUpgrade(
  url: string,
  socket: SessionWebSocket,
  runtime: SessionRuntime,
): boolean {
  // A relative request target: the base only has to parse.
  const target = new URL(url, "http://carrier.invalid");
  if (target.pathname !== TELEPHONY_PATH) return false;
  const carrier = carrierFor(target.searchParams.get(CARRIER_PARAM));
  if (carrier === null) {
    socket.close?.(WS_CLOSE_POLICY, "unknown carrier");
    return true;
  }
  // The whole of the integration at the session layer: no session option is
  // set, because the defaults are already right for a phone call — and the one
  // that would be tempting to change (`audioLeadMs`) must stay paced.
  startTelephonySession(socket, runtime, { carrier });
  return true;
}

/**
 * The same call, started by hand, which is what `createTelephonyBridge` is
 * separately public for: the bridge is socket-shaped, so a host that wants its
 * own `logContext` (a carrier call id it can correlate against its own
 * records) hands it to `startSession` itself.
 */
export function startCorrelatedCall(
  socket: SessionWebSocket,
  runtime: SessionRuntime,
  opts: TelephonyBridgeOptions,
  callId: string,
): void {
  const bridge: SessionWebSocket = createTelephonyBridge(socket, opts);
  runtime.startSession(bridge, {
    logContext: { transport: "phone", carrier: opts.carrier.name, callId },
  });
}
