// Copyright 2025 the AAI authors. MIT license.
// REST helpers for the studio's project/file/deploy endpoints.

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { UIMessage } from "ai";
import { parse } from "dotenv";
import { ApiError } from "./api-error.ts";
import { type StreamDownReason, watchEventStream } from "./api-events.ts";
import {
  ACCOUNT_ATTEMPT_TIMEOUT_MS,
  AGENT_LOGS_ATTEMPT_TIMEOUT_MS,
  AGENT_PAGE_PROBE_TIMEOUT_MS,
  AUTH_CONFIG_ATTEMPT_TIMEOUT_MS,
  CHAT_SESSION_ATTEMPT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  STATUS_ATTEMPT_TIMEOUT_MS,
} from "./api-timeouts.ts";
import {
  type Account,
  type AgentLogsPage,
  type AuthConfig,
  type ChatSession,
  type GithubRepo,
  type GithubStatus,
  type GithubSyncResult,
  isChatMessages,
  isProjectData,
  isProjectNames,
  type ProjectData,
  type ProjectKind,
  type StudioStatus,
} from "./api-types.ts";

// Re-exported for the same reason the types above are: one import per pane.
export {
  ACCOUNT_ATTEMPT_TIMEOUT_MS,
  AGENT_LOGS_ATTEMPT_TIMEOUT_MS,
  AGENT_PAGE_PROBE_TIMEOUT_MS,
  AUTH_CONFIG_ATTEMPT_TIMEOUT_MS,
  CHAT_SESSION_ATTEMPT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  STATUS_ATTEMPT_TIMEOUT_MS,
} from "./api-timeouts.ts";
// Re-exported so `./api.ts` stays the one import for a pane that needs both
// the call and the shape it answers with.
export type {
  Account,
  AgentLogLine,
  AgentLogsPage,
  AuthConfig,
  ChatSession,
  GithubRepo,
  GithubStatus,
  GithubSyncResult,
  ProjectData,
  ProjectKind,
  StudioStatus,
} from "./api-types.ts";

/** Stands in for a body that would not parse — one sentinel, not one per call. */
const INVALID_BODY = Symbol("invalid-body");

/** Throw an {@link ApiError} on non-2xx responses, else parse the JSON body. */
async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message);
  }
  // A 2xx with a non-JSON body (a proxy error page, say) should surface as
  // the same error type as everything else, not a raw SyntaxError.
  const parsed: unknown = await res.json().catch(() => INVALID_BODY);
  if (parsed === INVALID_BODY) {
    throw new ApiError(res.status, "Server returned an invalid response");
  }
  return parsed as T;
}

/**
 * A request, with a deadline.
 *
 * `timeoutMs` overrides {@link DEFAULT_REQUEST_TIMEOUT_MS} for callers whose
 * work really is slower (the broker) or whose screen cannot afford to wait (the
 * gates). A caller's own `signal` is COMPOSED with the deadline rather than
 * replacing it — `AbortSignal.any` fires on whichever comes first — so passing
 * one can only ever make a request settle sooner.
 */
type ApiInit = RequestInit & { timeoutMs?: number };

