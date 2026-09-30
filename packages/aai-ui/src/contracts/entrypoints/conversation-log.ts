// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `conversation-log`.
 *
 * A transcript that outlives the session: `useConversationLog`, its persisted
 * `ConversationLogEntry` shape (a stored format — changing it strands what
 * browsers already hold), and `inboxEventToItem`, the row for a mirrored inbox
 * frame. `ConversationView`/`MessageList` take the entries as `log`; those
 * props are `components`'.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type ConversationLogEntry,
  inboxEventToItem,
  type UseConversationLogOptions,
  type UseConversationLogResult,
  useConversationLog,
} from "../../index.ts";
