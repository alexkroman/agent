// Copyright 2025 the AAI authors. MIT license.

import { getServerInfo } from "./_agent.ts";
import { apiRequest, HINT_NOT_DEPLOYED } from "./_api-client.ts";
import { type CommandResult, ok } from "./_output.ts";
import { log } from "./_ui.ts";

export type DeleteOpts = {
  url: string;
  slug: string;
  apiKey: string;
  /** Optional fetch implementation for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export async function runDelete(opts: DeleteOpts): Promise<void> {
  await apiRequest(`${opts.url}/${opts.slug}`, {
    method: "DELETE",
    apiKey: opts.apiKey,
    action: "delete",
    hints: { 404: HINT_NOT_DEPLOYED },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

type DeleteData = { slug: string };

/** Execute delete and return structured result. */
export async function executeDelete(opts: {
  cwd: string;
  server?: string | undefined;
}): Promise<CommandResult<DeleteData>> {
  const { cwd } = opts;
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, opts.server);

  log.step(`Deleting ${slug}`);
  await runDelete({ url: serverUrl, slug, apiKey });
  log.success(`Deleted ${serverUrl}/${slug}`);

  return ok({ slug });
}
