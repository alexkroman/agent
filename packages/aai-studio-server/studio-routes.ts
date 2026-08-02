// Copyright 2025 the AAI authors. MIT license.
/**
 * HTTP surface of the browser studio, mounted at `/studio`:
 *
 * - `GET  /studio/status`                     — is the chat LLM configured?
 * - `GET  /studio/projects`                   — list the caller's projects
 * - `POST /studio/projects`                   — create a project (starter files)
 * - `GET  /studio/projects/:project`          — files + deployed slug
 * - `GET  /studio/projects/:project/chat`     — persisted chat history
 * - `DELETE /studio/projects/:project`        — delete a project (and its chat)
 * - `PUT  /studio/projects/:project/file`     — write one file
 * - `DELETE /studio/projects/:project/file`   — delete one file (`?path=`)
 * - `POST /studio/projects/:project/deploy`   — the project's sandbox runs
 *   `aai deploy`; the CLI output rides back for the chat
 *
 * Storage (per-app database) is deliberately NOT exposed here: enabling it
 * is a CLI action (`aai storage enable`), and deployed-agent secrets are
 * managed by the client against the platform's own `/:slug/secret` routes.
 * - `POST /studio/projects/:project/session`  — boot the project's coding-agent
 *   sandbox; the browser then streams chat turns DIRECTLY to the sandbox's
 *   public `/studio/chat` (see studio-session-broker.ts)
 *
 * Auth: any bearer API key (the platform's self-sovereign key model — same
 * as `POST /deploy`). Workspaces are namespaced by a deterministic hash of
 * the key (`studioScope`), so a key only ever sees its own projects.
 */

import { errorMessage } from "@alexkroman1/aai";
import { zValidator } from "@hono/zod-validator";
import type { HonoEnv } from "aai-server/context";
import { authMw } from "aai-server/middleware";
import type { SandboxPool } from "aai-server/sandbox-pool";
import { WorkspaceConflictError } from "aai-server/workspace-store";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { deployStudioProject } from "./studio-deploy.ts";
import { studioLlmInfo } from "./studio-llm.ts";
import {
  CHAT_RATE_LIMIT,
  createRateLimiter,
  PROJECT_CREATE_RATE_LIMIT,
  type RateLimiter,
  type StudioRateLimiters,
} from "./studio-rate-limit.ts";
import { CreateProjectSchema, ProjectNameSchema, StudioFileSchema } from "./studio-schemas.ts";
import { createStudioSessionBroker, type StudioSessionBroker } from "./studio-session-broker.ts";
import { starterFiles } from "./studio-template.ts";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  hasUnpublishedChanges,
  listProjects,
  mutateWorkspace,
  studioScope,
} from "./studio-workspace.ts";
import { withWorkspaceLock } from "./studio-workspace-lock.ts";

export type StudioRouteOptions = {
  /** Warm harness pool shared with deployed-agent sandboxes. */
  pool?: SandboxPool | undefined;
  /**
   * Rate limiters for chat and project creation. Postgres-backed in
   * production so the limits hold across replicas; defaults to per-process
   * in-memory windows (dev/tests).
   */
  rateLimiters?: StudioRateLimiters | undefined;
  /** Test seam: swap the deploy pipeline without module mocks. */
  deployProject?: typeof deployStudioProject;
  /** Test seam: swap the coding-agent session broker. */
  broker?: (stores: {
    workspaces: HonoEnv["Bindings"]["workspaces"];
    chats: HonoEnv["Bindings"]["chats"];
  }) => StudioSessionBroker;
};

/**
 * The public platform origin the guest's `aai deploy` must dial — the
 * browser-facing origin, not this service's own. `AAI_PUBLIC_ORIGIN` wins
 * (explicit config); otherwise the forwarding headers the agent service's
 * studio proxy sets (split deployment); otherwise the request URL's origin
 * (combined/dev, where they are the same thing).
 */
