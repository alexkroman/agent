// Copyright 2025 the AAI authors. MIT license.
// REST helpers for the studio's project/file/deploy endpoints.

import {
  CLIENT_CONFIG_PATH,
  type ClientConfigResponse,
  ClientConfigResponseSchema,
} from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { UIMessage } from "ai";
import { parse } from "dotenv";
import { ApiError } from "./api-error.ts";
import { type StreamDownReason, watchEventStream } from "./api-events.ts";
import { tableReads } from "./api-tables.ts";
import type {
  Account,
  AgentLogsPage,
  AuthConfig,
  ChatSession,
  DatabaseState,
  ProjectData,
  ProjectKind,
  StudioStatus,
} from "./api-types.ts";

// Re-exported so `./api.ts` stays the one import for a pane that needs both
// the call and the shape it answers with.
export type {
  Account,
  AgentLogLine,
  AgentLogsPage,
  AuthConfig,
  ChatSession,
  DatabaseEnvironment,
  DatabaseEnvironmentName,
  DatabaseState,
  DatabaseUsage,
  ProjectData,
  ProjectKind,
  StudioStatus,
  TableListing,
  TablePage,
  TableSummary,
} from "./api-types.ts";

/**
 * Per-attempt deadline for the session broker call. A broker request issued
 * while the server is restarting can HANG rather than fail — the proxy holds
 * the socket, or the platform queues the request against a container that
 * never answers — and a browser fetch has no timeout of its own, so without
 * this the chat panel showed "Starting sandbox…" forever, long after the
 * server was back. Sized above the cold path's real work: a Modal sandbox
 * spawn, the guest dial (30s cap server-side), and the session install
 * (60s cap). A timed-out attempt is retried (see isTransientError);
 * the server keeps brokering after the abort, so the retry usually reuses
 * the sandbox the aborted attempt booted.
 */
export const CHAT_SESSION_ATTEMPT_TIMEOUT_MS = 120_000;

/**
 * Per-attempt deadline for one log poll.
 *
 * Short on purpose. The platform's own read is bounded well under this
 * (`LOGS_READY_TIMEOUT_MS` plus one manage request), so anything slower than
 * this is a stall rather than work in progress — and the pane polls, so
 * abandoning and re-asking a second later is strictly better than holding a
 * socket open for the default deadline.
 */
export const AGENT_LOGS_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Per-attempt deadline for the account read that gates the whole app.
 *
 * Same hazard as the broker call above, with a worse symptom: a request
 * issued while the server is restarting or saturated can HANG rather than
 * fail — the proxy holds the socket open — and a browser fetch has no
 * timeout of its own, so the studio sat on "Loading…" forever with no way
 * out but a reload. The deadline is also what makes a Try again button
 * possible at all rather than merely sooner: TanStack Query folds a
 * `refetch` into the in-flight promise, so while the fetch never settles the
 * button cannot start a new attempt.
 *
 * Sized well above the real work (verify the session token, read one row)
 * and well under a user's patience.
 */
export const ACCOUNT_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Per-attempt deadline for the public auth-config read, which runs before
 * anything is rendered. It hangs for the same reasons and strands the page
 * on an empty screen — a worse place to sit than the loading card, since
 * there is nothing on it to explain the wait.
 */
export const AUTH_CONFIG_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Per-attempt deadline for the Preview pane's agent-page probe. The same
 * hang as above, with a failure mode the others don't have: the probe is a
 * POLL that re-arms its timer from the SETTLED promise, so a request that
 * never settles doesn't miss one tick — it ends the loop, leaving the pane
 * on "Starting your preview" forever. Short, because a timeout already means
 * "not ready yet" (the rejection path), which is what re-arms the poll.
 */
export const AGENT_PAGE_PROBE_TIMEOUT_MS = 5000;

/**
 * The deadline every request carries unless it names its own.
 *
 * A browser `fetch` has NO timeout of its own, and a hung request is not a
 * failure — it never settles, so no error path, no retry and no backoff ever
 * runs. That is not a per-call hazard to remember at the four call sites that
 * happened to think of it: it is what `fetch` does, so it belongs in the one
 * place every request goes through. Four of ~18 requests carried a deadline,
 * and `GET /studio/status` — which gates the home hero's Send button AND the
 * project composer — was not one of them, so a single hung read left both
 * screens dead behind "Checking the server's chat status…" with no way out but
 * a reload.
 *
 * Sized well above the slowest thing a studio route does that is not already
 * deadlined explicitly (a deploy through the sandbox is the long one, and it
 * has {@link CHAT_SESSION_ATTEMPT_TIMEOUT_MS}'s reasoning applied to it below),
 * and well under a user's patience for a screen that says nothing.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Per-attempt deadline for `GET /studio/status`.
 *
 * It answers from memory (which LLM the chat runs on), so it is only ever slow
 * when the server is — and it is read before anything is submittable, so the
 * shortest useful deadline is the right one: a timed-out attempt is what lets
 * the query layer retry at all.
 */
