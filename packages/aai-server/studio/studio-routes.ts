// Copyright 2025 the AAI authors. MIT license.
/**
 * HTTP surface of the browser studio, mounted at `/studio`:
 *
 * - `GET  /studio/status`                     — is the chat LLM configured?
 * - `GET  /studio/projects`                   — list the caller's projects
 * - `POST /studio/projects`                   — create a project (starter files)
 * - `GET  /studio/projects/:project`          — files + deployed slug
 * - `DELETE /studio/projects/:project`        — delete a project
 * - `PUT  /studio/projects/:project/file`     — write one file
 * - `DELETE /studio/projects/:project/file`   — delete one file (`?path=`)
 * - `POST /studio/projects/:project/deploy`   — build + deploy the workspace
 * - `POST /studio/projects/:project/sync`     — sync turn against the published agent
 * - `POST /studio/chat`                       — coding-agent turn (NDJSON stream)
 *
 * Auth: any bearer API key (the platform's self-sovereign key model — same
 * as `POST /deploy`). Workspaces are namespaced by a deterministic hash of
 * the key (`studioScope`), so a key only ever sees its own projects.
 */

import { errorMessage, MAX_SYNC_BODY_BYTES } from "@alexkroman1/aai";
import { zValidator } from "@hono/zod-validator";
import type { UIMessage } from "ai";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { HonoEnv } from "../context.ts";
import { authMw } from "../middleware.ts";
import type { SandboxPool } from "../sandbox-pool.ts";
import { handleSyncTurn } from "../sync-turn-handler.ts";
import { runStudioChat } from "./studio-agent.ts";
import { deployStudioProject } from "./studio-deploy.ts";
import { isStudioLlmConfigured, studioLlmInfo } from "./studio-llm.ts";
import { openMcpTools } from "./studio-mcp.ts";
import {
  CHAT_RATE_LIMIT,
  createRateLimiter,
  PROJECT_CREATE_RATE_LIMIT,
  type RateLimiter,
} from "./studio-rate-limit.ts";
import { createStudioSandbox, type StudioSandbox } from "./studio-sandbox.ts";
import {
  ChatBodySchema,
  CreateProjectSchema,
  MAX_STUDIO_CHAT_BYTES,
  ProjectNameSchema,
  StudioDeployBodySchema,
  StudioFileSchema,
} from "./studio-schemas.ts";
import { starterFiles } from "./studio-template.ts";
import {
  deleteWorkspace,
  getWorkspace,
  hasUnpublishedChanges,
  listProjects,
  putWorkspace,
  studioScope,
} from "./studio-workspace.ts";
import { withWorkspaceLock } from "./studio-workspace-lock.ts";

export type StudioRouteOptions = {
  /** Warm harness pool shared with deployed-agent sandboxes. */
  pool?: SandboxPool | undefined;
  /** Test seam: swap the deploy pipeline without module mocks. */
  deployProject?: typeof deployStudioProject;
  /** Test seam: swap the LLM gate. */
  llmConfigured?: () => boolean;
  /** Test seam: swap session-sandbox provisioning. */
  createSandbox?: typeof createStudioSandbox;
};

function validateProject(name: string | undefined): string {
  const parsed = ProjectNameSchema.safeParse(name);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid project name" });
  return parsed.data;
}

