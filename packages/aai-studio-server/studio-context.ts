// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio service's route context: the shared platform bindings plus the
 * two stores only the studio reads.
 *
 * `workspaces` and `chats` used to be required members of aai-server's own
 * `HonoEnv` and `OrchestratorOpts`, so the agent service's public options type
 * was coupled to the studio's data model — a studio store change was a
 * compile-time change to aai-server, and the agent-only service constructed
 * Postgres stores it never queried. Declaring them here instead makes the
 * split CLAUDE.md describes real at the type level: aai-server owns the
 * platform core, and studio-specific state is the studio's to carry.
 */

import type { ChatStore } from "aai-server/chat-store";
import type { HonoEnv } from "aai-server/context";
import type { PlatformEvents } from "aai-server/platform-events";
import { resolvePublicOrigin } from "aai-server/public-origin";
import type { WorkspaceStore } from "aai-server/workspace-store";
import type { Context } from "hono";

export type StudioHonoEnv = HonoEnv & {
  Bindings: HonoEnv["Bindings"] & {
    /** Studio project workspaces (Postgres in production, memory in dev/tests). */
    workspaces: WorkspaceStore;
    /** Studio project chat histories (Postgres in production, memory in dev/tests). */
    chats: ChatStore;
    /**
     * Workspace change notifications (Supabase Realtime in production) —
     * feeds the project events SSE route that replaced client polling.
     */
    events: PlatformEvents;
  };
  Variables: HonoEnv["Variables"] & {
    /** Workspace scope, set by the `/projects/:project` middleware. */
    scope: string;
    /** Validated project name, set by the `/projects/:project` middleware. */
    project: string;
  };
};

/**
 * The one "no such project" answer.
 *
 * Ten routes across five modules spelled the literal out. It is a response
 * BODY — part of the contract the studio client and the CLI both read — so
 * maintaining it by copy is the same hazard as any other duplicated wire
 * shape; here rather than in a route module because no route module is a
 * parent of the other four.
 */
export function projectNotFound(c: Context<StudioHonoEnv>): Response {
  return c.json({ error: "Project not found" }, 404);
}

/**
 * The public platform origin the guest's `aai deploy` must dial — the
 * browser-facing origin, not this service's own. See `resolvePublicOrigin`
 * for the resolution order and for why the request URL's own scheme is
 * never trusted (it is always cleartext behind Modal, and publishing
 * `http://` cost every Publish its Authorization header on the redirect).
 *
 * Lives beside the context type rather than in studio-routes.ts so route
 * modules under it (the database switch, which redeploys a preview) can
 * resolve the origin without importing their own parent.
 */
export function requestPublicOrigin(
  c: Context<StudioHonoEnv>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolvePublicOrigin(c.req.raw, env);
}
