// Copyright 2025 the AAI authors. MIT license.

import { getServerInfo } from "./_agent.ts";
import { runDelete } from "./_delete.ts";
import { log } from "./_ui.ts";

export async function runDeleteCommand(opts: { cwd: string; server?: string }): Promise<void> {
  const { cwd } = opts;
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, opts.server);

  log.step(`Deleting ${slug}`);
  await runDelete({ url: serverUrl, slug, apiKey });
  log.success(`Deleted ${serverUrl}/${slug}`);
}
