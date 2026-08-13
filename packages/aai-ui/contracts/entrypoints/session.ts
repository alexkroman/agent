// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `session`.
 *
 * The live call as a client sees it: the framework-agnostic core, the snapshot
 * a component renders from, the context hooks that read it, and the errors and
 * capture constraints that come with holding a microphone open.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type AgentCustomEvent,
  type AgentState,
  type ChatMessage,
  createSessionCore,
  type Session,
  type SessionCore,
  type SessionCoreOptions,
  type SessionError,
  type SessionErrorCode,
  type SessionSnapshot,
  useSession,
  useSessionSelector,
  VOICE_CAPTURE_CONSTRAINTS,
  type VoiceSessionOptions,
  type WebSocketConstructor,
} from "../../index.ts";
