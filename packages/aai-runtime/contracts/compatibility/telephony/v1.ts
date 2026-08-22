// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 TEMPLATE: `aai-runtime:telephony` — a third carrier.
 *
 * This is the starter as it was written at epoch 1: one {@link CarrierCodec}
 * for a carrier this build does not ship, registered beside the two shipped
 * ones, plus the `/phone` upgrade that serves it. Copy the file into your host,
 * rename {@link myCarrierCodec}, and replace every field name marked `// ←`
 * with your carrier's. Everything downstream of the codec is vendor-neutral, so
 * that is the whole of adding a carrier — no change anywhere else.
 *
 * **FROZEN.** This file must keep compiling against current source for as long
 * as epoch 1 is supported — a compile error here is the finding, not something
 * to edit away. The way to change this API is a NEW epoch carrying a new
 * template, never an edit to this one. (Imports are relative because the
 * package cannot resolve itself by name; in your copy they are
 * `@alexkroman1/aai-runtime`.)
 *
 * **Three rules to keep, each of which is a broken call rather than a failed
 * build if you drop it:**
 *
 * - `decode` NEVER throws. Carriers add frame types; an unrecognized or
 *   malformed one degrades to `"ignore"`. A throw here takes down a live call
 *   over a field you had no reason to read.
 * - `clear` must really produce your carrier's discard-buffered-audio frame.
 *   That is what makes barge-in audible on a phone: the carrier holds seconds
 *   of the agent's reply beyond the reach of anything the session drops on its
 *   own side.
 * - An unknown `?carrier=` value is REFUSED, never guessed. Serving one
 *   carrier's framing to another connects a socket that then exchanges nothing
 *   in either direction, which is far worse to debug than a refused upgrade.
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
} from "../../../runtime-barrel.ts";

// ---------------------------------------------------------------------------
// Edit points
// ---------------------------------------------------------------------------

/** The `?carrier=` value that selects this codec, and its name in logs. */
const MY_CARRIER = "my-carrier"; // ← your carrier

/** Query parameter carrying your carrier's own call id, if it sends one. */
const CALL_ID_PARAM = "call_id"; // ←

/** Close code for an upgrade we refuse. 1008 = policy violation. */
const WS_CLOSE_POLICY = 1008;

// ---------------------------------------------------------------------------
// Field probes — no schema library, deliberately
// ---------------------------------------------------------------------------
// `media` arrives every 20 ms in each direction for the life of every call, and
// the shapes are three fields deep. Probe field by field and return a value on
// every path.

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

// ---------------------------------------------------------------------------
// The codec
// ---------------------------------------------------------------------------

/** The caller's audio track. Anything else is the agent's own speech echoed
 * back on a second track — transcribing that reads every reply as a barge-in
 * against itself. An absent track means a single-track stream, i.e. the
 * caller. */
function isCallerTrack(audio: unknown): boolean {
  const track = stringAt(audio, "track"); // ←
  return track === null || track === "caller"; // ←
}

/** The stream-start frame: the id every outbound frame has to echo, plus
 * whatever the carrier says about the media format. */
function decodeStart(frame: unknown): CarrierInbound {
  const stream = recordAt(frame, "stream"); // ←
  const format = recordAt(stream, "format"); // ←
  return {
    kind: "start",
    // An unusable id is not a reason to refuse a call whose audio is otherwise
    // fine — the shipped codecs fall back to the empty string too.
    streamId: stringAt(stream, "id") ?? "", // ←
    encoding: stringAt(format, "codec"), // ←
    sampleRate: numberAt(format, "rate"), // ←
  };
}

/**
 * Your carrier's framing.
 *
 * The outline is the one both shipped carriers use — a WebSocket the carrier
 * opens to us, carrying JSON that wraps base64 μ-law — so in practice only the
 * field names below change. This one discriminates on `type`, nests audio under
 * `audio.data`, and wants its `stream_id` echoed on everything we send.
 */
export const myCarrierCodec: CarrierCodec = {
  name: MY_CARRIER,

  decode: (frame): CarrierInbound => {
    const type = stringAt(frame, "type"); // ← your carrier's discriminator
    if (type === "audio") {
      const audio = recordAt(frame, "audio"); // ←
      const payload = stringAt(audio, "data"); // ← base64 μ-law
      if (payload === null || !isCallerTrack(audio)) return { kind: "ignore" };
      return { kind: "media", payload };
    }
    if (type === "start") return decodeStart(frame); // ←
    if (type === "end") return { kind: "stop" }; // ← the caller hung up
    // Keepalives, marks, DTMF, frame types your carrier adds next year.
    return { kind: "ignore" };
  },

  // One chunk of agent speech, base64 μ-law, with the id echoed back.
  media: (payload, streamId) => ({
    type: "audio", // ←
    stream_id: streamId ?? "", // ←
    audio: { data: payload }, // ←
  }),

  // The barge-in frame. Not optional — see the module doc.
  clear: (streamId) => ({ type: "flush", stream_id: streamId ?? "" }), // ←
};

// ---------------------------------------------------------------------------
// What this build serves
// ---------------------------------------------------------------------------

/** Every carrier this build can frame: the two shipped ones plus ours. */
export const CARRIERS: Record<string, CarrierCodec> = {
  ...CARRIER_CODECS,
  [myCarrierCodec.name]: myCarrierCodec,
};

/** The names that came with the SDK. */
export const SHIPPED_CARRIERS: readonly CarrierName[] = Object.keys(CARRIER_CODECS);

/**
 * One line for a boot log or a health endpoint.
 *
 * Worth printing: the bridge's μ-law arithmetic assumes
 * {@link TELEPHONY_SAMPLE_RATE}, so a carrier configured to stream at anything
 * else produces audio that connects and is unintelligible.
 */
export function carrierStartupLine(): string {
  const mine = Object.keys(CARRIERS).filter((name) => !SHIPPED_CARRIERS.includes(name));
  return `carriers: ${[...SHIPPED_CARRIERS, ...mine].join(", ")} @ ${TELEPHONY_SAMPLE_RATE} Hz mulaw`;
}

/**
 * The codec for a `?carrier=` value, ours first.
 *
 * `carrierByName` supplies the shipped codecs AND the default for an absent
 * value (Twilio, so hand-written TwiML needs no query string). An unknown value
 * stays null — see the module doc.
 */
export function carrierFor(requested: string | null): CarrierCodec | null {
  if (requested === null || requested === "") return carrierByName(requested);
  return CARRIERS[requested] ?? null;
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/**
 * Serve `/phone`, for a host that routes its own upgrades.
 *
 * Returns whether this route claimed the request — a refusal is still this
 * route's to answer, so `false` means "not my path", not "rejected".
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
  const callId = target.searchParams.get(CALL_ID_PARAM);
  if (callId === null) {
    // The ordinary case, and the whole of the integration at the session
    // layer. Set no session option: the defaults are already right for a phone
    // call, and the one that looks tempting (`audioLeadMs`) must stay paced.
    startTelephonySession(socket, runtime, { carrier });
  } else {
    startCorrelatedCall(socket, runtime, { carrier }, callId);
  }
  return true;
}

/**
 * The same call, started by hand, so this host's own log context goes on it.
 *
 * `createTelephonyBridge` is separately public for exactly this: the bridge IS
 * the socket the runtime sees, so a phone call needs no second session
 * implementation. Keep the call id if your carrier gives you one — it is the
 * only join between a session's logs and the carrier's own record of the call.
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
