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
 * - `POST /studio/projects/:project/deploy`   — build + deploy the workspace
 * - `GET/POST/DELETE /studio/projects/:project/storage` — per-app database
 *   storage on the published agent (409 until published)
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
import { disableStorage, enableStorage, storageStatus } from "aai-server/storage-handler";
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
import {
  CreateProjectSchema,
  ProjectNameSchema,
  StudioDeployBodySchema,
  StudioFileSchema,
} from "./studio-schemas.ts";
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

function validateProject(name: string | undefined): string {
  const parsed = ProjectNameSchema.safeParse(name);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid project name" });
  return parsed.data;
}

export function createStudioRoutes(options: StudioRouteOptions = {}): Hono<HonoEnv> {
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

  studio.post(
    "/projects/:project/deploy",
    zValidator("json", StudioDeployBodySchema),
    async (c) => {
      const scope = studioScope(c.var.apiKey);
      const project = validateProject(c.req.param("project"));
      const { env } = c.req.valid("json");
      const result = await deploy(
        {
          store: c.env.store,
          slots: c.env.slots,
          slugLock: c.env.slugLock,
          slugEpochs: c.env.slugEpochs,
          workspaces: c.env.workspaces,
          pool: options.pool,
        },
        { apiKey: c.var.apiKey, scope, project, env },
      );
      if (!result.ok) return c.json({ error: result.error }, 400);
      return c.json(result);
    },
  );

  // Resolve a project's *published* slug, throwing the HTTPException the
  // shared error handler renders as `{ error: message }` with the same
  // status. Unpublished project → 409: the routes below operate on the
  // deployed agent, so Publish comes first.
  const publishedSlug = async (c: Context<HonoEnv>): Promise<string> => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    const workspace = await getWorkspace(c.env.workspaces, scope, project);
    if (!workspace) throw new HTTPException(404, { message: "Project not found" });
    if (!workspace.deployedSlug) {
      throw new HTTPException(409, { message: "Project has not been published yet" });
    }
    return workspace.deployedSlug;
  };

  // Storage (per-app database) for the project's *published* agent —
  // resolved by project name, delegating to the same core the owner
  // `/:slug/storage` routes use.

  studio.get("/projects/:project/storage", async (c) => {
    const slug = await publishedSlug(c);
    return c.json(await storageStatus(c.env, slug));
  });

  studio.post("/projects/:project/storage", async (c) => {
    const slug = await publishedSlug(c);
    const { enabled } = await enableStorage(c.env, slug);
    return c.json({ ok: true, enabled });
  });

  studio.delete("/projects/:project/storage", async (c) => {
    const slug = await publishedSlug(c);
    const { enabled } = await disableStorage(c.env, slug);
    return c.json({ ok: true, enabled });
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

  return studio;
}
