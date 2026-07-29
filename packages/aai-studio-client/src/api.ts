// Copyright 2025 the AAI authors. MIT license.
// REST helpers for the studio's project/file/deploy endpoints.

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
  return (await res.json()) as T;
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

/** Parse "KEY=value" lines from the secrets textarea. */
export function parseSecrets(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // A commented-out secret must stay switched off, not come back as a key.
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const i = withoutExport.indexOf("=");
    if (i <= 0) continue;
    const key = withoutExport.slice(0, i).trim();
    // Only the first "=" splits: base64 and URLs routinely contain more.
    const value = withoutExport.slice(i + 1).trim();
    // Quoting a value is .env syntax, not part of the secret — people paste
    // straight from a .env file and would otherwise store the quotes.
    env[key] = unquote(value);
  }
  return env;
}

/** Strip one matching pair of surrounding single or double quotes. */
function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    (value.startsWith('"') || value.startsWith("'")) &&
    value.at(-1) === value[0];
  return quoted ? value.slice(1, -1) : value;
}
