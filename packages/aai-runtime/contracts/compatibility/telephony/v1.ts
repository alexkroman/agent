// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:telephony` epoch 1.
 *
 * A THIRD CARRIER — implementing `CarrierCodec` and resolving it off a request.
 * That is what this capability is for: `twilioCodec` and `telnyxCodec` ship, so
 * the useful artifact is the alternative to them, and it is also the direction
 * that breaks first — an implementor owes every member of the interface, where a
 * caller of the two shipped ones owes nothing. Written the way it was authored at
 * epoch 1, and it must keep compiling for as long as that epoch is advertised as
 * supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * Epoch 2 widened `SessionRuntime`'s `Pick` to carry `deliverWorkflow`, the
 * replay engine's queue-delivery hook. It reaches this capability's report
 * because `startTelephonySession` takes a runtime facade — and it breaks nothing,
 * the member being optional: a host handing over the runtime it already had, or a
 * hand-written facade, compiles either way.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 1 has to be dropped with a reason.
 */

import {
  CARRIER_PARAM,
  type CarrierCodec,
  type CarrierInbound,
  carrierByName,
  TELEPHONY_PATH,
} from "../../../runtime-barrel.ts";

/** The frame shapes this carrier sends, as far as this codec reads them. */
type AcmeFrame = {
  type?: unknown;
  stream?: unknown;
  audio?: unknown;
  codec?: unknown;
  rate?: unknown;
};

function frameOf(value: unknown): AcmeFrame {
  return typeof value === "object" && value !== null ? (value as AcmeFrame) : {};
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * ── EDIT: your carrier's own frame vocabulary. ───────────────────────────
 *
 * A codec translates FRAMES and nothing else. It does not touch samples: the
 * payload stays base64 μ-law in both directions and the bridge owns the
 * resampling, which is what keeps a carrier's shim free of audio code.
 */
export const acmeCodec: CarrierCodec = {
  name: "acme",

  /**
   * Reduce one inbound frame. NEVER throws, and never for tidiness.
   *
   * A carrier adds frame kinds without asking, so anything unrecognised is
   * `ignore` rather than an error — a bridge that died on an unknown keepalive
   * would drop live calls on the carrier's release schedule. Same reason DTMF and
   * marks land there: this is "we do not act on it", not "it is invalid".
   */
  decode(frame: unknown): CarrierInbound {
    const parsed = frameOf(frame);
    switch (str(parsed.type)) {
      case "connected": {
        const streamId = str(parsed.stream);
        // No stream id is not a start: `streamId` has to be echoed on every
        // outbound frame, so accepting the call without one would send audio the
        // carrier cannot route.
        return streamId === null
          ? { kind: "ignore" }
          : { kind: "start", streamId, encoding: str(parsed.codec), sampleRate: num(parsed.rate) };
      }
      case "audio": {
        const payload = str(parsed.audio);
        return payload === null ? { kind: "ignore" } : { kind: "media", payload };
      }
      case "hangup":
        return { kind: "stop" };
      default:
        return { kind: "ignore" };
    }
  },

  /** One chunk of agent speech, base64 μ-law, echoing the stream id. */
  media(payload: string, streamId: string | null): unknown {
    return { type: "audio", stream: streamId, audio: payload };
  },

  /**
   * Discard what the carrier has already buffered.
   *
   * This is what makes barge-in audible on a phone call. The carrier accepts
   * audio far faster than it plays it, so at the moment the caller interrupts
   * there are seconds of the agent's reply in the carrier's own buffer, beyond
   * the reach of anything the session drops on its side.
   */
  clear(streamId: string | null): unknown {
    return { type: "flush", stream: streamId };
  },
};

/**
 * The route a carrier points its media stream at.
 *
 * From the package rather than spelled here, which is the point: the guest serves
 * this path and the platform's TwiML names it, so a literal on either side is a
 * call that connects to nothing.
 */
export const mediaStreamPath = TELEPHONY_PATH;

/** ── EDIT: resolve the carrier the way your own door does. ──────────────── */
export function codecForRequest(url: URL): CarrierCodec {
  // The name is CALLER-SUPPLIED, so an unknown one falls back to this
  // deployment's own carrier rather than being trusted. Letting the caller pick a
  // branch is how the platform's own webhook verification was once bypassable:
  // naming a carrier whose secret is absent missed every check.
  return carrierByName(url.searchParams.get(CARRIER_PARAM) ?? "") ?? acmeCodec;
}
