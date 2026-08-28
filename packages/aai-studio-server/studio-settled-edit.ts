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
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { Context } from "hono";
import { requestPublicOrigin, type StudioHonoEnv } from "./studio-context.ts";
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
): void {
  broker.refreshSession(scope, project, c.var.apiKey).catch((err: unknown) => {
    console.warn("Studio: live session refresh failed", { project, error: errorMessage(err) });
  });
  schedulePreviewFor(broker, c, scope, project);
}

/**
 * Where a preview deploy scheduled for THIS request goes, and on whose
 * behalf — everything a queued job needs except the credential.
 *
 * The one builder for every path that arms a preview: the settled edits
 * below, the database switch, the session broker (so the guest's own
 * end-of-turn sync inherits it), and the project-open wake. It exists because
 * the `userId` is the field a second copy loses, and losing it is silent: the
 * job still enqueues and still deploys HERE, and only a redelivery to another
 * replica — a restart, a scale-in, a sandbox death mid-deploy — turns it into
 * an archived job and a preview that never lands. Two of the three call sites
 * had lost it exactly that way.
 *
 * `userId` is present for browser sessions only. A raw-key caller (the CLI,
 * evals) has none, and its job is deliberately replica-local: the drain
 * resolves a user's key from Vault, and a raw key must never become a row.
 */
export function previewOrigin(c: Context<StudioHonoEnv>): {
  serverUrl: string;
  userId?: string;
} {
  return {
    serverUrl: requestPublicOrigin(c),
    ...omitUndefined({ userId: c.var.userId }),
  };
}

/**
 * Enqueue a preview deploy on the caller's behalf. Shared with the database
 * switch, which redeploys the preview so the running agent picks up its new
 * `DATABASE_URL`.
 */
export function schedulePreviewFor(
  broker: StudioSessionBroker,
  c: Context<StudioHonoEnv>,
  scope: string,
  project: string,
): void {
  broker.schedulePreview(scope, project, { ...previewOrigin(c), apiKey: c.var.apiKey });
}
