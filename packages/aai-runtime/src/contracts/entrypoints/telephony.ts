// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `telephony`.
 *
 * Bridging a carrier's media stream into a session: the two carriers with
 * a shipped codec, the codec shape a third is written to, and the bridge.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  CARRIER_CODECS,
  type CarrierCodec,
  type CarrierInbound,
  type CarrierName,
  carrierByName,
  createTelephonyBridge,
  startTelephonySession,
  TELEPHONY_SAMPLE_RATE,
  type TelephonyBridgeOptions,
  telnyxCodec,
  twilioCodec,
} from "../../runtime-barrel.ts";
