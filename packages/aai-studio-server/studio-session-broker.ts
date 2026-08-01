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
 * turns, and Publish's build is the host→guest `workspace/build` request
 * (`buildWorkspace` below) — the one build path `aai deploy` also runs.
 *
 * Sandboxes are per (scope, project), reused across turns, and evicted
 * after an idle window — a per-replica accelerator exactly like the agent
 * service's slot cache: losing one costs a re-broker, never correctness
 * (the client re-brokers on a dead chat URL).
 */

import { errorMessage } from "@alexkroman1/aai";
import { MAX_WORKER_SIZE, resolveHarnessPath } from "aai-server/constants";
import { registerGuestRpcHandlers } from "aai-server/sandbox-guest-rpc";
import type { SandboxPool } from "aai-server/sandbox-pool";
import { spawnWarmHarness, type WarmHarness } from "aai-server/sandbox-vm";
import { SafePathSchema } from "aai-server/schemas";
import { z } from "zod";
import { MAX_STUDIO_FILE_BYTES, MAX_STUDIO_FILES } from "./studio-limits.ts";
import { studioLlmModelId } from "./studio-llm.ts";
import { studioSystemPrompt } from "./studio-prompt.ts";
import { MAX_STUDIO_CHAT_MESSAGES, UiMessageSchema } from "./studio-schemas.ts";
import { getWorkspace, mutateWorkspace } from "./studio-workspace.ts";

/** Max tool-loop steps per chat turn (Claude-Code-scale agentic budget). */
export const MAX_CHAT_STEPS = 16;
/** Idle window before a project's sandbox is evicted. */
export const STUDIO_SESSION_IDLE_MS = 15 * 60_000;
/** Deadline for installing a session in the guest (workspace transfer). */
const SESSION_INIT_TIMEOUT_MS = 60_000;
/** Deadline for one in-guest Publish build (two cold Vite passes). */
const WORKSPACE_BUILD_TIMEOUT_MS = 300_000;

/** Guest-supplied workspace files — validated exactly like a client PUT. */
const GuestFilesSchema = z.object({
  files: z
    .record(SafePathSchema, z.string().max(MAX_STUDIO_FILE_BYTES))
    .refine((files) => Object.keys(files).length <= MAX_STUDIO_FILES, {
      message: `Too many files (max ${MAX_STUDIO_FILES})`,
    }),
});

// Guest-sent wire data: the settled conversation is validated per message
// (structure + content-size cap) before it lands in the chat store, not
// accepted as a blob of unknowns.
const GuestChatSchema = z.object({
  messages: z.array(UiMessageSchema).max(MAX_STUDIO_CHAT_MESSAGES),
});

/**
 * Response of the guest's `workspace/build` (guest-asserted wire data).
 * `config` stays `unknown` here — the deploy flow validates it with
 * `validateAgentConfig` (IsolateConfigSchema), same contract as
 * `describeBundle`'s result on the HTTP deploy path.
 */
const WorkspaceBuildResponseSchema = z.object({
  worker: z.string().max(MAX_WORKER_SIZE).optional(),
  clientFiles: z.record(SafePathSchema, z.string().max(MAX_WORKER_SIZE)).optional(),
  config: z.unknown().optional(),
  buildError: z.string().optional(),
});

export type WorkspaceBuildOutcome =
  | { ok: true; worker: string; clientFiles: Record<string, string>; config: unknown }
  | { ok: false; error: string };

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
   */
  ensureSession(scope: string, project: string, apiKey: string): Promise<{ url: string } | null>;
  /**
   * Build one workspace snapshot in a guest sandbox (`workspace/build`) —
   * the Publish build. Reuses the project's live sandbox when one exists;
   * otherwise a sandbox is spawned for the build and torn down after.
   */
  buildWorkspace(
    scope: string,
    project: string,
    files: Record<string, string>,
  ): Promise<WorkspaceBuildOutcome>;
  /** Tear down every live sandbox (tests, shutdown). */
  dispose(): Promise<void>;
};

type SessionEntry = {
  warm: WarmHarness;
  url: string;
  lastUsed: number;
};

/** `wss://host:port/websocket` (the voice endpoint) → the chat URL. */
export function chatUrlFromSessionUrl(sessionUrl: string): string {
  const url = new URL(sessionUrl);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  url.pathname = "/studio/chat";
  return url.toString();
}

/**
 * Session-map key. NUL separator: neither a scope hash nor a validated
 * project name can contain it, so distinct (scope, project) pairs can never
 * collide the way a printable separator would allow.
 */
function sessionKey(scope: string, project: string): string {
  return `${scope}\u0000${project}`;
}

