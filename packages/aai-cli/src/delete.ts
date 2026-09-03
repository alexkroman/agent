// Copyright 2025 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { requireDeployedSlug, resolveDeployTarget } from "./_agent.ts";
import { type ApiTestSeam, apiRequest, apiTestSeam, HINT_NOT_DEPLOYED } from "./_api-client.ts";
import { writeProjectConfig } from "./_config.ts";
import { type CommandResult, ok } from "./_output.ts";
import { studioProjectApiUrl } from "./_studio.ts";
import { log } from "./_ui.ts";

export type DeleteOpts = ApiTestSeam & {
  url: string;
  slug: string;
  apiKey: string;
};

export async function runDelete(opts: DeleteOpts): Promise<void> {
  await apiRequest(`${opts.url}/${opts.slug}`, {
    method: "DELETE",
    apiKey: opts.apiKey,
    action: "delete",
    hints: { 404: HINT_NOT_DEPLOYED },
    ...apiTestSeam(opts),
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
    await apiRequest(studioProjectApiUrl(serverUrl, project), {
      method: "DELETE",
      apiKey,
      action: "delete",
      hints: { 404: "Run `aai list` to see your projects." },
    });
    log.success(`Deleted ${project}`);
    // Drop the link fields: they now point at a project that no longer
    // exists. Left in place, the next `aai push`/`publish` took the
    // "already linked" branch and sent a `baseHash` for a missing project,
    // which the server answers 409 — hinting `aai pull`, which then fails
    // with "No studio project named <project>". Only `--force` recovered,
    // so the recovery advice was actively wrong. Cleared, the next publish
    // takes the first-push path and recreates the project. `serverUrl` is
    // kept deliberately: it is still where this directory should publish.
    await writeProjectConfig(cwd, { serverUrl });
    return ok({ project, ...omitUndefined({ slug: config.slug }) });
  }

  // `requireDeployedSlug(config)`, not a second `getServerInfo` — that call
  // re-ran `resolveDeployTarget`, i.e. a second project-config read, a second
  // global-config read, a second `ensureApiKey`, and (with `--server`) a second
  // `approveServer`, which takes the cross-process config lock. Everything it
  // would have returned is already in scope.
  const slug = requireDeployedSlug(config);
  log.step(`Deleting ${slug}`);
  await runDelete({ url: serverUrl, slug, apiKey });
  log.success(`Deleted ${serverUrl}/${slug}`);
  return ok({ slug });
}
