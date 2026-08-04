// Copyright 2025 the AAI authors. MIT license.
// REST helpers for the studio's project/file/deploy endpoints.

import type { UIMessage } from "ai";
import { parse } from "dotenv";

export type ProjectData = {
  files: Record<string, string>;
  /** Production slug — updated only by Publish. */
  deployedSlug?: string;
  /** Workspace has edits the production agent does not have yet. */
  unpublished?: boolean;
  /** Preview slug — auto-deployed after agent turns and editor saves. */
  previewSlug?: string;
  /** Changes on every successful preview deploy; the iframe's reload key. */
  previewVersion?: string;
  /** Workspace has edits the preview has not deployed yet. */
  previewStale?: boolean;
  /** CLI output of the last failed preview deploy. */
  previewError?: string;
};

/**
 * The project's coding-agent sandbox, brokered by the platform. `token` is
 * the sandbox chat surface's per-session bearer — the browser presents it
 * (never a long-lived credential) on the public tunnel URL.
 */
export type ChatSession = { url: string; token: string };

/** How the login screen should sign the user in (see GET /studio/auth). */
export type AuthConfig =
  | { mode: "supabase"; supabaseUrl: string; supabasePublishableKey: string }
  | { mode: "dev" }
  | { mode: "none" };

export type Account = { email?: string; hasKey: boolean };

export type StudioStatus = {
  llm: boolean;
  provider?: string;
  model?: string;
};

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Per-attempt deadline for the session broker call. A broker request issued
 * while the server is restarting can HANG rather than fail — the proxy holds
 * the socket, or the platform queues the request against a container that
 * never answers — and a browser fetch has no timeout of its own, so without
 * this the chat panel showed "Starting sandbox…" forever, long after the
 * server was back. Sized above the cold path's real work: a Modal sandbox
 * spawn, the guest dial (30s cap server-side), and the session install
 * (60s cap). A timed-out attempt is retried (see isTransientSessionError);
 * the server keeps brokering after the abort, so the retry usually reuses
 * the sandbox the aborted attempt booted.
 */
export const CHAT_SESSION_ATTEMPT_TIMEOUT_MS = 120_000;

/**
 * Should a failed chat-session broker attempt be retried? A 4xx is a real
 * answer from a live server (bad key, missing project) that retrying cannot
 * change — except 408/429, which are the transient kind. Everything else — a
 * rejected fetch (connection refused mid-restart), a timed-out attempt, a
 * 5xx — means the server or sandbox wasn't ready, so the query keeps
 * retrying with backoff and a chat opened during a restart connects once
 * the server is back instead of wedging on the first failure.
 */
export function isTransientSessionError(err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return err.status === 408 || err.status === 429;
  }
  return true;
}

/** A query/mutation error as displayable text; undefined when there is none. */
export function errorText(err: unknown): string | undefined {
  if (!err) return;
  return err instanceof Error ? err.message : String(err);
}

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
  const invalid = Symbol("invalid");
  const parsed: unknown = await res.json().catch(() => invalid);
  if (parsed === invalid) {
    throw new ApiError(res.status, "Server returned an invalid response");
  }
  return parsed as T;
}

/**
 * Split complete SSE frames off the front of `buffer`, returning the parsed
 * `project` payloads and the unconsumed remainder. Frames are blank-line
 * separated; each carries `event:` and `data:` lines. Only `project` frames
 * carry payloads (pings are keepalives).
 */
export function parseProjectFrames(buffer: string): { frames: ProjectData[]; rest: string } {
  const frames: ProjectData[] = [];
  let rest = buffer;
  for (;;) {
    const frameEnd = rest.search(/\r?\n\r?\n/);
    if (frameEnd === -1) break;
    const frame = rest.slice(0, frameEnd);
    rest = rest.slice(frameEnd).replace(/^\r?\n\r?\n/, "");
    const isProject = /^event: *project$/m.test(frame);
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (isProject && data) frames.push(JSON.parse(data) as ProjectData);
  }
  return { frames, rest };
}

/** Drain a project event stream, delivering each pushed payload. */
async function consumeProjectEvents(
  body: ReadableStream<Uint8Array>,
  onData: (data: ProjectData) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = parseProjectFrames(buffer);
    buffer = rest;
    for (const frame of frames) onData(frame);
  }
}

/**
 * Same-origin request against the platform's own agent routes (`/:slug/…`) —
 * the secrets panel talks to the exact routes `aai secret` uses.
 */