export function createStudioSessionBroker(
  options: StudioSessionBrokerOptions,
): StudioSessionBroker {
  const spawn = options.spawn ?? spawnWarmHarness;
  const env = options.env ?? process.env;
  const idleMs = options.idleMs ?? STUDIO_SESSION_IDLE_MS;
  const sessions = new Map<string, SessionEntry>();

  async function disposeEntry(key: string): Promise<void> {
    const entry = sessions.get(key);
    if (!entry) return;
    sessions.delete(key);
    await entry.warm[Symbol.asyncDispose]().catch(() => undefined);
  }

  // Idle eviction: chat turns run browser→guest, so the host's only view of
  // activity is broker calls and the guest's end-of-turn RPCs (both touch
  // lastUsed). Losing a live-but-quiet sandbox costs one re-broker.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of sessions) {
      if (now - entry.lastUsed > idleMs) void disposeEntry(key);
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
  ): Promise<boolean> {
    const workspace = await getWorkspace(options.workspaces, scope, project);
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

  /** Send one `workspace/build` and validate the guest's response. */
  async function requestBuild(
    warm: WarmHarness,
    files: Record<string, string>,
  ): Promise<WorkspaceBuildOutcome> {
    const raw = await warm.conn.sendRequest(
      "workspace/build",
      { files, worker: true, client: true },
      WORKSPACE_BUILD_TIMEOUT_MS,
    );
    const parsed = WorkspaceBuildResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: `Malformed build response from sandbox: ${parsed.error.message}` };
    }
    const built = parsed.data;
    if (built.buildError !== undefined) return { ok: false, error: built.buildError };
    if (built.worker === undefined || built.clientFiles === undefined) {
      return { ok: false, error: "Sandbox build returned incomplete artifacts" };
    }
    return { ok: true, worker: built.worker, clientFiles: built.clientFiles, config: built.config };
  }

  return {
    async ensureSession(scope, project, apiKey) {
      const key = sessionKey(scope, project);
      const existing = sessions.get(key);
      if (existing) {
        // Re-init on every broker call: the workspace may have changed in
        // the editor, and a fresh page session must never see a stale tree.
        try {
          const ok = await initSession(existing.warm, scope, project, apiKey);
          if (!ok) return null;
          existing.lastUsed = Date.now();
          return { url: existing.url };
        } catch (err) {
          // Dead sandbox (idle-killed, crashed) — replace it below.
          console.warn("Studio session: re-init failed; respawning sandbox", {
            project,
            error: errorMessage(err),
          });
          await disposeEntry(key);
        }
      }
      const pooled = (await options.pool?.acquire()) ?? null;
      const warm =
        pooled ??
        (await spawn({
          harnessPath: options.harnessPath ?? resolveHarnessPath(),
          slug: "studio-session",
        }));
      try {
        wire(warm, key, scope, project);
        const ok = await initSession(warm, scope, project, apiKey);
        if (!ok) {
          await warm[Symbol.asyncDispose]().catch(() => undefined);
          return null;
        }
      } catch (err) {
        await warm[Symbol.asyncDispose]().catch(() => undefined);
        throw err;
      }
      const url = chatUrlFromSessionUrl(warm.sessionUrl);
      sessions.set(key, { warm, url, lastUsed: Date.now() });
      return { url };
    },

    async buildWorkspace(scope, project, files) {
      const key = sessionKey(scope, project);
      const existing = sessions.get(key);
      if (existing) {
        try {
          const outcome = await requestBuild(existing.warm, files);
          existing.lastUsed = Date.now();
          return outcome;
        } catch (err) {
          // Dead sandbox — replace it with a fresh one for this build; the
          // next chat broker call heals the session itself.
          console.warn("Studio build: live sandbox failed; using a fresh one", {
            project,
            error: errorMessage(err),
          });
          await disposeEntry(key);
        }
      }
      // No (live) session sandbox — spawn one for the build and tear it
      // down after; Publish from the editor shouldn't leave a sandbox
      // running that no chat session owns.
      const warm =
        (await options.pool?.acquire()) ??
        (await spawn({
          harnessPath: options.harnessPath ?? resolveHarnessPath(),
          slug: "studio-build",
        }));
      try {
        registerGuestRpcHandlers(warm.conn, {});
        warm.conn.listen();
        return await requestBuild(warm, files);
      } finally {
        await warm[Symbol.asyncDispose]().catch(() => undefined);
      }
    },

    async dispose() {
      clearInterval(sweeper);
      await Promise.allSettled([...sessions.keys()].map((key) => disposeEntry(key)));
    },
  };
}
