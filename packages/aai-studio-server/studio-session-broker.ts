// Copyright 2026 the AAI authors. MIT license.
/**
 * Brokers the studio's per-project coding-agent sandboxes — the studio
 * mirror of `GET /:slug/client-config` for voice sessions.
 *
 * `POST /studio/projects/:project/session` lands here: the broker boots (or
 * reuses) a guest sandbox via `spawnWarmHarness` (a remote Modal Sandbox
 * booted from the published harness snapshot image; there is no warm pool
 * anymore) — installs the studio session in it
 * (`studio/session-init`: workspace files, the caller's own AssemblyAI key,
 * system prompt, turn config), and returns the sandbox's public chat URL.
 * The browser then talks to the sandbox DIRECTLY (`POST <tunnel>/studio/
 * chat`, SSE), exactly as voice clients connect straight to a deployed
 * agent's `/websocket`; chat turns never pass through this service.
 *
 * The control channel stays host↔guest and serves the guest's callbacks:
 * - `studio/sync-workspace` — end-of-turn write-back into the project
 *   store, so the editor and Publish see what the agent did.
 * - `studio/persist-chat` — end-of-turn conversation snapshot.
 *
 * Builds run IN the guest, through the aai CLI's own bundlers (see
 * aai-guest/studio-build.ts): `test_agent` builds locally during chat
 * turns, and Publish is the host→guest `workspace/deploy` request
 * (`buildWorkspace` below) — the one build path `aai deploy` also runs.
 *
 * Sandboxes are per (scope, project), reused across turns, and evicted
 * after an idle window — a per-replica accelerator exactly like the agent
 * service's slot cache: losing one costs a re-broker, never correctness
 * (the client re-brokers on a dead chat URL).
 */

import { randomBytes } from "node:crypto";
import { errorMessage } from "@alexkroman1/aai";
import { createOwnedMap } from "@alexkroman1/aai/internal";
import { resolveHarnessPath } from "aai-server/constants";
import { createKeyedLock, withLock } from "aai-server/platform-barrel";
import { SandboxNameTakenError, studioSandboxName } from "aai-server/sandbox-directory";
import { spawnWarmHarness, type WarmHarness } from "aai-server/sandbox-vm";
import { studioLlmModelId } from "./studio-llm.ts";
import { createPreviewDeployer, type PreviewTarget } from "./studio-preview.ts";
import { createMemoryPreviewQueue, type PreviewQueue } from "./studio-preview-queue.ts";
import { studioSystemPrompt } from "./studio-prompt.ts";
import type { adoptPeerSession } from "./studio-session-adopt.ts";
import type { SessionEntry } from "./studio-session-entry.ts";
import { createSessionFleet, soloFleet } from "./studio-session-fleet.ts";
import { createSessionReaper } from "./studio-session-idle.ts";
import {
  createWorkspacePublisher,
  type WorkspaceDeployOutcome,
  type WorkspaceDeployTarget,
} from "./studio-session-publish.ts";
import { STUDIO_SESSION_IDLE_MS, type StudioSessionRegistry } from "./studio-session-registry.ts";
import { chatUrlForGuest, wireGuest } from "./studio-session-wire.ts";
import { getWorkspace, projectKey } from "./studio-workspace.ts";

/**
 * Steps one chat turn may take.
 *
 * Was 16, which the starter evals showed was the dominant cause of failure:
 * turns died mid-repair (build → read error → edit → build) with a broken
 * workspace, not because the agent was lost but because it ran out of room.
 * opencode allows ~1000 and summarizes as it approaches the context limit;
 * this is the same trade at a more conservative ceiling, paired with
 * compaction in the guest (studio-compaction.ts) so the extra steps are
 * actually reachable.
 *
 * A runaway turn is still bounded — by this cap, by each tool's own deadline,
 * and by the client's Stop button.
 */
const MAX_CHAT_STEPS = 80;
/** Deadline for installing a session in the guest (workspace transfer). */
const SESSION_INIT_TIMEOUT_MS = 60_000;

// Deploy shapes live with the deploy path (studio-session-publish.ts) and
// are re-exported here because this module is the broker's public face.
export type { WorkspaceDeployOutcome, WorkspaceDeployTarget } from "./studio-session-publish.ts";
export { chatUrlForGuest } from "./studio-session-wire.ts";

type BrokerStores = {
  workspaces: import("aai-server/workspace-store").WorkspaceStore;
  chats: import("aai-server/chat-store").ChatStore;
};

