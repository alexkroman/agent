// Copyright 2025 the AAI authors. MIT license.

import { apiError, apiRequest, HINT_INVALID_API_KEY } from "./api-client.ts";

export type DeleteOpts = {
  url: string;
  slug: string;
  apiKey: string;
  /** Optional fetch implementation for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export async function runDelete(opts: DeleteOpts): Promise<void> {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);

  const resp = await apiRequest(
    `${opts.url}/${opts.slug}`,
    { method: "DELETE", apiKey: opts.apiKey, action: "delete" },
    fetchFn,
  );

  if (resp.ok) return;

  const text = await resp.text();

  let hint: string | undefined;
  if (resp.status === 401) {
    hint = HINT_INVALID_API_KEY;
  } else if (resp.status === 404) {
    hint = "The agent may not be deployed. Check `.aai/project.json` for the correct slug.";
  }
  throw apiError("delete", resp.status, text, hint);
}
