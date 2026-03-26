// Copyright 2025 the AAI authors. MIT license.

import { getServerInfo } from "./_discover.ts";
import { runCommand, step } from "./_ui.ts";
import { runUndeploy } from "./_undeploy.ts";

export async function runUndeployCommand(opts: { cwd: string; server?: string }): Promise<void> {
  const { cwd } = opts;
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, opts.server);

  await runCommand(async ({ log }) => {
    log(step("Undeploy", slug));
    await runUndeploy({ url: serverUrl, slug, apiKey });
    log(step("Removed", `${serverUrl}/${slug}`));
  });
}
