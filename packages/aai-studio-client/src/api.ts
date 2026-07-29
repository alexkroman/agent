// Copyright 2025 the AAI authors. MIT license.
// REST helpers for the studio's project/file/deploy endpoints.

import { parse } from "dotenv";

export type ProjectData = {
  files: Record<string, string>;
  deployedSlug?: string;
  /** Workspace has edits the running agent does not have yet. */
  unpublished?: boolean;
};

export type StudioStatus = {
  llm: boolean;
  provider?: string;
  model?: string;
  /** Models the chat route accepts for `model` — the picker's options. */
  models?: string[];
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

export const api = {
  status: (): Promise<StudioStatus> =>
    fetch("/studio/status").then((res) => handleResponse<StudioStatus>(res)),

  listProjects: (key: string) =>
    request<{ projects: string[] }>(key, "/projects").then((r) => r.projects),

  createProject: (key: string, name: string) =>
    request<{ name: string; files: Record<string, string> }>(key, "/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  getProject: (key: string, project: string) =>
    request<ProjectData>(key, `/projects/${encodeURIComponent(project)}`),

  deleteProject: (key: string, project: string) =>
    request<{ ok: boolean }>(key, `/projects/${encodeURIComponent(project)}`, {
      method: "DELETE",
    }),

  writeFile: (key: string, project: string, path: string, content: string) =>
    request<{ ok: boolean }>(key, `/projects/${encodeURIComponent(project)}/file`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),

  deleteFile: (key: string, project: string, path: string) =>
    request<{ ok: boolean }>(
      key,
      `/projects/${encodeURIComponent(project)}/file?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),

  deploy: (key: string, project: string, env: Record<string, string>) =>
    request<{ ok: true; slug: string; url: string }>(
      key,
      `/projects/${encodeURIComponent(project)}/deploy`,
      { method: "POST", body: JSON.stringify({ env }) },
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
