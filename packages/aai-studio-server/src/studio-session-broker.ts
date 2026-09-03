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

import { createOwnedMap } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { ChatStore } from "aai-server/chat-store";
import { createKeyedLock, withLock } from "aai-server/platform-barrel";
import { spawnWarmHarness, type WarmHarness } from "aai-server/sandbox-vm";
import type { WorkspaceStore } from "aai-server/workspace-store";
import { createPreviewDeployer, type PreviewOrigin, type PreviewTarget } from "./studio-preview.ts";
import type { PreviewQueue } from "./studio-preview-queue.ts";
import type { adoptPeerSession } from "./studio-session-adopt.ts";
import { createSessionInstaller } from "./studio-session-ensure.ts";
import type { SessionEntry } from "./studio-session-entry.ts";
import { createSessionFleet, soloFleet } from "./studio-session-fleet.ts";
import { createSessionReaper } from "./studio-session-idle.ts";
import {
  createWorkspacePublisher,
  type PublisherDeps,
  type WorkspaceDeployOutcome,
  type WorkspaceDeployTarget,
} from "./studio-session-publish.ts";
import { STUDIO_SESSION_IDLE_MS, type StudioSessionRegistry } from "./studio-session-registry.ts";
import { wireGuest } from "./studio-session-wire.ts";
import { projectKey } from "./studio-workspace.ts";

// Deploy shapes live with the deploy path (studio-session-publish.ts) and
// are re-exported here because this module is the broker's public face.
export type { WorkspaceDeployOutcome, WorkspaceDeployTarget } from "./studio-session-publish.ts";
export { chatUrlForGuest } from "./studio-session-wire.ts";

type BrokerStores = {
  workspaces: WorkspaceStore;
  chats: ChatStore;
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
   * Durable preview-deploy queue (studio-preview-queue.ts): pgmq over the
   * platform database in production, `createMemoryPreviewQueue()` in a single
   * process.
   *
   * **REQUIRED, and it used to default to memory** — `options.previewQueue ??
   * createMemoryPreviewQueue()`, in production source, where every other memory
   * selection in this codebase announces itself with a `console.info` naming the
   * tier. The composition root already decides (index.ts picks pgmq when there
   * is a `sql`), so the `??` was a second decision point that could only ever
   * disagree with the first, silently, by substituting a queue that loses
   * pending deploys on restart. One decision, at the root; a missing queue is
   * now a compile error rather than a quiet downgrade.
   */
  previewQueue: PreviewQueue;
  /**
   * A studio user's stored AssemblyAI key, so a preview job REDELIVERED to a
   * replica that did not enqueue it can still deploy. Without it, only
   * same-replica jobs run (see `createPreviewDeployer`).
   */
  resolveApiKey?: (userId: string) => Promise<string | null>;
  /** A per-deploy follow-up BOTH deploy paths run — see {@link PublisherDeps}. */
  afterDeploy?: PublisherDeps["afterDeploy"];
};

export type StudioSessionBroker = {
  /**
   * Boot or reuse the project's sandbox, (re-)install the session with the
   * workspace's current files, and return the guest's public chat URL.
   * Null when the project doesn't exist.
   *
   * `preview` arms auto preview deploys: the guest's end-of-turn
   * `studio/sync-workspace` schedules a deploy of the edited workspace to the
   * project's preview slug (studio-preview.ts). Omitted, agent edits sync
   * without auto-previewing.
   *
   * It is an OBJECT, not a bare `serverUrl`, because the caller's `userId`
   * has to ride along with it: a queued preview job that does not name a
   * studio user can only ever be run by the replica that enqueued it, and is
   * ARCHIVED — the work silently dropped — the moment it is redelivered
   * anywhere else. That is the exact durability the queue exists to provide,
   * and while this took a bare string the primary preview path (every coding
   * agent turn) could not supply the field at all.
   */
  ensureSession(
    scope: string,
    project: string,
    apiKey: string,
    preview?: PreviewOrigin,
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
          ...omitUndefined({ adopt: options.adopt }),
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
      scope,
      project,
    );
  }

  // Reuse → adopt → spawn, and what an install IS (studio-session-ensure.ts).
  // Every call below runs under `sessionLock`.
  const { ensureSessionLocked } = createSessionInstaller({
    workspaces: options.workspaces,
    env,
    spawn,
    harnessPath: options.harnessPath,
    sessions,
    fleet,
    disposeEntry,
    wire,
  });

  const deployWorkspaceImpl = createWorkspacePublisher({
    spawn,
    harnessPath: options.harnessPath,
    // Both deploy paths below go through this one publisher, which is what
    // makes `afterDeploy` a per-deploy consequence neither can skip.
    ...omitUndefined({ afterDeploy: options.afterDeploy }),
    liveSession: (scope, project) => {
      const entry = sessions.get(projectKey(scope, project));
      if (!entry) return null;
      return {
        warm: entry.warm,
        touch: () => {
          entry.lastUsed = Date.now();
        },
        // A counter rather than a flag: Publish and an auto preview deploy can
        // both be in this sandbox at once, and the first to finish must not
        // clear the other's protection.
        hold: () => {
          entry.inFlight += 1;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            entry.inFlight -= 1;
          };
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
    queue: options.previewQueue,
    ...omitUndefined({ resolveApiKey: options.resolveApiKey }),
  });

  return {
    ensureSession(scope, project, apiKey, preview) {
      const key = projectKey(scope, project);
      // Per project, not global: brokering one project must never queue
      // behind another project's Modal spawn.
      return withLock(sessionLock, key, () =>
        ensureSessionLocked(key, scope, project, apiKey, { preview }),
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
