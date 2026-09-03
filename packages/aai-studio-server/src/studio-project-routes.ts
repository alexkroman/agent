// Copyright 2026 the AAI authors. MIT license.
/**
 * The project's own CRUD surface, mounted by studio-routes.ts:
 *
 * - `GET    /studio/projects`                 — list the caller's projects
 * - `POST   /studio/projects`                 — create one (starter files; the
 *   server generates the name from the creating `prompt` unless an explicit
 *   `name` is sent)
 * - `GET    /studio/projects/:project`        — files + deploy metadata
 * - `GET    /studio/projects/:project/chat`   — persisted chat history
 * - `DELETE /studio/projects/:project`        — delete THE PROJECT: workspace,
 *   chat, and its deployed + preview agents (ownership-gated cascade)
 * - `PUT    /studio/projects/:project/file`   — write one file
 * - `DELETE /studio/projects/:project/file`   — delete one file (`?path=`)
 * - `PUT    /studio/projects/:project/source` — replace the whole file map
 *   (`aai push`; upserts, fast-forward-checked against `baseHash`)
 *
 * Split out because studio-routes.ts sat at EXACTLY the 500-line cap
 * `check:file-length` enforces, so the next route — or the next paragraph of
 * rationale — would have failed the gate with no allowlist entry to fall back
 * on. This is the half that comes out cleanly: everything here is the project
 * DOCUMENT, and everything left there is the machinery around it (the broker,
 * the auth and scope middleware, the event streams, deploy, database, secrets,
 * sessions, the preview wake).
 *
 * The three routes that WRITE files all end in `settledEdit`, which is the
 * whole reason they belong together — see studio-settled-edit.ts for what an
 * out-of-turn workspace write owes the coding agent and the Preview pane.
 */

import { errorMessage } from "@alexkroman1/aai";
import { zValidator } from "@hono/zod-validator";
import { deleteAgentResources } from "aai-server/delete";
import { RESERVED_SLUGS } from "aai-server/schemas";
import { WorkspaceConflictError } from "aai-server/workspace-store";
import type { Context, Hono } from "hono";
import { projectNotFound, type StudioHonoEnv } from "./studio-context.ts";
import { ownedProjectSlugs } from "./studio-project-slugs.ts";
import type { RefuseFn } from "./studio-route-limits.ts";
import {
  CreateProjectSchema,
  generateProjectName,
  StudioFileSchema,
  SyncSourceSchema,
} from "./studio-schemas.ts";
import { deleteProjectSecrets } from "./studio-secrets.ts";
import { projectPayload } from "./studio-sse.ts";
import { starterFiles } from "./studio-template.ts";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listProjects,
  mutateWorkspace,
  normalizeFilePath,
  syncWorkspaceSource,
} from "./studio-workspace.ts";

export type ProjectRouteDeps = {
  /** The caller's workspace namespace — `requestScope` in studio-routes.ts. */
  requestScope: (c: Context<StudioHonoEnv>) => string;
  /** The project-create rate-limit gate (studio-route-limits.ts). */
  projectCreate: RefuseFn;
  /** What an out-of-turn workspace write owes — studio-settled-edit.ts. */
  settledEdit: (c: Context<StudioHonoEnv>, scope: string, project: string) => void;
};

/** Guards a push may trip, as responses: conflict (409) or bad input (400). */
function syncSourceError(err: unknown): Response {
  if (err instanceof WorkspaceConflictError) {
    return Response.json(
      {
        error: "Project changed since your last pull — run `aai pull` again (or push with --force)",
      },
      { status: 409 },
    );
  }
  return Response.json({ error: errorMessage(err) }, { status: 400 });
}

