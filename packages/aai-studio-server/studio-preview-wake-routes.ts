// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /studio/projects/:project/preview/wake` — the Preview pane reporting
 * that the platform does not serve the slug it frames.
 *
 * Split out of studio-routes.ts as its own module because it is one mechanism
 * with its own state (the throttle cache) and its own long-standing
 * rationale, and because its spec already lives apart
 * (studio-preview-wake-routes.test.ts).
 */

import { TtlCache } from "aai-server/platform-barrel";
import type { Context, Hono } from "hono";
import type { StudioHonoEnv } from "./studio-context.ts";
import { PREVIEW_WAKE_THROTTLE_MS } from "./studio-preview.ts";
import { projectKey } from "./studio-workspace.ts";

/**
 * `wake` is passed in rather than rebuilt here: it closes over the session
 * broker, which studio-routes.ts owns, and the OTHER trigger (the
 * once-per-open session call) has to reach the identical function — the two
 * triggers landing in one place is the whole design (see the doc below).
 */
export function registerPreviewWakeRoutes(
  studio: Hono<StudioHonoEnv>,
  wake: (c: Context<StudioHonoEnv>, scope: string, project: string) => void,
): void {
  /**
   * The Preview pane reporting that the platform does not serve the slug it
   * frames (`api.wakePreview`).
   *
   * The recovery it reaches is not new — `wakeProjectPreview` has always
   * cleared the stamp and enqueued a deploy when the broker 404s. What was
   * missing is a way to REACH it from a tab that is already open: the only
   * trigger was the once-per-open session broker call, so a preview swept out
   * from under a tab left that tab probing a slug nothing would ever redeploy
   * (1,061 probes over 50 minutes, in production, ended by the user happening
   * to do something else). The pane can see the 404 the server would have to
   * go looking for, so it says so.
   *
   * The caller is a TRIGGER, not evidence: the wake re-checks with its own
   * broker call and schedules nothing unless that 404s too. So this route
   * cannot be talked into a deploy, which is what lets it be cheap to call
   * and unrate-limited beyond the throttle below.
   *
   * 202 either way — the wake is fire-and-forget by construction, so "did it
   * redeploy" is not a question this response could answer, and a project
   * that does not exist is a no-op rather than a 404 (the pane only probes a
   * slug the workspace stamped, so a miss here means a delete raced it).
   */
  const wokenRecently = new TtlCache<true>(PREVIEW_WAKE_THROTTLE_MS, 1000);
  studio.post("/projects/:project/preview/wake", (c) => {
    const { scope, project } = c.var;
    const key = projectKey(scope, project);
    // Per process, so a fleet-wide burst is bounded by the replica count
    // rather than by one number — enough, because the pane sends this ONCE
    // per missing preview. The throttle is here for the client that stops
    // being that pane, not for the one that is.
    if (!wokenRecently.get(key)) {
      wokenRecently.set(key, true);
      wake(c, scope, project);
    }
    return c.json({ ok: true }, 202);
  });
}