export const STATUS_ATTEMPT_TIMEOUT_MS = 10_000;

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

export const api = {
  ...tableReads(request),

  /**
   * What a deployed agent says it is: its name, greeting, and whether its
   * front door is a voice session or a static page.
   *
   * Unauthenticated and cross-route by design — this is the agent's own public
   * endpoint, the same one a browser client reads before it dials, not a
   * studio route. Parsed with the SDK's schema rather than trusted: unknown
   * fields are stripped, so an agent deployed against an older SDK still
   * answers something this can read.
   */
  clientConfig: (base: string): Promise<ClientConfigResponse> =>
    fetchJson<unknown>(`${base}/${CLIENT_CONFIG_PATH}`).then((body) =>
      ClientConfigResponseSchema.parse(body),
    ),

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
    request<{ ok: true }>(key, `/projects/${encodeURIComponent(project)}`, {
      method: "DELETE",
    }),

  getProject: (key: string, project: string) =>
    request<ProjectData>(key, `/projects/${encodeURIComponent(project)}`),

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
    request<{ ok: true }>(key, `/projects/${encodeURIComponent(project)}/preview/wake`, {
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
    watchEventStream(key, `/studio/projects/${encodeURIComponent(project)}/events`, {
      onFrame: (frame) => {
        if (frame.event === "project") handlers.onData(JSON.parse(frame.data) as ProjectData);
        if (frame.event === "chat") handlers.onChat?.(JSON.parse(frame.data) as UIMessage[]);
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
        if (frame.event === "projects") handlers.onData(JSON.parse(frame.data) as string[]);
      },
      ...omitUndefined({ onOpen: handlers.onOpen }),
      onDown: handlers.onDown,
    }),

  writeFile: (key: string, project: string, path: string, content: string) =>
    request<{ ok: boolean }>(key, `/projects/${encodeURIComponent(project)}/file`, {
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
    request<ChatSession>(key, `/projects/${encodeURIComponent(project)}/session`, {
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
    request<{ messages: UIMessage[] }>(key, `/projects/${encodeURIComponent(project)}/chat`).then(
      (r) => r.messages,
    ),

  /**
   * Publish: the project's sandbox runs `aai deploy`; `output` is the CLI's
   * output (post it into the chat so the coding agent sees it).
   */
  deploy: (key: string, project: string) =>
    request<{ ok: true; slug: string; url: string; output: string }>(
      key,
      `/projects/${encodeURIComponent(project)}/deploy`,
      { method: "POST", body: "{}" },
    ),

  /**
   * The project's database (`ctx.db`) across both environments. A studio
   * route rather than the platform's per-slug `/:slug/storage`: a project is
   * two deployed agents, and the switch can be flipped before either exists
   * (see aai-studio-server/studio-database.ts).
   */
  getDatabase: (key: string, project: string) =>
    request<DatabaseState>(key, `/projects/${encodeURIComponent(project)}/database`),

  /** Provision the database for both environments. */
  enableDatabase: (key: string, project: string) =>
    request<DatabaseState>(key, `/projects/${encodeURIComponent(project)}/database`, {
      method: "POST",
      body: "{}",
    }),

  // The Database pane's two reads live in `api-tables.ts` and are spread in
  // below — same surface to a caller, and this file is at its length cap.

  /** Drop both environments' databases — and all their data. */
  disableDatabase: (key: string, project: string) =>
    request<DatabaseState>(key, `/projects/${encodeURIComponent(project)}/database`, {
      method: "DELETE",
    }),

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
    request<{ vars: string[]; pending?: string[] }>(
      key,
      `/projects/${encodeURIComponent(project)}/secret`,
    ).then((r) => ({ vars: r.vars, pending: r.pending ?? [] })),

  putSecrets: (key: string, project: string, updates: Record<string, string>) =>
    request<{ vars: string[] }>(key, `/projects/${encodeURIComponent(project)}/secret`, {
      method: "PUT",
      body: JSON.stringify(updates),
    }),

  deleteSecret: (key: string, project: string, name: string) =>
    request<{ vars: string[] }>(
      key,
      `/projects/${encodeURIComponent(project)}/secret/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
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
