// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `push-to-talk`.
 *
 * Hold-to-speak for an agent that declares `turnDetection: "manual"`: the
 * `usePushToTalk` hook a button is built on, and the `session.userTurn`
 * sub-handle (`UserTurnControls`) underneath it.
 *
 * Its own capability rather than part of `session`: one agent in many declares
 * manual turns, and the three edges used to be REQUIRED methods on
 * `BrowserSession` and on `SessionActions` — so adding them was an epoch of the
 * whole session surface, and it broke every hand-written session double. They
 * are a sub-handle on a sealed session now, versioned here.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type UsePushToTalkOptions,
  type UsePushToTalkResult,
  type UserTurnControls,
  usePushToTalk,
} from "../../index.ts";
