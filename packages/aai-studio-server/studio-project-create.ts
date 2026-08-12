// Copyright 2026 the AAI authors. MIT license.
/**
 * Claiming a name for a new project.
 *
 * Its own module because the retry-on-collision loop is the whole of it and
 * `studio-routes.ts` is at the file-length cap — and because the handler reads
 * better as "claim a name, or 409" than as a loop with a `try` in it.
 */

import { generatedSlug } from "aai-server/slug-generate";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { WorkspaceConflictError } from "aai-server/workspace-store";
import { projectBaseFromPrompt } from "./studio-schemas.ts";
import { starterFiles } from "./studio-template.ts";
import { createWorkspace, type StudioWorkspace } from "./studio-workspace.ts";

/** Server-generated project name: prompt-derived base + random suffix. */
function nameFromPrompt(prompt: string | undefined): string {
  return generatedSlug(prompt ? projectBaseFromPrompt(prompt) : undefined);
}

/**
 * Create a project, generating its name when the caller supplied none.
 *
 * Resolves `null` when every candidate name was taken, which the caller answers
 * with a 409.
 *
 * No lock: creation is atomic at the store (a versioned insert), so two
 * concurrent creates — even on different replicas — cannot both succeed and the
 * loser can never reset the winner's files.
 */
export async function claimProjectName(
  store: WorkspaceStore,
  scope: string,
  req: {
    name?: string | undefined;
    prompt?: string | undefined;
    kind?: "agent" | "workflow" | undefined;
  },
): Promise<{ project: string; workspace: StudioWorkspace } | null> {
  // No explicit name: the server generates one, v0-style — a readable base from
  // the creating prompt plus a random suffix, via the same generator slugless CLI
  // deploys use (aai-server/slug-generate.ts). Two attempts, because the random
  // suffix makes a same-scope collision negligible and one retry absorbs it.
  const attempts = req.name ? [req.name] : [nameFromPrompt(req.prompt), nameFromPrompt(req.prompt)];

  for (const project of attempts) {
    try {
      const workspace = await createWorkspace(store, scope, project, {
        files: starterFiles(),
        // Only `"workflow"` is stored; absent IS `"agent"` (StudioWorkspace.kind).
        // A workflow project also asks for the DATABASE up front, because the
        // journal IS the durability: without storage an agent that declares
        // workflows still boots and answers calls, and `ctx.workflows` rejects
        // every call with `WORKFLOWS_UNAVAILABLE_MESSAGE` — so every workflow
        // project the studio created was inert until the user happened to find
        // Settings → Database, and the symptom (a tool that fails at the one thing
        // the project exists to do) names a fix two panes away. Storage is
        // incidental to a voice agent and load-bearing here, which is why the
        // default differs by kind rather than being on for everyone.
        //
        // Only the INTENT is stamped, which is all that can be: no slug exists
        // yet, and provisioning one nobody has claimed creates a schema outliving
        // every cleanup path. `reconcileProjectDatabase` provisions each
        // environment as its deploy claims the slug — see `studio-database.ts`.
        ...(req.kind === "workflow" ? { kind: req.kind, databaseEnabled: true } : {}),
      });
      return { project, workspace };
    } catch (err) {
      if (!(err instanceof WorkspaceConflictError)) throw err;
    }
  }
  return null;
}