export type StudioSessionBrokerOptions = BrokerStores & {
  harnessPath?: string;
  /** Injectable for tests — defaults to the shared warm-harness spawner. */
  spawn?: typeof spawnWarmHarness;
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
  /**
   * Cross-replica session registry (studio-session-registry.ts). Without it
   * every replica is independent and a project gets one sandbox PER REPLICA;
   * with it, the fleet holds one. Absent in dev/tests, where there is a
   * single process and so no peer to find.
   */
  registry?: StudioSessionRegistry;
  /**
   * This replica's identity — the registry's `owner`. Required alongside
   * `registry`: without a stable, distinct id a replica cannot tell its own
   * rows from a peer's, and `release` could evict a live peer's sandbox.
   */
  replicaId?: string;
  /** Test seam for the peer install (studio-session-adopt.ts). */
  adopt?: typeof adoptPeerSession;
  /**
   * Durable preview-deploy queue (studio-preview-queue.ts). Defaults to an
   * in-memory queue, which is correct for dev/tests (one process) and loses
   * pending previews on restart — exactly what the pgmq implementation exists
   * to prevent in production.
   */
  previewQueue?: PreviewQueue;
  /**
   * A studio user's stored AssemblyAI key, so a preview job REDELIVERED to a
   * replica that did not enqueue it can still deploy. Without it, only
   * same-replica jobs run (see `createPreviewDeployer`).
   */
  resolveApiKey?: (userId: string) => Promise<string | null>;
};

export type StudioSessionBroker = {
  /**
   * Boot or reuse the project's sandbox, (re-)install the session with the
   * workspace's current files, and return the guest's public chat URL.
   * Null when the project doesn't exist.
   *
   * `serverUrl` (the public platform origin) arms auto preview deploys: the
   * guest's end-of-turn `studio/sync-workspace` schedules a deploy of the
   * edited workspace to the project's preview slug (studio-preview.ts).
   * Omitted, agent edits sync without auto-previewing.
   */
  ensureSession(
    scope: string,
    project: string,
    apiKey: string,
    serverUrl?: string,
  ): Promise<{ url: string; token: string } | null>;
  /**
   * Re-install the workspace's CURRENT files into the project's live sandbox
   * (local, or a peer's); true when one was refreshed. NEVER spawns. What an
   * out-of-band write (`aai push`, an editor PUT) owes the coding agent: a
   * guest materializes its tree once, at install, so a session brokered
   * earlier serves pre-edit files AND syncs them back at end of turn.
   */
  refreshSession(scope: string, project: string, apiKey: string): Promise<boolean>;
  /**
   * Fire-and-forget: deploy the workspace's current files to the project's
   * PREVIEW slug (editor saves take this path; agent turns schedule via the
   * sync-workspace callback). Coalesced per project.
   */
  schedulePreview(scope: string, project: string, target: PreviewTarget): void;
  /**
   * Publish one workspace snapshot: the guest runs `aai deploy` against
   * the platform (`workspace/deploy`). Reuses the project's live sandbox
   * when one exists; otherwise a sandbox is spawned and torn down after.
   */
  deployWorkspace(
    scope: string,
    project: string,
    files: Record<string, string>,
    target: WorkspaceDeployTarget,
  ): Promise<WorkspaceDeployOutcome>;
  /** Tear down every live sandbox (tests, shutdown). */
  dispose(): Promise<void>;
};

