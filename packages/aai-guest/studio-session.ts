// Copyright 2026 the AAI authors. MIT license.
/**
 * What a studio session IS, and how one is installed into this harness.
 *
 * Split from `studio-chat.ts` (which now holds only the HTTP chat surface and
 * one turn's delivery) because both halves have their own readers: the
 * control-channel install path and its HTTP twin want the session, the
 * browser-facing turn wants the surface — and, concretely, because the agent
 * definition in `studio-agent.ts` needs this type while `studio-chat.ts`
 * imports that module.
 */

import path from "node:path";
import { toolchainModules, workspaceDependencyOptions, workspacesRoot } from "./studio-build.ts";
import { ensureProjectShape } from "./studio-project-shape.ts";
import { enterTurn } from "./studio-turn-stream.ts";
import { ensureWorkspaceDependencies, SESSION_INSTALL_BUDGET_MS } from "./studio-workspace-deps.ts";
import { materializeWorkspace } from "./studio-workspace-fs.ts";

export type StudioSessionParams = {
  /** Workspace scope (`user:<uid>` or a key digest) — half of this guest's identity. */
  scope: string;
  project: string;
  files: Record<string, string>;
  /** The caller's AssemblyAI key — the LLM credential (never the bearer). */
  apiKey: string;
  /** Broker-minted per-session bearer for the public chat surface. */
  chatToken: string;
  system: string;
  model: string;
  region?: "eu" | undefined;
  maxSteps: number;
};

export type StudioSession = StudioSessionParams & { dir: string };

/**
 * The concrete on-disk paths the coding agent can read, appended to the
 * host-composed system prompt.
 *
 * The host cannot write these: the harness sits at a different depth in the
 * two layouts (`/opt/aai/harness.mjs` in the Modal image,
 * `packages/aai-guest/dist/harness.mjs` under the subprocess backend), so
 * any relative path baked into the preamble is right in one and wrong in the
 * other. Only the guest can resolve it, and it does so by searching for the
 * toolchain rather than assuming an offset.
 *
 * They are absolute because that is the one form that survives a `bash` call
 * with an unexpected cwd, and `bash` is the only tool that can reach them at
 * all — `read_file` is jailed to the workspace, and `glob`/`grep` skip
 * node_modules by design.
 */
export function toolchainPromptSection(modulesDir: string | null = toolchainModules()): string {
  if (modulesDir === null) return "";
  const at = (rel: string): string => path.join(modulesDir, rel);
  return `

## Installed packages on this machine

Read these with \`bash\` — they live outside your workspace, so read_file,
glob, and grep cannot see them. They are ground truth, ahead of memory:

- Worked example agents: enumerate them with list_templates and copy the
  closest match into the workspace with use_template — the files arrive
  verbatim, so never retype template code by hand. Most ship a real
  client.tsx; dispatch-center, retail and solo-rpg are the richest, and
  travel-concierge, support-line, plan-and-execute and redline are ports of the
  LangGraph agents of the same shape. The sources sit at
  \`${at("@alexkroman1/aai-cli/dist/templates")}\` if you only want to
  read one in place with \`bash\`.
- SDK types (agent(), tool(), ctx): \`${at("@alexkroman1/aai/dist")}\`
- client.tsx imports: \`${at("@alexkroman1/aai-ui/dist/index.d.ts")}\`, and
  per-component props in \`${at("@alexkroman1/aai-ui/dist/components")}\``;
}

/**
 * The (scope, project) this harness was FIRST installed for. A studio sandbox
 * serves exactly one project for its whole life, so this is process identity.
 */
let installedFor: { scope: string; project: string } | null = null;

/**
 * A guest pins its own identity rather than trusting the caller's key.
 *
 * Every host caller is supposed to route (scope, project) correctly — the
 * broker keys its map and its registry row on it — but "supposed to" is the
 * part that fails. Now that ANY replica can install a session over HTTP (see
 * studio-session-init.ts), a mis-keyed registry row or a stale cross-replica
 * lookup would materialize one tenant's workspace into another tenant's
 * sandbox, where the coding agent would edit it and sync it back. Refusing
 * here makes that a 409 instead of a data-crossing bug, on the same
 * reasoning agent mode hash-verifies its bundle instead of trusting the
 * spawner to have written the right one.
 *
 * Re-installs for the SAME project are the normal path (every broker call
 * refreshes the tree), so only a CHANGE of identity is refused.
 */
