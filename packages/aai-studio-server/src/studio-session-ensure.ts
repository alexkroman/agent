// Copyright 2026 the AAI authors. MIT license.
/**
 * The reuse → adopt → spawn ladder: how a project ends up with exactly one
 * installed coding-agent session, and what that session IS.
 *
 * The other half of the split studio-session-idle.ts started. That module
 * owns "when does a sandbox go away"; this one owns "where does a sandbox
 * come from, and what gets installed into it", leaving
 * studio-session-broker.ts as the composition — collaborators, the per-project
 * lock, and the public surface.
 *
 * Everything here runs UNDER the broker's per-project lock. Nothing in it
 * takes a lock of its own, and nothing in it may be called without one: the
 * whole ladder is a read-modify-write over the session map, and the orphaned
 * sandbox an unserialized loser leaves behind is the failure the lock exists
 * for (see `sessionLock` in the broker).
 */

import { randomBytes } from "node:crypto";
import { errorMessage } from "@alexkroman1/aai";
import type { createOwnedMap } from "@alexkroman1/aai/internal";
import { resolveHarnessPath } from "aai-server/constants";
import { createLogger } from "aai-server/logger";
import { SandboxNameTakenError, studioSandboxName } from "aai-server/sandbox-directory";
import type { spawnWarmHarness, WarmHarness } from "aai-server/sandbox-vm";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { MAX_CHAT_STEPS } from "./studio-limits.ts";
import { studioLlmModelId } from "./studio-llm.ts";
import type { PreviewOrigin } from "./studio-preview.ts";
import { resolveProjectKind } from "./studio-project-kind.ts";
import { studioSystemPrompt } from "./studio-prompt.ts";
import type { SessionEntry } from "./studio-session-entry.ts";
import type { SessionFleet } from "./studio-session-fleet.ts";
import { chatUrlForGuest } from "./studio-session-wire.ts";
import { getWorkspace, type StudioWorkspace } from "./studio-workspace.ts";

const log = createLogger("studio.session");

/** Deadline for installing a session in the guest (workspace transfer). */
const SESSION_INIT_TIMEOUT_MS = 60_000;

type SessionMap = ReturnType<typeof createOwnedMap<string, SessionEntry>>;

/** A brokered session, as the client receives it. */
export type BrokeredSession = { url: string; token: string };

export type SessionInstallerDeps = {
  workspaces: WorkspaceStore;
  /** Read for the studio LLM model/region baked into every install. */
  env: NodeJS.ProcessEnv;
  spawn: typeof spawnWarmHarness;
  harnessPath?: string | undefined;
  sessions: SessionMap;
  fleet: SessionFleet;
  /** The reaper's identity-checked teardown (studio-session-idle.ts). */
  disposeEntry(entry: SessionEntry): Promise<void>;
  /**
   * Wire a freshly spawned guest's guest→host RPCs. The broker owns this
   * because the handlers resolve THIS replica's state at RPC time — see
   * `wire` there.
   */
  wire(warm: WarmHarness, key: string, scope: string, project: string): void;
};

export type SessionInstaller = {
  /**
   * Reuse-or-adopt-or-spawn for one project. Resolves the project's chat URL
   * and its sandbox's chat token, or null when the project doesn't exist (or
   * `allowSpawn` is false and nothing is live to reuse).
   *
   * MUST run under the broker's per-project lock.
   */
  ensureSessionLocked(
    key: string,
    scope: string,
    project: string,
    apiKey: string,
    opts?: { preview?: PreviewOrigin | undefined; allowSpawn?: boolean },
  ): Promise<BrokeredSession | null>;
};