async function fetchJson<T>(path: string, init: ApiInit = {}): Promise<T> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal, ...rest } = init;
  const deadline = AbortSignal.timeout(timeoutMs);
  const res = await fetch(path, {
    ...rest,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  return handleResponse<T>(res);
}

/**
 * Same-origin request against the platform's own agent routes (`/:slug/…`) —
 * the secrets panel talks to the exact routes `aai secret` uses.
 */
function agentRequest<T>(key: string, path: string, init: ApiInit = {}): Promise<T> {
  return fetchJson<T>(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      // The guard is not the value here — a body decides whether the header
      // exists, it is not the header — so this stays a conditional spread
      // rather than becoming an `omitUndefined` entry.
      ...(init.body != null && { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
}

/** The same request, against the studio surface (`/studio/…`). */
function request<T>(key: string, path: string, init: ApiInit = {}): Promise<T> {
  return agentRequest<T>(key, `/studio${path}`, init);
}

/**
 * One project's route prefix, with the name encoded exactly once. Every
 * per-project call below hangs off it, and an `encodeURIComponent` spelled out
 * per call is a per-call chance to forget it.
 */
function projectPath(project: string, suffix = ""): string {
  return `/projects/${encodeURIComponent(project)}${suffix}`;
}

export const api = {
  /**
   * A deployed agent's captured stdout/stderr, after `after`.
   *
   * Straight at the PLATFORM route (`/:slug/logs`) rather than through a studio
   * one, for the same reason the secrets panel talks to `/:slug/secret`: the
   * route already owns the ownership check, and a studio proxy in front of it
   * would be a second place to get that wrong. The bearer is the studio
   * session's, which `resolveBearer` maps to the account's own API key — the
   * same credential the project's agents were deployed with.
   *
   * A short deadline, and a shorter one than {@link DEFAULT_REQUEST_TIMEOUT_MS}:
   * this is a POLL, so a slow answer is better abandoned and re-asked than
   * waited out — the next tick is a second away.
   */
  agentLogs: (key: string, slug: string, after: number): Promise<AgentLogsPage> =>
    agentRequest<AgentLogsPage>(key, `/${slug}/logs?after=${after}`, {
      timeoutMs: AGENT_LOGS_ATTEMPT_TIMEOUT_MS,
    }),

  /**
   * Which LLM the studio's chat runs on. Public, and deadlined for the reason
   * {@link DEFAULT_REQUEST_TIMEOUT_MS} exists — see
   * {@link STATUS_ATTEMPT_TIMEOUT_MS} for why this one is shorter.
   */
  status: (): Promise<StudioStatus> =>
    fetchJson<StudioStatus>("/studio/status", { timeoutMs: STATUS_ATTEMPT_TIMEOUT_MS }),

  /** Public: which login flow to render. */
  authConfig: (): Promise<AuthConfig> =>
    fetchJson<AuthConfig>("/studio/auth", { timeoutMs: AUTH_CONFIG_ATTEMPT_TIMEOUT_MS }),

  /**
   * Session-authed (works before an AssemblyAI key is stored). Deadlined so
   * a hung read reaches the gate as a failure it can offer to retry — see
   * {@link ACCOUNT_ATTEMPT_TIMEOUT_MS}.
   */
  getAccount: (key: string) =>
    request<Account>(key, "/account", { timeoutMs: ACCOUNT_ATTEMPT_TIMEOUT_MS }),

  /** Store the user's AssemblyAI API key — the one-time onboarding step. */
  putAccountKey: (key: string, apiKey: string) =>
    request<{ ok: true }>(key, "/account/key", {
      method: "PUT",
      body: JSON.stringify({ apiKey }),
    }),

  /**
   * Approve an `aai login` link code, granting the terminal that minted it
   * a one-shot exchange for this account's stored API key.
   */
  approveCliLink: (key: string, code: string) =>
    request<{ ok: true }>(key, "/cli-link/approve", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  /**
   * Is GitHub sync available here, and has this account connected it?
   *
   * Session-authed against `requireStudioUser`, like the account routes — so
   * it costs a round trip to Supabase's Auth server and is read once per pane
   * open rather than polled.
   */
  githubStatus: (key: string) => request<GithubStatus>(key, "/github"),

  /**
   * Mint the GitHub App install redirect and hand back where to send the tab.
   *
   * A call rather than a URL read from {@link githubStatus}, because the state
   * inside it expires: a settings pane left open would otherwise hold a link
   * that fails after the user has already picked their repositories.
   *
   * `project` is a return hint — the callback lands the browser back on the
   * project the button was pressed from.
   */
  githubConnect: (key: string, project?: string) =>
    request<{ installUrl: string }>(key, "/github/connect", {
      method: "POST",
      body: JSON.stringify(omitUndefined({ project })),
    }),

  /**
   * Forget the link. This does NOT uninstall the App on GitHub's side — the
   * card says so, because claiming otherwise would report access revoked while
   * the installation still granted it.
   */
  githubDisconnect: (key: string) => request<{ ok: true }>(key, "/github", { method: "DELETE" }),

  /**
   * Create a repository under the installation's ORGANIZATION.
   *
   * Organizations only, and that is GitHub's boundary rather than ours:
   * `POST /user/repos` is unavailable to an installation token at all. The
   * server answers a personal account with the instruction (create it on
   * GitHub, then add it to the installation) — which is why the card only
   * offers this control for an org.
   */
  githubCreateRepo: (key: string, name: string) =>
    request<{ repo: GithubRepo }>(key, "/github/repos", {
      method: "POST",
      body: JSON.stringify({ name }),
    }).then((r) => r.repo),

  /** Repositories the installation can write — the picker's options. */
  githubRepos: (key: string) =>
    request<{ repos: GithubRepo[] }>(key, "/github/repos").then((r) => r.repos),

  /**
   * Push the project's files to GitHub as one commit.
   *
   * No branch: the server reads the repository's own default at push time,
   * which is the only value that cannot be a rename out of date.
   */
  syncToGithub: (key: string, project: string, repo: string) =>
    request<GithubSyncResult>(key, projectPath(project, "/github/sync"), {
      method: "POST",
      body: JSON.stringify({ repo }),
    }),

  listProjects: (key: string) =>
    request<{ projects: string[] }>(key, "/projects").then((r) => r.projects),

  /**
   * Create a project. The server generates the name — a readable base
   * derived from the creating chat prompt plus a random suffix, v0-style
   * (`contact-form-x7k2mq`) — so names are minted in exactly one place,
   * shared with the CLI's slugless deploy path.
   *
   * `kind` is the hero's switcher position. Sent on every create rather than
   * only for workflows: the server defaults an absent one to `agent`, and
   * saying which was chosen is what keeps that default from doubling as
   * "nobody chose".
   */
  createProject: (key: string, opts: { prompt?: string; kind?: ProjectKind }) =>
    request<{ name: string; files: Record<string, string>; kind?: ProjectKind }>(key, "/projects", {
      method: "POST",
      body: JSON.stringify(omitUndefined({ prompt: opts.prompt, kind: opts.kind })),
    }),

  /** Delete a project (its workspace and chat). Deployed agents stay live. */
  deleteProject: (key: string, project: string) =>
    request<{ ok: true }>(key, projectPath(project), {
      method: "DELETE",
    }),

  getProject: (key: string, project: string) => request<ProjectData>(key, projectPath(project)),

  /**
   * Does the platform serve an agent page at `/:slug/` yet? Unauthenticated,
   * like the page itself — the Preview pane frames that URL directly, so it
   * asks first (see the probe in preview.tsx). The agent health route is the
   * exact question: it 404s when there is no agents row, which is precisely
   * when the page 404s, and it says nothing about the sandbox (a booting
   * sandbox is the page's own business — its client re-brokers).
   *
   * A rejected fetch reads as "not there" rather than throwing: the caller
   * polls, and there is nothing to do about an offline browser here — a hung
   * one must reach that same path or it takes the poll loop with it (see
   * {@link AGENT_PAGE_PROBE_TIMEOUT_MS}).
   */
  agentPageReady: (slug: string): Promise<boolean> =>
    fetch(`/${encodeURIComponent(slug)}/health`, {
      signal: AbortSignal.timeout(AGENT_PAGE_PROBE_TIMEOUT_MS),
    }).then(
      (res) => res.ok,
      () => false,
    ),

  /**
   * Tell the server the platform is not serving this project's preview, so it
   * regenerates one.
   *
   * The server already has the recovery — `wakeProjectPreview` clears the
   * stamp and enqueues a deploy when the broker 404s — but the only thing that
   * TRIGGERED it was opening the project. A tab already open when the preview
   * is swept out from under it never re-brokers a session, so the pane could
   * poll {@link agentPageReady} indefinitely against a slug nothing was ever
   * going to redeploy: measured in production at 1,061 probes across 50
   * minutes, ended only by the user happening to do something that booted a
   * session.
   *
   * The client is a TRIGGER, never the evidence: the server re-checks with its
   * own broker call and schedules nothing unless that 404s too. So a caller
   * cannot talk the platform into a deploy, and a probe that failed for some
   * local reason (an offline tab) costs one no-op.
   *
   * One delivered call is enough — the wake enqueues a DURABLE job, and the
   * queue owns retries from there — so the pane sends this once per missing
   * preview rather than on every failed probe.
   */
  wakePreview: (key: string, project: string) =>
    request<{ ok: true }>(key, projectPath(project, "/preview/wake"), {
      method: "POST",
    }),

  /**
   * Subscribe to the project's live state (`GET …/events`, SSE): the server
   * pushes a full {@link ProjectData} whenever the workspace row changes —
   * fed by Supabase Realtime server-side — which is how a finished preview
   * deploy reaches the Preview pane (this replaced the polling loop), and
   * the settled conversation whenever a chat turn persists, so other tabs
   * stay warm. Returns an abort function; `onDown` fires when the stream
   * ends or fails, carrying the {@link StreamDownReason} so the caller can
   * resubscribe with backoff — or refresh its bearer first.
   */
  watchProject: (
    key: string,
    project: string,
    handlers: {
      onData: (data: ProjectData) => void;
      onChat?: (messages: UIMessage[]) => void;
      onOpen?: () => void;
      onDown: (reason: StreamDownReason) => void;
    },
  ): (() => void) =>
    watchEventStream(key, `/studio${projectPath(project, "/events")}`, {
      onFrame: (frame) => {
        // Guarded rather than cast: `frame.data` is `unknown` (the SDK's reader
        // parses the JSON and claims nothing about it), and a frame that is not
        // the shape this build expects is DROPPED — every frame here carries a
        // whole snapshot, so the next one restates the same state.
        if (frame.event === "project" && isProjectData(frame.data)) handlers.onData(frame.data);
        if (frame.event === "chat" && isChatMessages(frame.data)) handlers.onChat?.(frame.data);
      },
      ...omitUndefined({ onOpen: handlers.onOpen }),
      onDown: handlers.onDown,
    }),

  /**
   * Subscribe to the caller's live project LIST (`GET /studio/events`) —
   * a project created or deleted on another device updates the home
   * sidebar without a refresh.
   */
  watchProjects: (
    key: string,
    handlers: {
      onData: (projects: string[]) => void;
      onOpen?: () => void;
      onDown: (reason: StreamDownReason) => void;
    },
  ): (() => void) =>
    watchEventStream(key, "/studio/events", {
      onFrame: (frame) => {
        if (frame.event === "projects" && isProjectNames(frame.data)) handlers.onData(frame.data);
      },
      ...omitUndefined({ onOpen: handlers.onOpen }),
      onDown: handlers.onDown,
    }),

  writeFile: (key: string, project: string, path: string, content: string) =>
    request<{ ok: boolean }>(key, projectPath(project, "/file"), {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),

  /**
   * Boot (or refresh) the project's coding-agent sandbox. The returned URL
   * is the sandbox's public chat endpoint — the browser streams turns to it
   * DIRECTLY, the same way voice sessions connect straight to a deployed
   * agent's sandbox.
   */
  createChatSession: (key: string, project: string) =>
    request<ChatSession>(key, projectPath(project, "/session"), {
      method: "POST",
      body: "{}",
      // Longer than the default, not shorter: this one really can take two
      // minutes of honest work (see CHAT_SESSION_ATTEMPT_TIMEOUT_MS).
      timeoutMs: CHAT_SESSION_ATTEMPT_TIMEOUT_MS,
    }),

  /**
   * Tool name → user-friendly label, served by the sandbox itself.
   * Authenticated with the brokered session's own token, like every call to
   * the sandbox's public surface.
   */
  sandboxToolLabels: async (
    sessionToken: string,
    sessionUrl: string,
  ): Promise<Record<string, string>> => {
    const { tools } = await agentRequest<{ tools: { name: string; label: string }[] }>(
      sessionToken,
      sessionUrl.replace(/\/chat$/, "/tools"),
    );
    return Object.fromEntries(tools.map((t) => [t.name, t.label]));
  },

  getChat: (key: string, project: string) =>
    request<{ messages: UIMessage[] }>(key, projectPath(project, "/chat")).then((r) => r.messages),

  /**
   * Publish: the project's sandbox runs `aai deploy`; `output` is the CLI's
   * output (post it into the chat so the coding agent sees it).
   */
  deploy: (key: string, project: string) =>
    request<{ ok: true; slug: string; url: string; output: string }>(
      key,
      projectPath(project, "/deploy"),
      { method: "POST", body: "{}" },
    ),

  // PROJECT secrets — written to both of the project's deployed agents
  // (production and preview) by the server. This panel used to PUT the
  // production slug's platform route and then mirror to the preview one
  // itself, which made "a project is two agents" a fact only this client
  // knew: `aai secret put` and `aai publish`'s .env sync reached production
  // alone. The per-slug routes are still the platform primitive underneath.

  // `pending` names are held by the project but not yet by every deployed
  // agent — they arrive with that agent's next deploy. A project with nothing
  // deployed reports all of its names that way, which is the state the panel
  // exists to make workable.
  listSecrets: (key: string, project: string) =>
    request<{ vars: string[]; pending?: string[] }>(key, projectPath(project, "/secret")).then(
      (r) => ({ vars: r.vars, pending: r.pending ?? [] }),
    ),

  putSecrets: (key: string, project: string, updates: Record<string, string>) =>
    request<{ vars: string[] }>(key, projectPath(project, "/secret"), {
      method: "PUT",
      body: JSON.stringify(updates),
    }),

  deleteSecret: (key: string, project: string, name: string) =>
    request<{ vars: string[] }>(key, projectPath(project, `/secret/${encodeURIComponent(name)}`), {
      method: "DELETE",
    }),
};

/**
 * Parse "KEY=value" lines from the secrets textarea.
 *
 * People paste straight from a .env file, so this must speak real .env
 * syntax — including multi-line quoted values (PEM keys, service-account
 * JSON) and `\n` escapes in double-quoted values — hence dotenv's `parse`
 * rather than a hand-rolled line splitter.
 */
export function parseSecrets(text: string): Record<string, string> {
  return parse(text);
}
