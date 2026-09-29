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

**A session starts on the carrier's `start` frame, not on the upgrade**
(`TELEPHONY_START_TIMEOUT_MS`): the frame carries the call id and `<Parameter>`s,
and `sessionContext` runs inside `session.start()`, so starting on the upgrade
asked the app about a call before the carrier had named it. The bridge buffers
the `audio_ready` until the runtime attaches. The two app-initiated closes —
`refuse` (1008, no `error.reported`) and `endSession(ctx)` (the paced sink's
`endAfterReply`, which waits out the playout clock) — are
`session-attach-end.ts`.
