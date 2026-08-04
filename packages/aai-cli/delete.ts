// Copyright 2025 the AAI authors. MIT license.

import { getServerInfo, resolveDeployTarget } from "./_agent.ts";
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

type DeleteData = { slug?: string; project?: string };

/**
 * Delete THE PROJECT. A studio-linked directory deletes its studio project
 * (`DELETE /studio/projects/:project`), which cascades server-side to the
 * workspace, chat, and the project's deployed + preview agents — the exact
 * delete the studio's own Delete button runs. A directory that only knows a
 * slug (no studio link) deletes that deployed agent directly.
 */
export async function executeDelete(opts: {
  cwd: string;
  server?: string | undefined;
}): Promise<CommandResult<DeleteData>> {
  const { cwd } = opts;
  const { config, serverUrl, apiKey } = await resolveDeployTarget(cwd, opts.server);

  if (config?.studioProject) {
    const project = config.studioProject;
    log.step(`Deleting studio project ${project} (and its deployed agents)`);
    await apiRequest(`${serverUrl}/studio/projects/${encodeURIComponent(project)}`, {
      method: "DELETE",
      apiKey,
      action: "delete",
      hints: { 404: "Run `aai list` to see your projects." },
    });
    log.success(`Deleted ${project}`);
    return ok({ project, ...(config.slug ? { slug: config.slug } : {}) });
  }

  const { slug } = await getServerInfo(cwd, opts.server);
  log.step(`Deleting ${slug}`);
  await runDelete({ url: serverUrl, slug, apiKey });
  log.success(`Deleted ${serverUrl}/${slug}`);
  return ok({ slug });
}
