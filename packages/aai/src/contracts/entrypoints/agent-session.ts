// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `agent-session`.
 *
 * What a SESSION hands an agent's callbacks: the lifecycle field group
 * (`AgentSessionLifecycle` — `sessionContext`, `onSessionEnd` — and its three
 * context types), the twin contexts a resolver or guardrail
 * (`AgentSessionContext`) and an event handler (`SessionEventContext`) read,
 * the `speech` both carry (`SessionSpeech`, `SayOptions`, `SpeechHandle`,
 * `SpeechOutcome`), and the session readings a tool makes (`sessionCall`,
 * `sessionClientLocation`, `endSession`).
 *
 * Split off `agent` when it reached 77 names: these are the shapes an author
 * RECEIVES, which grow as the runtime learns more about a session, where `agent`
 * is what an author WRITES. The two context twins stay together here on
 * purpose — one may not move without the other (each module warns the other
 * against exactly that drift).
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type AgentSessionContext,
  type AgentSessionLifecycle,
  // The call BRIEF: what `stepPlaceCall({ brief })` signs onto a call and
  // `ctx.call.brief(secret)` / `readCallBrief` reads back off `SessionCall`. Here
  // rather than on `step` because the reader is the session the call becomes;
  // `SessionCallInput` is the record a writer hands in (`createToolContext`, the
  // phone bridge) before the SDK attaches the reader.
  CALL_BRIEF_CHUNK_CHARS,
  CALL_BRIEF_SECRET_ENV,
  type CallBrief,
  type EndSessionOptions,
  endSession,
  MAX_CALL_BRIEF_PROMPT_CHARS,
  readCallBrief,
  type SayOptions,
  type SessionCall,
  type SessionCallInput,
  type SessionContext,
  type SessionContextArgs,
  type SessionEndContext,
  type SessionEventContext,
  type SessionSpeech,
  type SpeechHandle,
  type SpeechOutcome,
  sessionCall,
  sessionClientLocation,
  signCallBrief,
} from "../../index.ts";
