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
 * - `POST /studio/chat`                       — coding-agent turn (NDJSON stream)
 *
 * Auth: any bearer API key (the platform's self-sovereign key model — same
 * as `POST /deploy`). Workspaces are namespaced by a deterministic hash of
 * the key (`studioScope`), so a key only ever sees its own projects.
 */

import { zValidator } from "@hono/zod-validator";
import type { UIMessage } from "ai";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { HonoEnv } from "../context.ts";
import type { SandboxPool } from "../sandbox-pool.ts";
import { runStudioChat } from "./studio-agent.ts";
import { deployStudioProject } from "./studio-deploy.ts";
import { isStudioLlmConfigured, studioLlmInfo } from "./studio-llm.ts";
import { createStudioSandbox, type StudioSandbox } from "./studio-sandbox.ts";
import {
  ChatBodySchema,
  CreateProjectSchema,
  ProjectNameSchema,
  StudioDeployBodySchema,
  StudioFileSchema,
} from "./studio-schemas.ts";
import { starterFiles } from "./studio-template.ts";
import {
  deleteWorkspace,
  getWorkspace,
  listProjects,
  putWorkspace,
  studioScope,
} from "./studio-workspace.ts";

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

/**
 * Bearer auth for studio routes. Unlike `authMw` this skips the ~100ms
 * PBKDF2 key hash — workspace scoping needs only the deterministic
 * `studioScope`, and the deploy path derives the ownership hash itself.
 */
const studioAuthMw = createMiddleware<HonoEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const apiKey = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!apiKey) {
    throw new HTTPException(401, { message: "Missing Authorization header (Bearer <API_KEY>)" });
  }
  c.set("apiKey", apiKey);
  await next();
});

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

  // `GET /studio` (no trailing path) — send the browser to the studio page.
  studio.get("/", (c) => c.redirect("/", 302));

  studio.get("/status", (c) =>
    c.json({ llm: llmConfigured(), ...(llmConfigured() && studioLlmInfo()) }),
  );

  studio.use("/projects", studioAuthMw);
  studio.use("/projects/*", studioAuthMw);
  studio.use("/chat", studioAuthMw);

  studio.get("/projects", async (c) => {
    const scope = studioScope(c.var.apiKey);
    return c.json({ projects: await listProjects(c.env.storage, scope) });
  });

  studio.post("/projects", zValidator("json", CreateProjectSchema), async (c) => {
    const scope = studioScope(c.var.apiKey);
    const { name } = c.req.valid("json");
    if (await getWorkspace(c.env.storage, scope, name)) {
      return c.json({ error: "Project already exists" }, 409);
    }
    const workspace = await putWorkspace(c.env.storage, scope, name, { files: starterFiles() });
    return c.json({ name, files: workspace.files }, 201);
  });

  studio.get("/projects/:project", async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    const workspace = await getWorkspace(c.env.storage, scope, project);
    if (!workspace) return c.json({ error: "Project not found" }, 404);
    return c.json({
      files: workspace.files,
      ...(workspace.deployedSlug && { deployedSlug: workspace.deployedSlug }),
    });
  });

  studio.delete("/projects/:project", async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    await deleteWorkspace(c.env.storage, scope, project);
    return c.json({ ok: true });
  });

  studio.put("/projects/:project/file", zValidator("json", StudioFileSchema), async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    const workspace = await getWorkspace(c.env.storage, scope, project);
    if (!workspace) return c.json({ error: "Project not found" }, 404);
    const { path, content } = c.req.valid("json");
    try {
      await putWorkspace(c.env.storage, scope, project, {
        ...workspace,
        files: { ...workspace.files, [path]: content },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.json({ ok: true });
  });

  studio.delete("/projects/:project/file", async (c) => {
    const scope = studioScope(c.var.apiKey);
    const project = validateProject(c.req.param("project"));
    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path query parameter" }, 400);
    const workspace = await getWorkspace(c.env.storage, scope, project);
    if (!workspace?.files[path]) return c.json({ error: "File not found" }, 404);
    const files = { ...workspace.files };
    delete files[path];
    await putWorkspace(c.env.storage, scope, project, { ...workspace, files });
    return c.json({ ok: true });
  });

  studio.post(
    "/projects/:project/deploy",
    zValidator("json", StudioDeployBodySchema),
    async (c) => {
      const scope = studioScope(c.var.apiKey);
      const project = validateProject(c.req.param("project"));
      const { env } = c.req.valid("json");
      const result = await deploy(
        { store: c.env.store, slots: c.env.slots, storage: c.env.storage },
        { apiKey: c.var.apiKey, scope, project, env },
      );
      if (!result.ok) return c.json({ error: result.error }, 400);
      return c.json(result);
    },
  );

  studio.post("/chat", zValidator("json", ChatBodySchema), async (c) => {
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
    const scope = studioScope(c.var.apiKey);
    const { project, messages } = c.req.valid("json");
    if (!(await getWorkspace(c.env.storage, scope, project))) {
      return c.json({ error: "Project not found" }, 404);
    }

    // One sandbox per chat request, provisioned lazily on first
    // code-executing tool call (test_agent / deploy config extraction) via
    // the same warm-pool/spawn path deployed agents use. runStudioChat
    // disposes it when the stream settles.
    let sandboxPromise: Promise<StudioSandbox> | null = null;
    const sandbox = (): Promise<StudioSandbox> => {
      sandboxPromise ??= newSandbox({ pool: options.pool });
      return sandboxPromise;
    };
    const disposeSandbox = async (): Promise<void> => {
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
      },
      // Structurally validated by UiMessageSchema; part-level validation
      // happens in convertToModelMessages.
      messages as unknown as UIMessage[],
    );
  });

  return studio;
}