export function createStudioSessionBroker(
  options: StudioSessionBrokerOptions,
): StudioSessionBroker {
  const spawn = options.spawn ?? spawnWarmHarness;
  const env = options.env ?? process.env;
  const idleMs = options.idleMs ?? STUDIO_SESSION_IDLE_MS;
  const sessions = createOwnedMap<string, SessionEntry>();
  // The registry is useless — and `release` becomes dangerous — without a
  // distinct owner id, so the two travel together or not at all. Absent, the
  // solo fleet makes every call below a no-op instead of a branch.
  const fleet =
    options.registry && options.replicaId
      ? createSessionFleet({
          registry: options.registry,
          replicaId: options.replicaId,
          ...(options.adopt && { adopt: options.adopt }),
        })
      : soloFleet;
  /**
   * Serializes a project's session installs. Two `POST …/session` calls for
   * one project overlap routinely — a double-click, a StrictMode double
   * effect, a refresh landing on an in-flight broker — and both would take
   * the cold path, spawn a sandbox, and race `sessions.set`. The loser is
   * then ORPHANED: absent from `sessions`, so neither the idle sweeper nor
   * `dispose()` can ever reach it. It burns its harness orphan timeout plus
   * Modal's idle window (billed) and, worse, its `wire()` handlers are still
   * live, so its end-of-turn `studio/sync-workspace` keeps writing the
   * project's files behind the tracked sandbox's back.
   */
  const sessionLock = createKeyedLock();

  // Teardown + idle eviction (studio-session-idle.ts).
  const { disposeEntry, stop: stopSweeper } = createSessionReaper({ sessions, fleet, idleMs });

  /**
   * Wire one sandbox's guest→host RPCs (studio-session-wire.ts). Everything
   * the handlers need about THIS replica's state — is this still the
   * project's sandbox, where do its previews go — is resolved at RPC time,
   * not captured at wire time: a sandbox can be replaced between the two.
   */
  function wire(warm: WarmHarness, key: string, scope: string, project: string): void {
    wireGuest(
      {
        workspaces: options.workspaces,
        chats: options.chats,
        touch: () => {
          const entry = sessions.get(key);
          if (!entry || entry.warm !== warm) return;
          entry.lastUsed = Date.now();
          fleet.touch(scope, project);
        },
        previewTarget: () => {
          const entry = sessions.get(key);
          return entry?.warm === warm ? (entry.previewTarget ?? null) : null;
        },
        schedulePreview: (s, p, target) => previews.schedule(s, p, target),
      },
      warm,
      key,
      scope,
      project,
    );
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
      system: studioSystemPrompt(),
      model: studioLlmModelId(env),
      ...(env.STUDIO_LLM_REGION === "eu" ? { region: "eu" as const } : {}),
      maxSteps: MAX_CHAT_STEPS,
    };
  }

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
    const workspace = known ?? (await getWorkspace(options.workspaces, scope, project));
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
    serverUrl?: string,
  ): Promise<{ url: string; token: string } | null> {
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
      if (serverUrl) existing.previewTarget = { serverUrl, apiKey };
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
        harnessPath: options.harnessPath ?? resolveHarnessPath(),
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
      await warm[Symbol.asyncDispose]().catch(() => undefined);
      throw err;
    }
    await warm[Symbol.asyncDispose]().catch(() => undefined);
    return null;
  }

  /** Reuse-or-adopt-or-spawn for one project. Runs under the session lock. */
  async function ensureSessionLocked(
    key: string,
    scope: string,
    project: string,
    apiKey: string,
    opts: { serverUrl?: string | undefined; allowSpawn?: boolean } = {},
  ): Promise<{ url: string; token: string } | null> {
    const { serverUrl, allowSpawn = true } = opts;
    const reused = await reuseSession(key, scope, project, apiKey, serverUrl);
    if (reused) return reused;

    // Check the project exists BEFORE taking a sandbox. Spawning first and
    // discovering the 404 inside initSession burned a full Modal spawn +
    // teardown per bogus project id.
    const workspace = await getWorkspace(options.workspaces, scope, project);
    if (!workspace) return null;

    // Cold HERE is not cold everywhere: another replica may already be
    // running this project's guest. Checked after the workspace read so a
    // bogus project never reaches the registry, and before the spawn because
    // the spawn is exactly the duplicate this prevents.
    const adopt = (): Promise<{ url: string; token: string } | null> =>
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
      ...(serverUrl ? { previewTarget: { serverUrl, apiKey } } : {}),
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
  }

  const deployWorkspaceImpl = createWorkspacePublisher({
    spawn,
    harnessPath: options.harnessPath,
    liveSession: (scope, project) => {
      const entry = sessions.get(projectKey(scope, project));
      if (!entry) return null;
      return {
        warm: entry.warm,
        touch: () => {
          entry.lastUsed = Date.now();
        },
        dispose: () => disposeEntry(entry),
      };
    },
  });

  // Auto preview deploys ride the same deploy path Publish uses — a live
  // session sandbox when one exists (the common case: the agent's own
  // sandbox, right after its turn), else an ephemeral spawn.
  const previews = createPreviewDeployer({
    workspaces: options.workspaces,
    deployWorkspace: deployWorkspaceImpl,
    queue: options.previewQueue ?? createMemoryPreviewQueue(),
    ...(options.resolveApiKey && { resolveApiKey: options.resolveApiKey }),
  });

  return {
    ensureSession(scope, project, apiKey, serverUrl) {
      const key = projectKey(scope, project);
      // Per project, not global: brokering one project must never queue
      // behind another project's Modal spawn.
      return withLock(sessionLock, key, () =>
        ensureSessionLocked(key, scope, project, apiKey, { serverUrl }),
      );
    },

    async refreshSession(scope, project, apiKey) {
      const key = projectKey(scope, project);
      // Under the SAME lock as ensureSession, so a refresh can never install
      // over an in-flight broker.
      const session = await withLock(sessionLock, key, () =>
        ensureSessionLocked(key, scope, project, apiKey, { allowSpawn: false }),
      );
      return session !== null;
    },

    schedulePreview(scope, project, target) {
      previews.schedule(scope, project, target);
    },

    deployWorkspace: deployWorkspaceImpl,

    async dispose() {
      stopSweeper();
      previews.dispose();
      await Promise.allSettled([...sessions.values()].map((entry) => disposeEntry(entry)));
    },
  };
}
