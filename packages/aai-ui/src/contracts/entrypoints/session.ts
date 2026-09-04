// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `session`.
 *
 * The live call as a client sees it: the framework-agnostic core, the snapshot
 * a component renders from, the context hooks that read it, the caller's
 * in-progress turn, and the errors that come with holding a microphone open.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  AGENT_STATE_LABELS,
  type AgentCustomEvent,
  type AgentState,
  type BrowserSession,
  type ChatMessage,
  type ConversationItem,
  createBrowserSession,
  type Session,
  type SessionActions,
  type SessionError,
  type SessionErrorCode,
  type SessionSnapshot,
  type UseConversationResult,
  type UseUserTranscriptResult,
  useConversation,
  useSession,
  useSessionActions,
  useSessionError,
  useSessionSelector,
  useSessionStatus,
  useUserTranscript,
  type VoiceSessionOptions,
  type WebSocketConstructor,
} from "../../index.ts";
