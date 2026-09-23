// Copyright 2026 the AAI authors. MIT license.
/**
 * What an agent DECLARES about phone calls — the carrier vocabulary, one layer
 * under both the declaration (`AgentDef.telephony`) and the codecs that serve
 * it (`aai-runtime/src/telephony/carriers.ts`).
 *
 * The two have to name the same carriers and only one of them can be the
 * source: `CARRIER_CODECS` is declared `satisfies Record<TelephonyCarrier,
 * CarrierCodec>`, so a name added here without a codec beside it fails that
 * package's build rather than shipping a carrier an author can enable and
 * nothing can answer.
 *
 * **The declaration is an ALLOW-LIST whose default is empty**, which is the
 * whole point of this module existing. `WS /phone` starts the same session, on
 * the same agent, on the same credentials, that `/websocket` starts — but it is
 * reached by a URL a CARRIER dials rather than by the page this deployment
 * serves, so who may reach it is a decision an agent makes rather than one
 * every voice agent inherits. It used to be inherited: `aai dev`, a self-hosted
 * `server.mjs` and every deployed sandbox mounted Twilio and Telnyx framing
 * from the moment they booted, whether or not the agent had a phone number at
 * all, and the only way to see it was to read the boot line.
 */

/**
 * A phone carrier that can open a media stream against an agent — `"twilio"`
 * or `"telnyx"`, the two this release ships a codec for, or any other string.
 *
 * OPEN, like `VoicePresetName`: the known carriers are written inline as the
 * autocomplete half, so a declaration naming a carrier a later release adds
 * still compiles and deploys against this one. The runtime serves only the
 * carriers it ships a codec for and DROPS the rest (`enabledCarriers`), so an
 * unknown name mounts nothing — which is why `aai build` / `aai dev` warn about
 * it (`agentConfigWarnings`) rather than the type refusing it. Inline rather
 * than an exported closed `Known…` half, so a carrier added here is a
 * compatible change to this type; code that must be TOTAL over the shipped
 * carriers keys off `TELEPHONY_CARRIERS` (`@alexkroman1/aai/internal`) instead.
 *
 * @public
 */
export type TelephonyCarrier = "twilio" | "telnyx" | (string & {});

/**
 * The same names as a VALUE, for the two readers that need the list at run time:
 * {@link AgentConfigSchema}, which validates them because the declaration
 * crosses the serialization boundary like `page` does, and the runtime's
 * `enabledCarriers`, which resolves a declaration into the routes it serves.
 *
 * Written out rather than derived the other way round — `TelephonyCarrier` used
 * to be `(typeof TELEPHONY_CARRIERS)[number]` — because this array is INTERNAL
 * (`@alexkroman1/aai/internal`) and the type is public, and TypeDoc treats a
 * published type referencing an unpublished value as a warning, which the docs
 * build treats as an error. It is the CLOSED set — the carriers this build
 * ships a codec for — and `define.test-d.ts` pins it equal to the known half
 * written inline in the open {@link TelephonyCarrier}.
 */
export const TELEPHONY_CARRIERS = ["twilio", "telnyx"] as const;

/**
 * What an agent declares about `WS /phone`.
 *
 * - `true` — every carrier this build ships a codec for (Twilio, Telnyx).
 * - a list — exactly those (`["twilio"]` serves Twilio and refuses Telnyx).
 * - `false`, `[]`, or an absent field — the route is not served at all.
 *
 * `false` and an empty list are the same refusal rather than two spellings of a
 * mode: this is an allow-list, and an allow-list that admits nothing is not a
 * surprise. What it is NOT is a claim about credentials — the carrier's own
 * webhook signature is checked where the webhook lands, on the platform, and a
 * carrier does not sign the WebSocket upgrade this gates.
 */
export type TelephonyAccess = boolean | readonly TelephonyCarrier[];