export function registerProjectRoutes(studio: Hono<StudioHonoEnv>, deps: ProjectRouteDeps): void {
  const { requestScope, settledEdit } = deps;

  studio.get("/projects", async (c) => {
    const scope = requestScope(c);
    return c.json({ projects: await listProjects(c.env.workspaces, scope) });
  });

  studio.post("/projects", zValidator("json", CreateProjectSchema), async (c) => {
    const scope = requestScope(c);
    const limited = await deps.projectCreate(scope, c.req.raw);
    if (limited) return limited;
    const { name, prompt, kind } = c.req.valid("json");
    // No explicit name: the server generates one, v0-style — a readable base
    // from the creating prompt plus a random suffix, via the same generator
    // slugless CLI deploys use (see aai-server/slug-generate.ts). The suffix
    // makes a same-scope collision negligible; one retry absorbs it anyway.
    const attempts = name ? [name] : [generateProjectName(prompt), generateProjectName(prompt)];
    // Creation is atomic at the store (versioned insert): two concurrent
    // creates — even on different replicas — cannot both succeed, so the
    // loser can never reset the winner's files. No lock needed here.
    for (const candidate of attempts) {
      try {
        // `kind` is stamped once, here: it selects the coding agent's system
        // prompt at every later session install (studio-session-ensure.ts), so
        // it has to outlive the request that chose it.
        const workspace = await createWorkspace(c.env.workspaces, scope, candidate, {
          files: starterFiles(),
          kind,
        });
        return c.json({ name: candidate, files: workspace.files, kind: workspace.kind }, 201);
      } catch (err) {
        if (!(err instanceof WorkspaceConflictError)) throw err;
      }
    }
    return c.json({ error: "Project already exists" }, 409);
  });

  studio.get("/projects/:project", async (c) => {
    const { scope, project } = c.var;
    const workspace = await getWorkspace(c.env.workspaces, scope, project);
    if (!workspace) return projectNotFound(c);
    return c.json(projectPayload(workspace));
  });

  // Persisted chat history for the project — written server-side when a chat
  // turn's stream settles, restored by the client on project open.
  studio.get("/projects/:project/chat", async (c) => {
    const { scope, project } = c.var;
    // Independent reads — the chat fetch doesn't depend on the existence check.
    const [workspace, messages] = await Promise.all([
      getWorkspace(c.env.workspaces, scope, project),
      c.env.chats.getChat(scope, project),
    ]);
    if (!workspace) return projectNotFound(c);
    return c.json({ messages: messages ?? [] });
  });

  // Deleting a project deletes THE PROJECT — workspace, chat, and its
  // deployed agents (production and preview), the same resources Publish
  // and the preview auto-deploy created. One delete concept on every
  // surface: the studio's Delete button and `aai delete` both land here.
  studio.delete("/projects/:project", async (c) => {
    const { scope, project } = c.var;
    const workspace = await getWorkspace(c.env.workspaces, scope, project);
    // Ownership is still the agents row's credential hash, never project scope
    // alone — a workspace naming a slug the caller doesn't own (however it got
    // there) must not become a deletion oracle. `ownedProjectSlugs`
    // (studio-project-slugs.ts) is the one answer to "which of this project's
    // agents are the caller's", shared with the database and secret switches,
    // and it checks the pair CONCURRENTLY where this route asked per slug.
    const owned = workspace ? await ownedProjectSlugs(c.env.store, c.var.apiKey, workspace) : [];
    // The pair is independent — deleted concurrently, like the ownership
    // check above and the three project-level deletes below.
    await Promise.all(
      [...new Set(owned.map((entry) => entry.slug))].map((slug) =>
        deleteAgentResources(c.env, slug),
      ),
    );
    // No lock needed: a racing versioned write cannot resurrect the project —
    // `mutateWorkspace` only ever replaces an existing row.
    await Promise.all([
      deleteWorkspace(c.env.workspaces, scope, project),
      c.env.chats.deleteChat(scope, project),
      // A project name can be taken again, so a surviving secret record
      // would hand the next project a dead one's provider keys.
      deleteProjectSecrets(c.env, scope, project),
    ]);
    return c.json({ ok: true });
  });

  studio.put("/projects/:project/file", zValidator("json", StudioFileSchema), async (c) => {
    const { scope, project } = c.var;
    const { path, content } = c.req.valid("json");
    // An editor PUT racing a chat turn drops neither edit: mutateWorkspace
    // serializes local writers and re-derives cleanly on a cross-replica
    // version conflict.
    try {
      const workspace = await mutateWorkspace(c.env.workspaces, scope, project, (current) => ({
        ...current,
        files: { ...current.files, [path]: content },
      }));
      if (!workspace) return projectNotFound(c);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
    settledEdit(c, scope, project);
    return c.json({ ok: true });
  });

  studio.delete("/projects/:project/file", async (c) => {
    const { scope, project } = c.var;
    const raw = c.req.query("path");
    if (!raw) return c.json({ error: "Missing path query parameter" }, 400);
    // Normalized like every WRITE path (`normalizeFilePath` is what
    // `stampWorkspace` stores by), so `./agent.ts` addresses the file
    // `agent.ts` rather than 404ing against a key nothing can hold. An
    // unusable path reads as "no such file" — this route has no other answer.
    let path: string;
    try {
      path = normalizeFilePath(raw);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }
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
    settledEdit(c, scope, project);
    return c.json({ ok: true });
  });

  // `aai push`: replace the project's entire file map in one atomic write.
  // Upserts — a first push creates the project under the pushed name (so it
  // shares the create rate limit); later pushes are fast-forward-checked
  // against `baseHash` (409 = the studio edited since the caller's pull).
  // Per-file paths, count, and byte caps are enforced by the workspace
  // write itself, exactly as for the guest's sync and the editor PUT.
  studio.put("/projects/:project/source", zValidator("json", SyncSourceSchema), async (c) => {
    const { scope, project } = c.var;
    const { files, baseHash } = c.req.valid("json");
    const existing = await getWorkspace(c.env.workspaces, scope, project);
    if (!existing) {
      // Creation via push: same guards as POST /projects — reserved names
      // can never go live, and creates are rate-limited per scope.
      if (RESERVED_SLUGS.has(project)) return c.json({ error: "That name is reserved" }, 400);
      const limited = await deps.projectCreate(scope, c.req.raw);
      if (limited) return limited;
    }
    try {
      const result = await syncWorkspaceSource(c.env.workspaces, scope, project, files, baseHash);
      if (result.changed) settledEdit(c, scope, project);
      return c.json(
        { ok: true, sourceHash: result.sourceHash, created: result.created },
        result.created ? 201 : 200,
      );
    } catch (err) {
      return syncSourceError(err);
    }
  });
}
