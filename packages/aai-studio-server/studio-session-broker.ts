// Copyright 2026 the AAI authors. MIT license.
/**
 * Brokers the studio's per-project coding-agent sandboxes — the studio
 * mirror of `GET /:slug/client-config` for voice sessions.
 *
 * `POST /studio/projects/:project/session` lands here: the broker boots (or
 * reuses) a guest sandbox through the SAME machinery deployed agents use —
 * the warm pool when available, else `spawnWarmHarness` (a remote Modal
 * Sandbox from the baked harness image) — installs the studio session in it
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

import { createOwnedMap, errorMessage } from "@alexkroman1/aai";
import { GUEST_ROUTES, guestHttpUrl } from "aai-server/guest-routes";
import { createKeyedLock } from "aai-server/platform-barrel";
import { registerGuestRpcHandlers } from "aai-server/sandbox-guest-rpc";
import type { SandboxPool } from "aai-server/sandbox-pool";
import { withLock } from "aai-server/sandbox-slots";
import { acquireWarmHarness, spawnWarmHarness, type WarmHarness } from "aai-server/sandbox-vm";
import { SafePathSchema } from "aai-server/schemas";
import { z } from "zod";
import { studioLlmModelId } from "./studio-llm.ts";
import { createPreviewDeployer, type PreviewTarget } from "./studio-preview.ts";
import { studioSystemPrompt } from "./studio-prompt.ts";
import { MAX_STUDIO_CHAT_MESSAGES, UiMessageSchema } from "./studio-schemas.ts";
import { getWorkspace, mutateWorkspace, projectKey } from "./studio-workspace.ts";

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
/** Idle window before a project's sandbox is evicted. */
const STUDIO_SESSION_IDLE_MS = 15 * 60_000;
/** Deadline for installing a session in the guest (workspace transfer). */
const SESSION_INIT_TIMEOUT_MS = 60_000;
/** Deadline for one in-guest Publish (`aai deploy`: cold build + upload). */
const WORKSPACE_DEPLOY_TIMEOUT_MS = 330_000;

/**
 * Guest-supplied workspace files. Wire-shape check only (record of safe
 * paths to strings): the size/count/total-byte limits are enforced by the
 * single authority a client file PUT also goes through —
 * `stampWorkspace`'s `assertWorkspaceLimits`, inside the `mutateWorkspace`
 * call below, whose throw rejects the RPC just the same.
 */
const GuestFilesSchema = z.object({
  files: z.record(SafePathSchema, z.string()),
  /**
   * True only on the TURN-COMPLETE sync (the guest's `settleTurn`, its
   * analog of opencode's `session.idle` / codex's `agent-turn-complete`).
   * Mid-turn checkpoints omit it, so preview deploys are keyed
   * deterministically to settled turns — never to a half-finished tree.
   */
  done: z.boolean().optional(),
});

// Guest-sent wire data: the settled conversation is validated per message
// (structure + content-size cap) before it lands in the chat store, not
// accepted as a blob of unknowns.
const GuestChatSchema = z.object({
  messages: z.array(UiMessageSchema).max(MAX_STUDIO_CHAT_MESSAGES),
});

/**
 * Response of the guest's `workspace/deploy` (guest-asserted wire data):
 * the guest ran the literal `aai deploy` CLI, and `output` is what the
 * chat shows — a success summary or the CLI's failure diagnostics.
 */
const WorkspaceDeployResponseSchema = z.object({
  ok: z.boolean(),
  slug: z.string().optional(),
  url: z.string().optional(),
  output: z.string().max(64_000),
});

export type WorkspaceDeployOutcome = z.infer<typeof WorkspaceDeployResponseSchema>;

/** What Publish hands the guest's CLI: the platform origin + caller key. */
export type WorkspaceDeployTarget = {
  serverUrl: string;
  apiKey: string;
  slug?: string | undefined;
};

type BrokerStores = {
  workspaces: import("aai-server/workspace-store").WorkspaceStore;
  chats: import("aai-server/chat-store").ChatStore;
};

export type StudioSessionBrokerOptions = BrokerStores & {
  pool?: SandboxPool | undefined;
  harnessPath?: string;
  /** Injectable for tests — defaults to the shared warm-harness spawner. */
  spawn?: typeof spawnWarmHarness;
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
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
  ): Promise<{ url: string } | null>;
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

type SessionEntry = {
  warm: WarmHarness;
  url: string;
  lastUsed: number;
  /**
   * Where this session's auto preview deploys go — the public origin and
   * caller key captured at broker time. Absent when the session was brokered
   * without a `serverUrl` (tests, programmatic callers): then agent edits
   * sync without auto-previewing.
   */
  previewTarget?: PreviewTarget;
  /** This claim's release on the `sessions` owned map (see `disposeEntry`). */
  release: () => boolean;
};