export class SessionIdentityError extends Error {
  constructor(want: { scope: string; project: string }, got: { scope: string; project: string }) {
    super(
      `This sandbox serves ${want.scope}/${want.project}; refusing session-init for ` +
        `${got.scope}/${got.project}`,
    );
    this.name = "SessionIdentityError";
  }
}

/** Test seam: forget the pinned identity (one harness per test process). */
export function resetSessionIdentity(): void {
  installedFor = null;
}

/**
 * Initialize (or replace) the harness's studio session: materialize the
 * workspace to a scratch dir and remember the turn configuration. Called by
 * the `studio/session-init` control-channel request and by its HTTP twin —
 * repeat calls reset the workspace to the store's current files (the broker
 * re-inits on every page session so the sandbox never serves a stale tree).
 *
 * **Except while a turn is running, when the LIVE TREE WINS.** A refresh or a
 * second tab sends `studio/session-init` to the live sandbox, and the reset
 * `materializeWorkspace` opens with is an `rm -rf` of a path that is constant
 * per process — the very directory the in-flight turn's tools closed over. That
 * deleted every edit since the last checkpoint, gave the next tool an ENOENT
 * one call after it had reported success, handed `buildWorkspaceDir` a
 * half-populated tree so the agent started "fixing" phantom build errors, and
 * ended with `settleTurn` syncing the mixed result back marked `done: true` —
 * i.e. publishing it. So the reset is claimed through the same gate a turn is
 * ({@link enterTurn}), and a session-init that cannot claim it re-points the
 * session at the live tree and touches nothing on disk.
 *
 * That is also the correct answer rather than merely the safe one: mid-turn the
 * guest's tree is AHEAD of the store, so resetting to the store's files is
 * restoring a stale snapshot over newer work. The install itself is still
 * replaced (a new `chatToken`, system prompt and model), which is all the tab
 * that asked for it actually needs — and its first turn is refused 423 until
 * the running one finishes, which the browser already handles.
 *
 * Holding the gate for the whole preparation, rather than reading a "busy"
 * flag, is what also closes the mirror race: a turn cannot start while the tree
 * is half-materialized.
 */
export async function initStudioSession(params: StudioSessionParams): Promise<StudioSession> {
  const identity = { scope: params.scope, project: params.project };
  if (
    installedFor &&
    (installedFor.scope !== identity.scope || installedFor.project !== identity.project)
  ) {
    throw new SessionIdentityError(installedFor, identity);
  }
  // Under the workspaces root, NOT os.tmpdir(): builds run in-guest through
  // the aai CLI bundlers, and only this root has the toolchain's
  // node_modules above it for the workspace's bare imports to resolve.
  const dir = path.join(workspacesRoot(), "session");
  const session = { ...params, system: params.system + toolchainPromptSection(), dir };

  const release = enterTurn();
  if (!release) {
    // A turn owns the tree. See the header: keep it, take the new config.
    console.error("studio session-init: a turn is in flight — keeping the live workspace");
    return session;
  }
  try {
    await materializeWorkspace(dir, params.files);
    // Complete the workspace into a real project (package.json, tsconfig,
    // …) — same shape `aai init` scaffolds; the files sync back to the
    // store at end of turn like everything else in the workspace.
    await ensureProjectShape(dir);
    // `materializeWorkspace` opened with `rm -rf`, so a re-install (a refresh, a
    // replica taking over) has just deleted the node_modules `add_dependency`
    // built — and a workspace pushed from a laptop never had one. Reinstate
    // whatever package.json declares before the first build reads an import.
    // Non-fatal: a session is still usable when one dependency will not install,
    // and the build that needs it says so where the coding agent can act on it.
    const depWarning = await ensureWorkspaceDependencies(dir, {
      ...workspaceDependencyOptions(),
      // The host abandons session-init well before npm's own cap, and this runs
      // on every page open — a slow registry must degrade the install, not the
      // session. See SESSION_INSTALL_BUDGET_MS.
      budgetMs: SESSION_INSTALL_BUDGET_MS,
    });
    if (depWarning !== null) console.error(`studio workspace dependencies: ${depWarning}`);
  } finally {
    release();
  }
  // Pinned only once the install actually succeeded: a rejected first install
  // must not brand the sandbox with an identity it never served.
  installedFor = identity;
  return session;
}
