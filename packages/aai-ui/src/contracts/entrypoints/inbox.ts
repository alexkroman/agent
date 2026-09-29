// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `inbox`.
 *
 * The browser half of `WS /inbox`: `createInbox`, the framework-agnostic socket
 * a workflow run's `stepNotifyClient` reaches after the session has closed, and
 * `useInbox`, which fills it in from the session and plays each notice.
 *
 * Its own capability rather than part of `session`, for the reason
 * `push-to-talk` is: it is one kind of client's feature (a speaker, a page that
 * takes reminders), and a change to it should not be an epoch of every session.
 * Qualified `aai-ui:inbox`; `aai:inbox` is the SDK's server-side half.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type CreateInboxOptions,
  createInbox,
  type Inbox,
  type InboxEvent,
  type InboxNotice,
  type UseInboxOptions,
  type UseInboxResult,
  useInbox,
} from "../../index.ts";