export function requestPublicOrigin(
  c: Context<HonoEnv>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.AAI_PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const url = new URL(c.req.url);
  const host = c.req.header("x-forwarded-host") ?? url.host;
  const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

function validateProject(name: string | undefined): string {
  const parsed = ProjectNameSchema.safeParse(name);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid project name" });
  return parsed.data;
}

export function createStudioRoutes(options: StudioRouteOptions = {}): {
  routes: Hono<HonoEnv>;
  /**
   * Tear down the broker's per-project sandboxes. A no-op when no session
   * request ever built the lazy broker.
   */
  dispose: () => Promise<void>;
} {
  const deploy = options.deployProject ?? deployStudioProject;
  // One broker per app instance, created lazily on the first session request
  // (the stores ride on the request env). Per-replica, like the slot cache.
  let broker: StudioSessionBroker | undefined;
  const ensureBroker = (c: Context<HonoEnv>): StudioSessionBroker => {
    broker ??= (options.broker ?? createStudioSessionBroker)({
      workspaces: c.env.workspaces,
      chats: c.env.chats,
      ...(options.pool && { pool: options.pool }),
    });
    return broker;
  };

  const studio = new Hono<HonoEnv>();

  // Per-scope fixed-window limits (see studio-rate-limit.ts). The LLM runs
  // on the caller's own key, so the limiter is no longer guarding a
  // platform-billed proxy — it still bounds sandbox spawns and build-worker
  // work per caller. Injected in production (Postgres-backed, shared across
  // replicas); the in-memory default covers dev and tests.
  const chatLimiter = options.rateLimiters?.chat ?? createRateLimiter(CHAT_RATE_LIMIT);
  const projectCreateLimiter =
    options.rateLimiters?.projectCreate ?? createRateLimiter(PROJECT_CREATE_RATE_LIMIT);
  const rateLimited = async (apiKey: string, limiter: RateLimiter): Promise<Response | null> => {
    const verdict = await limiter.check(studioScope(apiKey));
    if (verdict.ok) return null;
    return Response.json(
      { error: "Rate limit exceeded — try again later" },
      { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
    );
  };

  // `GET /studio` (no trailing path) — send the browser to the studio page.
  studio.get("/", (c) => c.redirect("/", 302));

  // `llm: true` is legacy shape — chat always runs now, on the caller's key.
  studio.get("/status", (c) => c.json({ llm: true, ...studioLlmInfo() }));

  // Bearer auth without slug ownership: workspace scoping needs only the
  // deterministic `studioScope`, and the deploy path derives the ownership
  // hash itself.
  studio.use("/projects", authMw);
  studio.use("/projects/*", authMw);
  studio.use("/chat", authMw);

  studio.get("/projects", async (c) => {
    const scope = studioScope(c.var.apiKey);
    return c.json({ projects: await listProjects(c.env.workspaces, scope) });
  });

  studio.post("/projects", zValidator("json", CreateProjectSchema), async (c) => {
    const limited = await rateLimited(c.var.apiKey, projectCreateLimiter);
    if (limited) return limited;
    const scope = studioScope(c.var.apiKey);
    const { name } = c.req.valid("json");
    // Creation is atomic at the store (versioned insert): two concurrent
    // creates — even on different replicas — cannot both succeed, so the
    // loser can never reset the winner's files. No lock needed here.
    try {
      const workspace = await createWorkspace(c.env.workspaces, scope, name, {
        files: starterFiles(),
      });
      return c.json({ name, files: workspace.files }, 201);
    } catch (err) {
      if (err instanceof WorkspaceConflictError) {
        return c.json({ error: "Project already exists" }, 409);
      }
      throw err;
    }
  });

  studio.get("/projects/:project", async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    const workspace = await getWorkspace(c.env.workspaces, scope, project);
    if (!workspace) return c.json({ error: "Project not found" }, 404);
    return c.json({
      files: workspace.files,
      ...(workspace.deployedSlug && { deployedSlug: workspace.deployedSlug }),
      // Computed here so the client never has to hash files itself.
      unpublished: hasUnpublishedChanges(workspace),
    });
  });

  // Persisted chat history for the project — written server-side when a chat
  // turn's stream settles, restored by the client on project open.
  studio.get("/projects/:project/chat", async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    if (!(await getWorkspace(c.env.workspaces, scope, project))) {
      return c.json({ error: "Project not found" }, 404);
    }
    const messages = await c.env.chats.getChat(scope, project);
    return c.json({ messages: messages ?? [] });
  });

  studio.delete("/projects/:project", async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    // No lock needed: a racing versioned write cannot resurrect the project —
    // `mutateWorkspace` only ever replaces an existing row.
    await deleteWorkspace(c.env.workspaces, scope, project);
    await c.env.chats.deleteChat(scope, project);
    return c.json({ ok: true });
  });

  studio.put("/projects/:project/file", zValidator("json", StudioFileSchema), async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    const { path, content } = c.req.valid("json");
    // Locked read-modify-write: an editor PUT racing a chat turn must not
    // drop either edit. Cross-replica races are absorbed by the versioned
    // retry inside mutateWorkspace — the edit re-derives cleanly.
    return withWorkspaceLock(scope, project, async () => {
      try {
        const workspace = await mutateWorkspace(c.env.workspaces, scope, project, (current) => ({
          ...current,
          files: { ...current.files, [path]: content },
        }));
        if (!workspace) return c.json({ error: "Project not found" }, 404);
      } catch (err) {
        return c.json({ error: errorMessage(err) }, 400);
      }
      return c.json({ ok: true });
    });
  });

  studio.delete("/projects/:project/file", async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path query parameter" }, 400);
    return withWorkspaceLock(scope, project, async () => {
      let deleted = false;
      const workspace = await mutateWorkspace(c.env.workspaces, scope, project, (current) => {
        // Reset per attempt: a conflict retry re-derives from a fresh read.
        deleted = false;
        if (!current.files[path]) return null;
        deleted = true;
        const files = { ...current.files };
        delete files[path];
        return { ...current, files };
      });
      if (!(workspace && deleted)) return c.json({ error: "File not found" }, 404);
      return c.json({ ok: true });
    });
  });

  studio.post("/projects/:project/deploy", async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    const result = await deploy(
      {
        workspaces: c.env.workspaces,
        // Publish runs `aai deploy` in a guest sandbox via the session
        // broker — reusing the project's live coding-agent sandbox when one
        // exists. The guest's CLI dials back to this platform's public
        // origin; everything server-side (build inspection, ownership,
        // epochs, the env floor) happens on the standard POST /deploy path.
        deployWorkspace: (deployScope, deployProject, files, target) =>
          ensureBroker(c).deployWorkspace(deployScope, deployProject, files, target),
      },
      { apiKey: c.var.apiKey, scope, project, serverUrl: requestPublicOrigin(c) },
    );
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result);
  });

  // Boot (or refresh) the project's coding-agent sandbox and return its
  // public chat URL — the browser talks to the sandbox directly from here
  // on (SSE), mirroring how voice clients connect straight to a deployed
  // agent's /websocket. Rate-limited: each call can spawn a Modal sandbox.
  studio.post("/projects/:project/session", async (c) => {
    const limited = await rateLimited(c.var.apiKey, chatLimiter);
    if (limited) return limited;
    const project = validateProject(c.req.param("project"));
    const scope = studioScope(c.var.apiKey);
    const session = await ensureBroker(c).ensureSession(scope, project, c.var.apiKey);
    if (!session) return c.json({ error: "Project not found" }, 404);
    return c.json({ url: session.url });
  });

  return {
    routes: studio,
    dispose: async () => {
      await broker?.dispose();
    },
  };
}
