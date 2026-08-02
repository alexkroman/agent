// Copyright 2025 the AAI authors. MIT license.
// REST helpers for the studio's project/file/deploy endpoints.

import type { UIMessage } from "ai";
import { parse } from "dotenv";

export type ProjectData = {
  files: Record<string, string>;
  deployedSlug?: string;
  /** Workspace has edits the running agent does not have yet. */
  unpublished?: boolean;
};

/** The project's coding-agent sandbox, brokered by the platform. */
export type ChatSession = { url: string };

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

async function request<T>(key: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/studio${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init.body != null && { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  return handleResponse<T>(res);
}

/**
 * Same-origin request against the platform's own agent routes (`/:slug/…`)
 * rather than the studio surface — the secrets panel talks to the exact
 * routes `aai secret` uses.
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

export const api = {
  status: (): Promise<StudioStatus> =>
    fetch("/studio/status").then((res) => handleResponse<StudioStatus>(res)),

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

  getProject: (key: string, project: string) =>
    request<ProjectData>(key, `/projects/${encodeURIComponent(project)}`),

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
    }),

  /** Tool name → user-friendly label, served by the sandbox itself. */
  sandboxToolLabels: async (key: string, sessionUrl: string): Promise<Record<string, string>> => {
    const res = await fetch(sessionUrl.replace(/\/chat$/, "/tools"), {
      headers: { Authorization: `Bearer ${key}` },
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
