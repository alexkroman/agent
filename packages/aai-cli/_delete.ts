// Copyright 2025 the AAI authors. MIT license.

import { apiRequestOrThrow } from "./_api-client.ts";

export type DeleteOpts = {
  url: string;
  slug: string;
  apiKey: string;
  /** Optional fetch implementation for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export async function runDelete(opts: DeleteOpts): Promise<void> {
  await apiRequestOrThrow(
    `${opts.url}/${opts.slug}`,
    { method: "DELETE", apiKey: opts.apiKey, action: "delete" },
    {
      hints: {
        404: "The agent may not be deployed. Check `.aai/project.json` for the correct slug.",
      },
      fetch: opts.fetch,
    },
  );
}
