// Copyright 2026 the AAI authors. MIT license.
/**
 * What the studio owes a workspace edit made OUTSIDE the coding agent's own
 * turn — an editor file PUT/DELETE, or an `aai push`.
 *
 * Split from studio-routes.ts so the three routes that perform such a write
 * cannot each remember a different half of it. The agent's own end-of-turn
 * `studio/sync-workspace` deliberately does NOT come through here: it is the
 * live sandbox, so there is nothing to re-install, and the broker schedules
 * its preview from the sync handler.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { Context } from "hono";
import type { StudioHonoEnv } from "./studio-context.ts";
import type { StudioSessionBroker } from "./studio-session-broker.ts";

/**
 * Two fire-and-forget consequences, both off the response path (the workspace
 * row is already durable):
 *
 * 1. Re-install the project's LIVE sandbox. A guest materializes its
 *    workspace once, at install, so a session brokered before this edit
 *    serves the pre-edit tree — and writes that tree back over this edit at
 *    the end of its next turn. `refreshSession` never spawns.
 * 2. Schedule an auto preview deploy, same as the agent's end-of-turn sync.
 */
export function onSettledEdit(
  broker: StudioSessionBroker,
  c: Context<StudioHonoEnv>,
  scope: string,
  project: string,
  /** Public platform origin the queued preview job's `aai deploy` dials back to.
   *  Passed in rather than resolved here: `requestPublicOrigin` lives in
   *  studio-routes.ts, which imports this module. */
  serverUrl: string,
): void {
  broker.refreshSession(scope, project, c.var.apiKey).catch((err: unknown) => {
    console.warn("Studio: live session refresh failed", { project, error: errorMessage(err) });
  });
  schedulePreviewFor(broker, c, scope, project, serverUrl);
}

/**
 * Enqueue a preview deploy on the caller's behalf. Shared with the database
 * switch, which redeploys the preview so the running agent picks up its new
 * `DATABASE_URL` — the `userId` nuance below is exactly the kind of detail a
 * second copy would lose.
 */
export function schedulePreviewFor(
  broker: StudioSessionBroker,
  c: Context<StudioHonoEnv>,
  scope: string,
  project: string,
  serverUrl: string,
): void {
  broker.schedulePreview(scope, project, {
    serverUrl,
    apiKey: c.var.apiKey,
    // Present for browser sessions only. It is what lets the queued job
    // outlive this replica: the row names the user, and the drain resolves
    // the key from Vault instead of the row carrying a credential.
    ...(c.var.userId && { userId: c.var.userId }),
  });
}