export function createStudioRoutes(options: StudioRouteOptions = {}): Hono<HonoEnv> {
  const deploy = options.deployProject ?? deployStudioProject;
  const llmConfigured = options.llmConfigured ?? isStudioLlmConfigured;
  const newSandbox = options.createSandbox ?? createStudioSandbox;

  const studio = new Hono<HonoEnv>();

  // Per-scope fixed-window limits (see studio-rate-limit.ts): any non-empty
  // bearer authenticates here, so without these the chat route is an
  // unmetered LLM proxy on platform-owned keys. Per router instance — one
  // orchestrator holds one set of windows.
  const chatLimiter = createRateLimiter(CHAT_RATE_LIMIT);
  const projectCreateLimiter = createRateLimiter(PROJECT_CREATE_RATE_LIMIT);
  const syncBodyLimit = bodyLimit({
    maxSize: MAX_SYNC_BODY_BYTES,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  });
  const rateLimited = (apiKey: string, limiter: RateLimiter): Response | null => {
    const verdict = limiter.check(studioScope(apiKey));
    if (verdict.ok) return null;
    return Response.json(
      { error: "Rate limit exceeded — try again later" },
      { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
    );
  };

  // `GET /studio` (no trailing path) — send the browser to the studio page.
  studio.get("/", (c) => c.redirect("/", 302));

  studio.get("/status", (c) =>
    c.json({ llm: llmConfigured(), ...(llmConfigured() && studioLlmInfo()) }),
  );

  // Bearer auth without slug ownership: workspace scoping needs only the
  // deterministic `studioScope`, and the deploy path derives the ownership
  // hash itself.
  studio.use("/projects", authMw);
  studio.use("/projects/*", authMw);
  studio.use("/chat", authMw);

  studio.get("/projects", async (c) => {
    const scope = studioScope(c.var.apiKey);
    return c.json({ projects: await listProjects(c.env.storage, scope) });
  });

  studio.post("/projects", zValidator("json", CreateProjectSchema), async (c) => {
    const limited = rateLimited(c.var.apiKey, projectCreateLimiter);
    if (limited) return limited;
    const scope = studioScope(c.var.apiKey);
    const { name } = c.req.valid("json");
    // Exists-check and create are one atomic step: two concurrent creates
    // must not both pass the check and have the loser reset the winner.
    return withWorkspaceLock(scope, name, async () => {
      if (await getWorkspace(c.env.storage, scope, name)) {
        return c.json({ error: "Project already exists" }, 409);
      }
      const workspace = await putWorkspace(c.env.storage, scope, name, { files: starterFiles() });
      return c.json({ name, files: workspace.files }, 201);
    });
  });

  studio.get("/projects/:project", async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    const workspace = await getWorkspace(c.env.storage, scope, project);
    if (!workspace) return c.json({ error: "Project not found" }, 404);
    return c.json({
      files: workspace.files,
      ...(workspace.deployedSlug && { deployedSlug: workspace.deployedSlug }),
      // Computed here so the client never has to hash files itself.
      unpublished: hasUnpublishedChanges(workspace),
    });
  });

  studio.delete("/projects/:project", async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    // Locked so an in-flight read-modify-write cannot resurrect the project
    // by writing back a snapshot taken before the delete.
    await withWorkspaceLock(scope, project, () => deleteWorkspace(c.env.storage, scope, project));
    return c.json({ ok: true });
  });

  studio.put("/projects/:project/file", zValidator("json", StudioFileSchema), async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    const { path, content } = c.req.valid("json");
    // Locked read-modify-write: an editor PUT racing a chat turn must not
    // drop either edit.
    return withWorkspaceLock(scope, project, async () => {
      const workspace = await getWorkspace(c.env.storage, scope, project);
      if (!workspace) return c.json({ error: "Project not found" }, 404);
      try {
        await putWorkspace(c.env.storage, scope, project, {
          ...workspace,
          files: { ...workspace.files, [path]: content },
        });
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
      const workspace = await getWorkspace(c.env.storage, scope, project);
      if (!workspace?.files[path]) return c.json({ error: "File not found" }, 404);
      const files = { ...workspace.files };
      delete files[path];
      await putWorkspace(c.env.storage, scope, project, { ...workspace, files });
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
        { store: c.env.store, slots: c.env.slots, storage: c.env.storage, pool: options.pool },
        { apiKey: c.var.apiKey, scope, project, env },
      );
      if (!result.ok) return c.json({ error: result.error }, 400);
      return c.json(result);
    },
  );

  // One connectionless sync turn against the project's *published* agent —
  // the studio-side door to `POST /:slug/sync`, addressed by project name so
  // the client never has to track the slug itself. Same semantics as the
  // preview: it exercises the deployed bundle, not unpublished edits.
  studio.post("/projects/:project/sync", syncBodyLimit, async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    const workspace = await getWorkspace(c.env.storage, scope, project);
    if (!workspace) return c.json({ error: "Project not found" }, 404);
    if (!workspace.deployedSlug) {
      return c.json({ error: "Project has not been published yet" }, 409);
    }
    return handleSyncTurn(c, workspace.deployedSlug, options.pool);
  });

  studio.post("/chat", async (c) => {
    const limited = rateLimited(c.var.apiKey, chatLimiter);
    if (limited) return limited;
    if (!llmConfigured()) {
      return c.json(
        {
          error:
            "Chat is not configured on this server — set ASSEMBLYAI_API_KEY " +
            "(LLM Gateway) or ANTHROPIC_API_KEY",
        },
        503,
      );
    }
    // The aggregate conversation cap is enforced on the raw body *before*
    // parsing: near-limit requests used to pay a whole-array JSON.stringify
    // inside a zod refine — re-serializing up to 4 MB that had just been
    // parsed. The raw text length is measured directly (Content-Length can
    // lie) and bounds everything the parse below can produce.
    const raw = await c.req.text();
    // Byte length, not `raw.length`: the cap is in bytes and non-ASCII
    // content is up to 3x its UTF-16 code-unit count in UTF-8.
    if (Buffer.byteLength(raw) > MAX_STUDIO_CHAT_BYTES) {
      return c.json({ error: "Conversation too large" }, 400);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ error: "Malformed JSON in request body" }, 400);
    }
    const body = ChatBodySchema.safeParse(json);
    if (!body.success) {
      return c.json({ error: "Invalid chat body", issues: body.error.issues }, 400);
    }
    const scope = studioScope(c.var.apiKey);
    const { project, messages } = body.data;

    // Start the MCP connect now so it overlaps the workspace fetch below and
    // runStudioChat's prompt assembly. Never rejects — failure degrades to no
    // MCP tools. Closed by runStudioChat when the stream settles, or right
    // here on the early-return path.
    const mcp = openMcpTools();
    if (!(await getWorkspace(c.env.storage, scope, project))) {
      void mcp.then((session) => session.close());
      return c.json({ error: "Project not found" }, 404);
    }

    // One sandbox per chat request, provisioned lazily on first
    // code-executing tool call (test_agent / deploy config extraction) via
    // the same warm-pool/spawn path deployed agents use. runStudioChat
    // disposes it when the stream settles.
    //
    // The `disposed` flag closes an abort race: a chat abort can run
    // disposeSandbox while sandboxPromise is still null (test_agent spends
    // seconds in the Vite build before asking for the sandbox), and a
    // provisioning that started afterwards would be a leaked Modal/Deno
    // process nothing ever disposes.
    let sandboxPromise: Promise<StudioSandbox> | null = null;
    let disposed = false;
    const sandbox = (): Promise<StudioSandbox> => {
      if (disposed) {
        return Promise.reject(new Error("The chat turn ended before the sandbox was provisioned."));
      }
      // A failed provisioning must not be cached: `??=` would pin the
      // rejection, turning one transient spawn failure into "Sandbox
      // unavailable" for every later test_agent call in the turn.
      sandboxPromise ??= newSandbox({ pool: options.pool }).catch((err) => {
        sandboxPromise = null;
        throw err;
      });
      return sandboxPromise;
    };
    const disposeSandbox = async (): Promise<void> => {
      disposed = true;
      if (!sandboxPromise) return;
      const live = await sandboxPromise.catch(() => null);
      await live?.dispose();
    };

    return runStudioChat(
      {
        storage: c.env.storage,
        scope,
        project,
        sandbox,
        disposeSandbox,
        mcp,
        abortSignal: c.req.raw.signal,
      },
      // Structurally validated by UiMessageSchema; part-level validation
      // happens in convertToModelMessages.
      messages as unknown as UIMessage[],
    );
  });

  return studio;
}
