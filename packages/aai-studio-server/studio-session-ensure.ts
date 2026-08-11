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
import { omitUndefined } from "@alexkroman1/aai/utils";
import { resolveHarnessPath } from "aai-server/constants";
import { knownPublicOrigin } from "aai-server/public-origin";
import { SandboxNameTakenError, studioSandboxName } from "aai-server/sandbox-directory";
import type { spawnWarmHarness, WarmHarness } from "aai-server/sandbox-vm";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { MAX_CHAT_STEPS } from "./studio-limits.ts";
import { studioLlmModelId } from "./studio-llm.ts";
import type { PreviewOrigin } from "./studio-preview.ts";
import { studioSystemPrompt } from "./studio-prompt.ts";
import type { SessionEntry } from "./studio-session-entry.ts";
import type { SessionFleet } from "./studio-session-fleet.ts";
import { chatUrlForGuest } from "./studio-session-wire.ts";
import { getWorkspace } from "./studio-workspace.ts";

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
    files: Record<string, string>,
  ) {
    return {
      // The guest pins (scope, project) on its first install and refuses any
      // later one naming a different pair — so a mis-keyed registry row is a
      // 409, not one tenant's workspace in another tenant's sandbox.
      scope,
      project,
      files,
      apiKey,
      // The origin the guest's analytics tool calls back on. Learned from
      // served traffic (see knownPublicOrigin) — every path that installs a
      // session is request-driven, so it is populated by the time this runs.
      ...omitUndefined({ serverUrl: knownPublicOrigin() }),
      system: studioSystemPrompt(),
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
    /** Pre-read workspace; the cold path reads it BEFORE spawning a sandbox. */
    known?: Awaited<ReturnType<typeof getWorkspace>>,
    /** This sandbox's existing token; absent on a cold spawn. */
    existingToken?: string,
  ): Promise<string | null> {
    const workspace = known ?? (await getWorkspace(workspaces, scope, project));
    if (!workspace) return null;
    const chatToken = existingToken ?? randomBytes(32).toString("base64url");
    await warm.conn.sendRequest(
      "studio/session-init",
      { ...sessionParams(scope, project, apiKey, workspace.files), chatToken },
      SESSION_INIT_TIMEOUT_MS,
    );
    return chatToken;
  }

  /**
   * Reuse the project's live sandbox, re-installing the session so a fresh
   * page never sees a stale tree. Resolves `null` when there is no live
   * sandbox to reuse (absent, or dead and now disposed) — the caller then
   * takes the cold path.
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
      const token = await initSession(
        existing.warm,
        scope,
        project,
        apiKey,
        undefined,
        existing.chatToken,
      );
      if (token === null) return null;
      existing.lastUsed = Date.now();
      if (preview) existing.previewTarget = { ...preview, apiKey };
      return { url: existing.url, token };
    } catch (err) {
      // Dead sandbox (idle-killed, crashed) — drop it so the caller respawns.
      console.warn("Studio session: re-init failed; respawning sandbox", {
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

  /** Install into a freshly spawned guest, disposing it on any failure — an
   *  un-installed sandbox that nothing references is a billed orphan. */
  async function installOrDispose(
    warm: WarmHarness,
    key: string,
    scope: string,
    project: string,
    apiKey: string,
    workspace: Awaited<ReturnType<typeof getWorkspace>>,
  ): Promise<string | null> {
    try {
      wire(warm, key, scope, project);
      const token = await initSession(warm, scope, project, apiKey, workspace);
      if (token !== null) return token;
    } catch (err) {
      await warm[Symbol.asyncDispose]();
      throw err;
    }
    await warm[Symbol.asyncDispose]();
    return null;
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
        fleet.adopt(scope, project, sessionParams(scope, project, apiKey, workspace.files));
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