/**
 * The guest's chat URL, derived from the origin the backend reported.
 *
 * This used to reverse-engineer `sessionUrl` — swap the scheme, overwrite the
 * pathname — to reach a surface this package was never handed. Deriving from
 * the origin means a guest route rename is one edit in `guest-routes.ts`
 * rather than two backends plus URL surgery in another package.
 */
export function chatUrlForGuest(guestOrigin: string): string {
  return guestHttpUrl(guestOrigin, GUEST_ROUTES.studioChat);
}

export function createStudioSessionBroker(
  options: StudioSessionBrokerOptions,
): StudioSessionBroker {
  const spawn = options.spawn ?? spawnWarmHarness;
  const env = options.env ?? process.env;
  const idleMs = options.idleMs ?? STUDIO_SESSION_IDLE_MS;
  const sessions = createOwnedMap<string, SessionEntry>();
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

  /**
   * Tear down `entry` and drop it from the map — but only while it is still
   * the project's session. Every caller runs its cleanup AFTER an await (a
   * re-init that rejected, a publish whose sandbox died mid-request), and by
   * then the client may have re-brokered and installed a replacement: the
   * owned map's release deletes only while this claim still holds the key,
   * so a replacement is never evicted and never strands a live sandbox.
   */
  async function disposeEntry(entry: SessionEntry): Promise<void> {
    entry.release();
    await entry.warm[Symbol.asyncDispose]().catch(() => undefined);
  }

  // Idle eviction: chat turns run browser→guest, so the host's only view of
  // activity is broker calls and the guest's end-of-turn RPCs (both touch
  // lastUsed). Losing a live-but-quiet sandbox costs one re-broker.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const entry of sessions.values()) {
      if (now - entry.lastUsed > idleMs) void disposeEntry(entry);
    }
  }, 60_000);
  sweeper.unref?.();

  /** Wire the control channel for one project's sandbox. */
  function wire(warm: WarmHarness, key: string, scope: string, project: string): void {
    // No db — trial tool runs report storage-not-enabled, same as before.
    registerGuestRpcHandlers(warm.conn, {});
    const touch = (): void => {
      const entry = sessions.get(key);
      if (entry && entry.warm === warm) entry.lastUsed = Date.now();
    };
    warm.conn.onRequest("studio/sync-workspace", async (params) => {
      touch();
      const parsed = GuestFilesSchema.safeParse(params);
      // Throwing rejects the RPC — the guest logs it; the turn still streams.
      if (!parsed.success) throw new Error(`Invalid workspace sync: ${parsed.error.message}`);
      const doc = await mutateWorkspace(options.workspaces, scope, project, (workspace) => ({
        ...workspace,
        files: parsed.data.files,
      }));
      if (!doc) throw new Error(`Project ${project} not found`);
      // The turn settled with edits — ship the workspace to the preview slug
      // so the Preview pane picks it up without a Publish. Only on the
      // `done` sync: mid-turn checkpoints would preview half-finished trees.
      // Fire-and-forget: the sync must settle now; the deploy stamps its
      // outcome later.
      const entry = sessions.get(key);
      if (parsed.data.done && entry && entry.warm === warm && entry.previewTarget) {
        previews.schedule(scope, project, entry.previewTarget);
      }
      return { ok: true };
    });
    warm.conn.onRequest("studio/persist-chat", async (params) => {
      touch();
      const parsed = GuestChatSchema.safeParse(params);
      if (!parsed.success) throw new Error(`Invalid chat snapshot: ${parsed.error.message}`);
      await options.chats.putChat(scope, project, parsed.data.messages);
      return { ok: true };
    });
    warm.conn.listen();
  }

  async function initSession(
    warm: WarmHarness,
    scope: string,
    project: string,
    apiKey: string,
    /** Pre-read workspace; the cold path reads it BEFORE spawning a sandbox. */
    known?: Awaited<ReturnType<typeof getWorkspace>>,
  ): Promise<boolean> {
    const workspace = known ?? (await getWorkspace(options.workspaces, scope, project));
    if (!workspace) return false;
    await warm.conn.sendRequest(
      "studio/session-init",
      {
        project,
        files: workspace.files,
        apiKey,
        system: studioSystemPrompt(),
        model: studioLlmModelId(env),
        ...(env.STUDIO_LLM_REGION === "eu" ? { region: "eu" as const } : {}),
        maxSteps: MAX_CHAT_STEPS,
      },
      SESSION_INIT_TIMEOUT_MS,
    );
    return true;
  }

  /** Send one `workspace/deploy` and validate the guest's response. */
  async function requestDeploy(
    warm: WarmHarness,
    files: Record<string, string>,
    target: WorkspaceDeployTarget,
  ): Promise<WorkspaceDeployOutcome> {
    const raw = await warm.conn.sendRequest(
      "workspace/deploy",
      {
        files,
        serverUrl: target.serverUrl,
        apiKey: target.apiKey,
        ...(target.slug ? { slug: target.slug } : {}),
      },
      WORKSPACE_DEPLOY_TIMEOUT_MS,
    );
    const parsed = WorkspaceDeployResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        output: `Malformed deploy response from sandbox: ${parsed.error.message}`,
      };
    }
    return parsed.data;
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
  ): Promise<{ url: string } | null> {
    const existing = sessions.get(key);
    if (!existing) return null;
    try {
      const ok = await initSession(existing.warm, scope, project, apiKey);
      if (!ok) return null;
      existing.lastUsed = Date.now();
      if (serverUrl) existing.previewTarget = { serverUrl, apiKey };
      return { url: existing.url };
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

  /** Reuse-or-spawn for one project. Runs under that project's session lock. */
  async function ensureSessionLocked(
    key: string,
    scope: string,
    project: string,
    apiKey: string,
    serverUrl?: string,
  ): Promise<{ url: string } | null> {
    const reused = await reuseSession(key, scope, project, apiKey, serverUrl);
    if (reused) return reused;

    // Check the project exists BEFORE taking a sandbox. Spawning first and
    // discovering the 404 inside initSession burned a full Modal spawn +
    // teardown per bogus project id — and each one either drained a warm-pool
    // slot (making a real session pay a cold start) or billed a create.
    const workspace = await getWorkspace(options.workspaces, scope, project);
    if (!workspace) return null;

    const warm = await acquireWarmHarness(
      { pool: options.pool, harnessPath: options.harnessPath, slug: "studio-session" },
      spawn,
    );
    try {
      wire(warm, key, scope, project);
      const ok = await initSession(warm, scope, project, apiKey, workspace);
      if (!ok) {
        await warm[Symbol.asyncDispose]().catch(() => undefined);
        return null;
      }
    } catch (err) {
      await warm[Symbol.asyncDispose]().catch(() => undefined);
      throw err;
    }
    const url = chatUrlForGuest(warm.guestOrigin);
    const entry: SessionEntry = {
      warm,
      url,
      lastUsed: Date.now(),
      ...(serverUrl ? { previewTarget: { serverUrl, apiKey } } : {}),
      release: () => false,
    };
    entry.release = sessions.claim(key, entry);
    return { url };
  }

  /** One deploy (publish or preview): live sandbox first, else ephemeral. */
  async function deployWorkspaceImpl(
    scope: string,
    project: string,
    files: Record<string, string>,
    target: WorkspaceDeployTarget,
  ): Promise<WorkspaceDeployOutcome> {
    const key = projectKey(scope, project);
    const existing = sessions.get(key);
    if (existing) {
      try {
        const outcome = await requestDeploy(existing.warm, files, target);
        existing.lastUsed = Date.now();
        return outcome;
      } catch (err) {
        // Dead sandbox — replace it with a fresh one for this publish;
        // the next chat broker call heals the session itself.
        console.warn("Studio publish: live sandbox failed; using a fresh one", {
          project,
          error: errorMessage(err),
        });
        await disposeEntry(existing);
      }
    }
    // No (live) session sandbox — spawn one for the publish and tear it
    // down after; Publish from the editor shouldn't leave a sandbox
    // running that no chat session owns.
    const warm = await acquireWarmHarness(
      { pool: options.pool, harnessPath: options.harnessPath, slug: "studio-publish" },
      spawn,
    );
    try {
      registerGuestRpcHandlers(warm.conn, {});
      warm.conn.listen();
      return await requestDeploy(warm, files, target);
    } finally {
      await warm[Symbol.asyncDispose]().catch(() => undefined);
    }
  }

  // Auto preview deploys ride the same deploy path Publish uses — a live
  // session sandbox when one exists (the common case: the agent's own
  // sandbox, right after its turn), else an ephemeral spawn.
  const previews = createPreviewDeployer({
    workspaces: options.workspaces,
    deployWorkspace: deployWorkspaceImpl,
  });

  return {
    ensureSession(scope, project, apiKey, serverUrl) {
      const key = projectKey(scope, project);
      // Per project, not global: brokering one project must never queue
      // behind another project's Modal spawn.
      return withLock(sessionLock, key, () =>
        ensureSessionLocked(key, scope, project, apiKey, serverUrl),
      );
    },

    schedulePreview(scope, project, target) {
      previews.schedule(scope, project, target);
    },

    deployWorkspace: deployWorkspaceImpl,

    async dispose() {
      clearInterval(sweeper);
      await Promise.allSettled([...sessions.values()].map((entry) => disposeEntry(entry)));
    },
  };
}