export function createSessionInstaller(deps: SessionInstallerDeps): SessionInstaller {
  const { workspaces, env, spawn, sessions, fleet, disposeEntry, wire } = deps;

  /**
   * The install payload minus the chat token, spelled once: the owner sends
   * it over the control channel, a peer POSTs it to the guest. Two copies
   * would be two definitions of what a session IS — and the drift would show
   * up as a coding agent running on a different model or prompt depending on
   * which replica the browser happened to hit.
   */
  function sessionParams(
    scope: string,
    project: string,
    apiKey: string,
    /**
     * The project's workspace — its files AND its kind. Passed whole rather
     * than as a file map: the kind is what selects the system prompt, and a
     * signature that took only the files could not carry it, which is how the
     * two would drift into a workflow project's agent running under the voice
     * prompt.
     */
    workspace: StudioWorkspace,
  ) {
    return {
      // The guest pins (scope, project) on its first install and refuses any
      // later one naming a different pair — so a mis-keyed registry row is a
      // 409, not one tenant's workspace in another tenant's sandbox.
      scope,
      project,
      files: workspace.files,
      apiKey,
      system: studioSystemPrompt(resolveProjectKind(workspace.kind)),
      model: studioLlmModelId(env),
      ...(env.STUDIO_LLM_REGION === "eu" ? { region: "eu" as const } : {}),
      maxSteps: MAX_CHAT_STEPS,
    };
  }

  /**
   * Install (or refresh) the session in the guest. Resolves the freshly
   * minted chat-surface bearer, or null when the project doesn't exist.
   *
   * The token — not the caller's AssemblyAI key — is what the browser
   * presents on the guest's public chat surface: browser sessions
   * authenticate to the platform with a Supabase session and never hold the
   * key, and a random per-session token on the public tunnel URL beats a
   * long-lived credential there anyway. The broker response carries it to
   * the client.
   *
   * Minted once per SANDBOX: a re-init passes the sandbox's existing token
   * back, so refreshing the workspace never invalidates a token another tab
   * is holding (see {@link SessionEntry.chatToken}).
   */
  async function initSession(
    warm: WarmHarness,
    scope: string,
    project: string,
    apiKey: string,
    opts: {
      /** Pre-read workspace; the cold path reads it BEFORE spawning a sandbox. */
      known?: StudioWorkspace;
      /** This sandbox's existing token; absent on a cold spawn. */
      existingToken?: string;
    } = {},
  ): Promise<string | null> {
    const { known, existingToken } = opts;
    const workspace = known ?? (await getWorkspace(workspaces, scope, project));
    if (!workspace) return null;
    const chatToken = existingToken ?? randomBytes(32).toString("base64url");
    await warm.conn.sendRequest(
      "studio/session-init",
      { ...sessionParams(scope, project, apiKey, workspace), chatToken },
      SESSION_INIT_TIMEOUT_MS,
    );
    return chatToken;
  }

  /**
   * Reuse the project's live sandbox, re-installing the session so a fresh
   * page never sees a stale tree. Resolves `null` when there is no live
   * sandbox to reuse (absent, or dead and now disposed) — the caller then
   * takes the cold path.
   *
   * **A reuse REFRESHES THE FLEET LEASE, exactly as the other two rungs do.**
   * The registry row's `expires_at` is what tells every replica this project
   * has a live sandbox (`studio-session-registry.ts`: "LIVENESS is the lease,
   * refreshed by any replica that brokers the project"), and only `lastUsed`
   * used to move here — so a user reloading every few minutes without
   * completing a turn kept the sandbox locally fresh while the row expired
   * under it. The next broker call landing on a PEER then read: `sessions`
   * miss → `fleet.adopt` → `registry.get` null → cold path → `spawnNamed` →
   * Modal refuses the duplicate name → null → **404 "Project not found" for a
   * project that plainly exists**. The cold path claims and `adopt` touches;
   * this rung is the one that has to say so itself.
   */
  async function reuseSession(
    key: string,
    scope: string,
    project: string,
    apiKey: string,
    preview?: PreviewOrigin,
  ): Promise<BrokeredSession | null> {
    const existing = sessions.get(key);
    if (!existing) return null;
    try {
      const token = await initSession(existing.warm, scope, project, apiKey, {
        existingToken: existing.chatToken,
      });
      if (token === null) return null;
      existing.lastUsed = Date.now();
      // Fire-and-forget, like every other touch: a lost one costs at most one
      // spawn, and blocking the broker response on the registry would not.
      fleet.touch(scope, project);
      if (preview) existing.previewTarget = { ...preview, apiKey };
      return { url: existing.url, token };
    } catch (err) {
      // Dead sandbox (idle-killed, crashed) — drop it so the caller respawns.
      log.warn("re-init failed; respawning sandbox", {
        project,
        error: errorMessage(err),
      });
      await disposeEntry(existing);
      return null;
    }
  }

  /**
   * Spawn this project's guest under its fleet-wide name, or null when a peer
   * won the name race — Modal refuses a duplicate name, so two replicas
   * racing the cold path cannot both spawn even if the registry read missed
   * (see `studioSandboxName`). Null means "adopt the winner": failing the
   * broker instead would make the mechanism that prevents a duplicate spawn
   * cost the user a failed call, healed only by the client's re-broker.
   *
   * Tagged with the project name so the Modal dashboard shows WHICH studio
   * session a sandbox serves, not a shared "studio-session" blob.
   */
  async function spawnNamed(scope: string, project: string): Promise<WarmHarness | null> {
    try {
      return await spawn({
        harnessPath: deps.harnessPath ?? resolveHarnessPath(),
        slug: project,
        role: "studio",
        name: studioSandboxName(scope, project),
      });
    } catch (err) {
      if (err instanceof SandboxNameTakenError) return null;
      throw err;
    }
  }

  /**
   * Install into a freshly spawned guest, disposing it on any failure — an
   * un-installed sandbox that nothing references is a billed orphan.
   *
   * The guard is a stack rather than a `try`/`catch` plus a trailing call,
   * because the invariant is "dispose on every exit EXCEPT the installed one"
   * and that shape cannot be written once with `try`: the success path returns
   * from inside the `try`, so the failure disposal has to be spelled a second
   * time in the `catch`. Both spellings were here, and a third exit added
   * anywhere in this body would have leaked a sandbox silently. Moving the
   * stack on the one path that KEEPS the harness is the whole difference.
   */
  async function installOrDispose(
    warm: WarmHarness,
    key: string,
    scope: string,
    project: string,
    apiKey: string,
    workspace: StudioWorkspace,
  ): Promise<string | null> {
    await using orphan = new AsyncDisposableStack();
    orphan.use(warm);
    wire(warm, key, scope, project);
    const token = await initSession(warm, scope, project, apiKey, { known: workspace });
    if (token === null) return null;
    // Installed: `wire` has handed the harness to the session map, which owns
    // its teardown from here. Moving the resources out of the guard is what
    // stops scope exit disposing a live session's sandbox.
    orphan.move();
    return token;
  }

  return {
    async ensureSessionLocked(key, scope, project, apiKey, opts = {}) {
      const { preview, allowSpawn = true } = opts;
      const reused = await reuseSession(key, scope, project, apiKey, preview);
      if (reused) return reused;

      // Check the project exists BEFORE taking a sandbox. Spawning first and
      // discovering the 404 inside initSession burned a full Modal spawn +
      // teardown per bogus project id.
      const workspace = await getWorkspace(workspaces, scope, project);
      if (!workspace) return null;

      // Cold HERE is not cold everywhere: another replica may already be
      // running this project's guest. Checked after the workspace read so a
      // bogus project never reaches the registry, and before the spawn because
      // the spawn is exactly the duplicate this prevents.
      const adopt = (): Promise<BrokeredSession | null> =>
        fleet.adopt(scope, project, sessionParams(scope, project, apiKey, workspace));
      const adopted = await adopt();
      if (adopted) return adopted;

      // A refresh stops here: reuse or adopt is the whole job, and booting a
      // coding-agent sandbox nobody asked for is not one.
      if (!allowSpawn) return null;
      const warm = await spawnNamed(scope, project);
      // A peer created this project's sandbox between the adopt above and the
      // create — adopt the winner (see spawnNamed).
      if (!warm) return await adopt();

      const token = await installOrDispose(warm, key, scope, project, apiKey, workspace);
      if (token === null) return null;
      const url = chatUrlForGuest(warm.guestOrigin);
      const entry: SessionEntry = {
        warm,
        url,
        scope,
        project,
        lastUsed: Date.now(),
        chatToken: token,
        inFlight: 0,
        ...(preview ? { previewTarget: { ...preview, apiKey } } : {}),
        release: () => false,
      };
      entry.release = sessions.claim(key, entry);
      // Announce it to the fleet. Best-effort inside, and deliberately AFTER
      // the local claim so a concurrent local dispose cannot release a row
      // that does not exist yet.
      await fleet.claim(scope, project, {
        chatUrl: url,
        chatToken: token,
        guestOrigin: warm.guestOrigin,
        sandboxToken: warm.token,
      });
      return { url, token };
    },
  };
}