async function agentRequest<T>(key: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init.body != null && { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  return handleResponse<T>(res);
}

/** The same request, against the studio surface (`/studio/…`). */
function request<T>(key: string, path: string, init: RequestInit = {}): Promise<T> {
  return agentRequest<T>(key, `/studio${path}`, init);
}

export const api = {
  status: (): Promise<StudioStatus> =>
    fetch("/studio/status").then((res) => handleResponse<StudioStatus>(res)),

  /** Public: which login flow to render. */
  authConfig: (): Promise<AuthConfig> =>
    fetch("/studio/auth").then((res) => handleResponse<AuthConfig>(res)),

  /** Session-authed (works before an AssemblyAI key is stored). */
  getAccount: (key: string) => request<Account>(key, "/account"),

  /** Store the user's AssemblyAI API key — the one-time onboarding step. */
  putAccountKey: (key: string, apiKey: string) =>
    request<{ ok: true }>(key, "/account/key", {
      method: "PUT",
      body: JSON.stringify({ apiKey }),
    }),

  listProjects: (key: string) =>
    request<{ projects: string[] }>(key, "/projects").then((r) => r.projects),

  /**
   * Create a project. The server generates the name — a readable base
   * derived from the creating chat prompt plus a random suffix, v0-style
   * (`contact-form-x7k2mq`) — so names are minted in exactly one place,
   * shared with the CLI's slugless deploy path.
   */
  createProject: (key: string, opts: { prompt?: string }) =>
    request<{ name: string; files: Record<string, string> }>(key, "/projects", {
      method: "POST",
      body: JSON.stringify(opts.prompt ? { prompt: opts.prompt } : {}),
    }),

  /** Delete a project (its workspace and chat). Deployed agents stay live. */
  deleteProject: (key: string, project: string) =>
    request<{ ok: true }>(key, `/projects/${encodeURIComponent(project)}`, {
      method: "DELETE",
    }),

  getProject: (key: string, project: string) =>
    request<ProjectData>(key, `/projects/${encodeURIComponent(project)}`),

  /**
   * Subscribe to the project's live state (`GET …/events`, SSE): the server
   * pushes a full {@link ProjectData} whenever the workspace row changes —
   * fed by Supabase Realtime server-side — which is how a finished preview
   * deploy reaches the Preview pane. This replaced the polling loop.
   *
   * A fetch-streamed reader rather than EventSource because the studio
   * authenticates with a bearer header, which EventSource cannot send.
   * Returns an abort function; `onDown` fires when the stream ends or fails
   * (server restart, network) so the caller can resubscribe with backoff.
   */
  watchProject: (
    key: string,
    project: string,
    handlers: { onData: (data: ProjectData) => void; onDown: () => void },
  ): (() => void) => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/studio/projects/${encodeURIComponent(project)}/events`, {
          headers: { Authorization: `Bearer ${key}`, Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!(res.ok && res.body)) throw new ApiError(res.status, "Event stream unavailable");
        await consumeProjectEvents(res.body, handlers.onData);
      } catch {
        // Aborted (caller unsubscribed) or failed — the finally decides.
      } finally {
        if (!controller.signal.aborted) handlers.onDown();
      }
    })();
    return () => controller.abort();
  },

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
      // A hung broker request must eventually settle so the query layer can
      // retry it — see CHAT_SESSION_ATTEMPT_TIMEOUT_MS.
      signal: AbortSignal.timeout(CHAT_SESSION_ATTEMPT_TIMEOUT_MS),
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
    const res = await fetch(sessionUrl.replace(/\/chat$/, "/tools"), {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    const { tools } = await handleResponse<{ tools: { name: string; label: string }[] }>(res);
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

  // Deployed-agent secrets — the same platform routes `aai secret` uses.

  listSecrets: (key: string, slug: string) =>
    agentRequest<{ vars: string[] }>(key, `/${encodeURIComponent(slug)}/secret`).then(
      (r) => r.vars,
    ),

  putSecrets: (key: string, slug: string, updates: Record<string, string>) =>
    agentRequest<{ ok: true; keys: string[] }>(key, `/${encodeURIComponent(slug)}/secret`, {
      method: "PUT",
      body: JSON.stringify(updates),
    }),

  deleteSecret: (key: string, slug: string, name: string) =>
    agentRequest<{ ok: true }>(
      key,
      `/${encodeURIComponent(slug)}/secret/${encodeURIComponent(name)}`,
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
