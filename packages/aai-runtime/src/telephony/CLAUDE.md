---
summary: >-
  Where the phone-call design lives, and the one telephony remainder in this
  package
read_when: >-
  editing the carrier codecs, the telephony bridge or `WS /phone`
---

# Telephony: a phone call is an ordinary session

`WS /phone` runs a carrier's media stream (Twilio Media Streams, Telnyx) as an
ordinary session, served by `createRuntimeServer` for exactly the carriers
`AgentDef.telephony` names and for none if it names nothing.
`enabledCarriers` in `telephony-server.ts` is the one resolution of that
declaration, and the boot line prints what it returns.

**The design is in `packages/aai-guest/src/harness/CLAUDE.md`, "A phone call is
an ordinary session"**: the shim, the rule that no telephony branch may exist
below the bridge, pacing, LEARNED rates, low-pass before downsampling, what a
`CarrierCodec` owes, and the two deliberate gaps. The platform's TwiML webhook
route is `packages/aai-server/CLAUDE.md`, "Telephony".

**Telephony still enters as a fake socket**, the known remainder:
`startTelephonySession` goes through `SessionRuntime`, which the guest's LAZY
runtime facade implements with `startSession` only (a `connect` must return a
connection synchronously, before the runtime exists). Porting the bridge onto
`connectSession` means giving that facade a buffered `connect` first.
