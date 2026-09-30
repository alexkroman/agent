// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `tap-to-talk`.
 *
 * Tap to go live, tap to hang up, for an agent with automatic turn detection:
 * the `useTapToTalk` hook a talk button (and a composer) is built on.
 *
 * Its own capability for the reason `push-to-talk` is: one kind of client's
 * feature (a device's twin page), so a change to it is not an epoch of every
 * session. The session half it relies on — `sendText(text, { connect: true })`
 * — is `session`'s.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export { type UseTapToTalkOptions, type UseTapToTalkResult, useTapToTalk } from "../../index.ts";
