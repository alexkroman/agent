// Copyright 2025 the AAI authors. MIT license.

import { getServerInfo } from "./_agent.ts";
import { runDelete } from "./_delete.ts";
import { type CommandResult, ok } from "./_output.ts";
import { log } from "./_ui.ts";

type DeleteData = { slug: string };

/** Execute delete and return structured result. */
export async function executeDelete(opts: {
  cwd: string;
  server?: string;
}): Promise<CommandResult<DeleteData>> {
  const { cwd } = opts;
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, opts.server);

  log.step(`Deleting ${slug}`);
  await runDelete({ url: serverUrl, slug, apiKey });
  log.success(`Deleted ${serverUrl}/${slug}`);

  return ok({ slug });
}

/** Human-mode entry point (called from cli.ts in human mode). */
export async function runDeleteCommand(opts: { cwd: string; server?: string }): Promise<void> {
  const result = await executeDelete(opts);
  if (!result.ok) {
    log.error(result.error);
    process.exit(1);
  }
}
