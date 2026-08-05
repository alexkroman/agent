// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio's two live event streams, split out of studio-routes.ts because
 * they share one non-obvious rule that the rest of the surface does not:
 *
 * **SUBSCRIBE BEFORE READING, and send the initial frame THROUGH the push
 * chain.**
 *
 * These streams are the only push mechanism the client has — its polling loop
 * was removed when they landed — so a change that neither the initial read nor
 * a subscription covers is lost for good, not merely late. Read-then-subscribe
 * leaves exactly that gap, and it is not microtask-sized in production: it
 * spans a real socket write on one side and, on the other, a Supabase Realtime
 * channel JOIN round trip, since `subscribe()` only SENDS the join and nothing
 * is delivered until the server acks it. (`createChannelPool` in
 * realtime-events.ts closes the join half by firing watchers on SUBSCRIBED —
 * that and this ordering are two halves of one fix.) Opening a project at the
 * moment its preview deploy stamps the workspace is the collision, and the
 * symptom is a Preview pane stuck on "Updating preview…" with a finished
 * preview sitting behind it.
 *
 * Routing the initial frame through `sse.push` is what makes the reorder safe.
 * Every frame — initial and pushed alike — is then produced by a fresh read on
 * one serialized chain, so a watcher that fires before the initial read cannot
 * deliver newer state ahead of older. It also means events stay pure SIGNALS:
 * no frame carries anything but a just-read row.
 */

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { StudioHonoEnv } from "./studio-context.ts";
import { createSsePusher, projectPayload } from "./studio-sse.ts";
import { getWorkspace, listProjects } from "./studio-workspace.ts";

/** An SSE frame, or null to end the stream (the watched row vanished). */
type Frame = { event: string; data: string } | null;

export function registerEventRoutes(
  studio: Hono<StudioHonoEnv>,
  /** The caller's workspace namespace — `requestScope` in studio-routes.ts. */
  requestScope: (c: Context<StudioHonoEnv>) => string,
): void {
  // Live project LIST for the caller's scope — fed by scope-level workspace
  // change events, so a project created or deleted on another device shows up
  // in the home sidebar without a refresh. Own top-level path (never
  // `/projects/events`) because "events" is a valid project name.
  studio.get("/events", (c) => {
    const scope = requestScope(c);
    return streamSSE(c, async (stream) => {
      const sse = createSsePusher(stream);
      const frame = async (): Promise<Frame> => ({
        event: "projects",
        data: JSON.stringify(await listProjects(c.env.workspaces, scope)),
      });
      const unwatch = c.env.events.watchScopeProjects(scope, () => sse.push(frame));
      sse.push(frame);
      await sse.wait(unwatch);
    });
  });

  // Live project state, fed by the workspace and chat rows' change streams
  // (Supabase Realtime in production — see platform-events.ts). `chat` frames
  // carry the settled conversation (the guest's end-of-turn persist), so other
  // tabs/devices see finished turns without re-opening the project.
  studio.get("/projects/:project/events", async (c) => {
    const { scope, project } = c.var;
    // Existence only — the frames below re-read. A 404 has to be answerable
    // before the response becomes a stream.
    if (!(await getWorkspace(c.env.workspaces, scope, project))) {
      return c.json({ error: "Project not found" }, 404);
    }
    return streamSSE(c, async (stream) => {
      const sse = createSsePusher(stream);
      const projectFrame = async (): Promise<Frame> => {
        const current = await getWorkspace(c.env.workspaces, scope, project);
        // A vanished workspace (project deleted) ends the stream; the client's
        // other queries surface the 404.
        if (!current) return null;
        return { event: "project", data: JSON.stringify(projectPayload(current)) };
      };
      const chatFrame = async (): Promise<Frame> => ({
        event: "chat",
        data: JSON.stringify((await c.env.chats.getChat(scope, project)) ?? []),
      });
      const unwatchWorkspace = c.env.events.watchWorkspace(scope, project, () =>
        sse.push(projectFrame),
      );
      const unwatchChat = c.env.events.watchChat(scope, project, () => sse.push(chatFrame));
      sse.push(projectFrame);
      await sse.wait(() => {
        unwatchWorkspace();
        unwatchChat();
      });
    });
  });
}
