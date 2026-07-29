// Copyright 2025 the AAI authors. MIT license.
// REST helpers for the studio's project/file/deploy endpoints.

export type ProjectData = {
  files: Record<string, string>;
  deployedSlug?: string;
};

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

async function request<T>(key: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/studio${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init.body != null && { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
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
  return (await res.json()) as T;
}

export const api = {
  status: (): Promise<StudioStatus> =>
    fetch("/studio/status").then((r) => r.json() as Promise<StudioStatus>),

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

/** Parse "KEY=value" lines from the secrets textarea. */
export function parseSecrets(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}
