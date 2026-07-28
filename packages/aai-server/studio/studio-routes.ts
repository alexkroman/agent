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
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { HonoEnv } from "../context.ts";
import { isStudioLlmConfigured, runStudioChat } from "./studio-agent.ts";
import { deployStudioProject, type StudioDeployResult } from "./studio-deploy.ts";
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

/** Test seams: swap the deploy pipeline / LLM gate without module mocks. */
export type StudioRouteOverrides = {
  deployProject?: typeof deployStudioProject;
  llmConfigured?: () => boolean;
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

export function createStudioRoutes(overrides: StudioRouteOverrides = {}): Hono<HonoEnv> {
  const deploy = overrides.deployProject ?? deployStudioProject;
  const llmConfigured = overrides.llmConfigured ?? isStudioLlmConfigured;

  const studio = new Hono<HonoEnv>();

  // `GET /studio` (no trailing path) — send the browser to the studio page.
  studio.get("/", (c) => c.redirect("/", 302));

  studio.get("/status", (c) => c.json({ llm: llmConfigured() }));

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
        { error: "Chat is not configured on this server (ANTHROPIC_API_KEY unset)" },
        503,
      );
    }
    const scope = studioScope(c.var.apiKey);
    const { project, messages } = c.req.valid("json");
    if (!(await getWorkspace(c.env.storage, scope, project))) {
      return c.json({ error: "Project not found" }, 404);
    }
    const deployFromChat = (env?: Record<string, string>): Promise<StudioDeployResult> =>
      deploy(
        { store: c.env.store, slots: c.env.slots, storage: c.env.storage },
        { apiKey: c.var.apiKey, scope, project, env },
      );
    const stream = runStudioChat(
      { storage: c.env.storage, scope, project, deploy: deployFromChat },
      messages,
    );
    return c.body(stream, 200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });

  return studio;
}
