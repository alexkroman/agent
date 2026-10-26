// Copyright 2025 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { requireDeployedSlug } from "./_agent.ts";
import { type ApiTestSeam, apiRequest, apiTestSeam, HINT_NOT_DEPLOYED } from "./_api-client.ts";
import { writeProjectConfig } from "./_config.ts";
import { CliError, type CommandResult, ok } from "./_output.ts";
import { REAL_STUDIO_DEPS, type StudioDeps, studioProjectApiUrl } from "./_studio.ts";
import { defaultUi, type Ui } from "./_ui.ts";

export type DeleteOpts = ApiTestSeam & {
  url: string;
  slug: string;
  apiKey: string;
};

export async function runDelete(
  opts: DeleteOpts,
  request: typeof apiRequest = apiRequest,
): Promise<void> {
  await request(`${opts.url}/${opts.slug}`, {
    method: "DELETE",
    apiKey: opts.apiKey,
    action: "delete",
    hints: { 404: HINT_NOT_DEPLOYED },
    ...apiTestSeam(opts),
  });
}

type DeleteData = { slug?: string; project?: string; cancelled?: true };

/**
 * Whether the delete of `what` may go ahead: `--yes` says so outright; a human
 * at a terminal is ASKED, naming it; anything else — a script, a pipe, JSON
 * mode, which cannot spend its one result line on a prompt — is refused with
 * the flag that makes it explicit. It used to delete a project and every agent
 * deployed from it with no question at all, from a command whose name is one
 * typo away from others.
 */
async function confirmDelete(
  what: string,
  opts: { yes?: boolean | undefined; interactive?: boolean | undefined },
  ui: Ui,
): Promise<boolean> {
  if (opts.yes) return true;
  const interactive = opts.interactive ?? (Boolean(process.stdin.isTTY) && !ui.silenced);
  if (!interactive) {
    throw new CliError(
      "usage",
      `Refusing to delete ${what} without confirmation.`,
      "Pass --yes to delete without a prompt.",
    );
  }
  const answer = await ui.prompts.confirm({ message: `Delete ${what}? This cannot be undone.` });
  return answer === true;
}

/**
 * Delete THE PROJECT. A studio-linked directory deletes its studio project
 * (`DELETE /studio/projects/:project`), which cascades server-side to the
 * workspace, chat, and the project's deployed + preview agents — the exact
 * delete the studio's own Delete button runs. A directory that only knows a
 * slug (no studio link) deletes that deployed agent directly. Either way it
 * asks first — see {@link confirmDelete}.
 */
export async function executeDelete(
  opts: {
    cwd: string;
    server?: string | undefined;
    /** `--yes`: delete without asking. */
    yes?: boolean | undefined;
    /**
     * Whether a human can answer a prompt. Defaults to "stdin is a terminal
     * and output is not JSON"; a spec states it instead of faking the TTY.
     */
    interactive?: boolean | undefined;
  },
  ui: Ui = defaultUi,
  deps: StudioDeps = REAL_STUDIO_DEPS,
): Promise<CommandResult<DeleteData>> {
  const { cwd } = opts;
  const { config, serverUrl, apiKey } = await deps.resolveDeployTarget(cwd, opts.server);

  const project = config?.studioProject;
  // `requireDeployedSlug(config)`, not a second `getServerInfo` — that would
  // re-run `resolveDeployTarget` (config reads, `ensureApiKey`, and with
  // `--server` the cross-process config lock) for what is already in scope.
  const slug = project ? undefined : requireDeployedSlug(config);
  const what = project
    ? `studio project ${project} and all of its deployed agents`
    : `the deployed agent ${slug}`;
  if (!(await confirmDelete(what, opts, ui))) {
    ui.log.info("Cancelled — nothing was deleted.");
    return ok({ cancelled: true });
  }

  if (project) {
    ui.log.step(`Deleting studio project ${project} (and its deployed agents)`);
    await deps.apiRequest(studioProjectApiUrl(serverUrl, project), {
      method: "DELETE",
      apiKey,
      action: "delete",
      hints: { 404: "Run `aai list` to see your projects." },
    });
    ui.log.success(`Deleted ${project}`);
    // Drop the link fields: they now point at a project that no longer
    // exists. Left in place, the next `aai push`/`publish` took the
    // "already linked" branch and sent a `baseHash` for a missing project,
    // which the server answers 409 — hinting `aai pull`, which then fails
    // with "No studio project named <project>". Only `--force` recovered,
    // so the recovery advice was actively wrong. Cleared, the next publish
    // takes the first-push path and recreates the project. `serverUrl` is
    // kept deliberately: it is still where this directory should publish.
    await writeProjectConfig(cwd, { serverUrl });
    return ok({ project, ...omitUndefined({ slug: config?.slug }) });
  }

  if (slug === undefined) throw new Error("unreachable: no studio project and no slug");
  ui.log.step(`Deleting ${slug}`);
  await runDelete({ url: serverUrl, slug, apiKey }, deps.apiRequest);
  ui.log.success(`Deleted ${serverUrl}/${slug}`);
  return ok({ slug });
}
