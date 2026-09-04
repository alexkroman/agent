// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio-workspace commands: `aai list`, `aai pull`, `aai push`,
 * `aai publish`.
 *
 * One model: a studio project's workspace and a local project directory are
 * the same file tree. `pull` materializes the workspace locally (completing
 * it into a runnable project with the scaffold), `push` replaces the
 * workspace with the local tree (fast-forward-checked, so studio edits are
 * never silently overwritten), and `publish` pushes then ships the
 * workspace to production through the studio's Publish route — the same
 * in-sandbox deploy the Publish button runs. There is no other path to
 * production.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord, omitUndefined, plural } from "@alexkroman1/aai/utils";
import { isPathInside } from "@alexkroman1/aai-runtime/internal";
import { resolveDeployTarget } from "./_agent.ts";
import { apiRequest, checkedResponse } from "./_api-client.ts";
import { updateProjectConfig } from "./_config.ts";
import { CliError, type CommandResult, ok } from "./_output.ts";
import { resolveServerEnv } from "./_server-common.ts";
import {
  collectSourceFiles,
  fetchStudioProject,
  listStudioProjects,
  projectNameFromDir,
  publishStudioProject,
  pushStudioSource,
  studioProjectApiUrl,
  studioProjectUrl,
} from "./_studio.ts";
import { layerScaffold } from "./_templates.ts";
import { fmtUrl, log } from "./_ui.ts";
import { formatCappedList } from "./_utils.ts";

export async function executeList(opts: {
  cwd: string;
  server?: string | undefined;
}): Promise<CommandResult<{ projects: string[] }>> {
  const { serverUrl, apiKey } = await resolveDeployTarget(opts.cwd, opts.server);
  const projects = await listStudioProjects(serverUrl, apiKey);
  if (projects.length === 0) {
    log.info("No studio projects yet. Push one with `aai push`, or create one in the studio.");
  }
  for (const name of projects) {
    log.message(`${name}  ${fmtUrl(studioProjectUrl(serverUrl, name))}`);
  }
  return ok({ projects });
}

/** Write a pulled file map under `dir`, refusing paths that escape it. */
async function materializeFiles(dir: string, files: Record<string, string>): Promise<void> {
  // Resolve and screen EVERY path before writing any: a pull that turns out to
  // contain an escaping path leaves nothing behind rather than a half-written
  // tree. The writes themselves are independent, so they run concurrently.
  const targets = Object.entries(files).map(([rel, content]) => {
    const abs = path.resolve(dir, rel);
    // `isPathInside`, not a third copy of the line: this was open-coded here and
    // in `aai-guest/studio-workspace-fs.ts`, and both copies were correct only
    // for an absolute, normalized, trailing-slash-free `dir` — a precondition
    // nothing stated, so a `dir` with a trailing separator refused every path in
    // the tree. `aai-runtime/internal` is a permitted import here; `aai-server`
    // and `aai-guest` are not.
    if (!isPathInside(dir, abs)) {
      throw new Error(`Pulled file path escapes the project directory: ${rel}`);
    }
    return { abs, content };
  });
  await Promise.all(
    targets.map(async ({ abs, content }) => {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    }),
  );
}

/**
 * The hint for a pull that found nothing, which is where the two causes have
 * to be told apart — and only the project LIST can do it. A typo has other
 * projects beside it; an empty list means this login sees no projects at all,
 * i.e. the CLI is authenticated as a different account than the browser the
 * project was created in (the account's key is what decides studio scope —
 * see `resolveBearer` server-side). Naming the visible projects is also the
 * answer to a typo, so the round trip pays for itself either way. Best
 * effort: the list is a second request on an already-failing path, and its
 * own failure must not replace the 404 the user needs to see.
 */
async function notFoundHint(serverUrl: string, apiKey: string): Promise<string> {
  const projects = await listStudioProjects(serverUrl, apiKey).catch(() => null);
  if (projects === null) return "Run `aai list` to see your projects.";
  if (projects.length === 0) {
    return (
      "This login has no studio projects at all. If yours are in the studio, the CLI is " +
      "linked to a different account — run `aai login` again, approve it in a browser " +
      "signed in to the account that owns the project, then `aai list`."
    );
  }
  return `Your projects: ${formatCappedList(projects)}.`;
}

export async function executePull(opts: {
  cwd: string;
  project: string;
  dir?: string | undefined;
  force?: boolean | undefined;
  server?: string | undefined;
}): Promise<CommandResult<{ project: string; dir: string; files: number }>> {
  const { serverUrl, apiKey } = await resolveDeployTarget(opts.cwd, opts.server);
  const remote = await fetchStudioProject(serverUrl, apiKey, opts.project);
  if (!remote) {
    throw new CliError(
      "not_found",
      `No studio project named "${opts.project}".`,
      await notFoundHint(serverUrl, apiKey),
    );
  }

  const target = path.resolve(opts.cwd, opts.dir ?? opts.project);
  const existing = await readdir(target).catch(() => []);
  if (existing.length > 0 && !opts.force) {
    throw new CliError(
      "dir_not_empty",
      `${target} is not empty.`,
      "Pull into a fresh directory, or pass --force to overwrite files in place.",
    );
  }

  await materializeFiles(target, remote.files);
  // The workspace stores source; the scaffold (package.json, tsconfig, …)
  // completes it into a runnable project — never overwriting a file the
  // workspace supplied, mirroring the guest's ensureProjectShape.
  await layerScaffold(target);
  await updateProjectConfig(target, {
    serverUrl,
    studioProject: opts.project,
    studioSourceHash: remote.sourceHash,
    ...omitUndefined({ slug: remote.deployedSlug }),
  });

  const count = Object.keys(remote.files).length;
  log.success(`Pulled ${opts.project} (${count} files) into ${target}`);
  log.info(`Next: cd ${opts.dir ?? opts.project} && pnpm install && aai dev`);
  log.info(`Studio: ${fmtUrl(studioProjectUrl(serverUrl, opts.project))}`);
  return ok({ project: opts.project, dir: target, files: count });
}

type PushOutcome = {
  project: string;
  sourceHash: string;
  created: boolean;
  serverUrl: string;
  apiKey: string;
  /** Deployed slug already recorded for this project, if any. */
  slug?: string | undefined;
  /**
   * Files the walk skipped (over the byte cap, past the file-count cap, or
   * not valid UTF-8). These are logged for a human, but `log.warn` is
   * silenced in JSON mode — and JSON mode is auto-detected on a pipe — so
   * they have to ride the result too or a scripted push reports plain
   * success while having replaced the workspace with a truncated tree.
   */
  warnings: string[];
};

/**
 * The shared push core: collect local source, resolve (or mint) the linked
 * project, sync atomically, record the new fast-forward token.
 */
async function pushProject(opts: {
  cwd: string;
  server?: string | undefined;
  force?: boolean | undefined;
}): Promise<PushOutcome> {
  const { config, serverUrl, apiKey } = await resolveDeployTarget(opts.cwd, opts.server);
  const { files, warnings } = await collectSourceFiles(opts.cwd);
  for (const warning of warnings) log.warn(warning);
  if (Object.keys(files).length === 0) {
    throw new Error("Nothing to push — this directory has no project files.");
  }
  // The worker entry imports `../agent.ts`, so a tree missing it cannot build.
  // `collectSourceFiles` DROPS a file that is over the byte cap or not UTF-8
  // and only WARNS — and `log.warn` is silenced in JSON mode — so an oversized
  // agent.ts left `push` reporting success and the server, handed a tree with
  // no entry, answered a confusing `No agent.ts found in the current directory`.
  // Fail here with the real reason. Scoped to a file that EXISTS on disk but
  // did not sync: a directory with genuinely no agent.ts is left to the
  // server's own check (it may be a sync-only push the studio completes).
  if (!files["agent.ts"] && existsSync(path.join(opts.cwd, "agent.ts"))) {
    const reason = warnings.find((w) => w.startsWith("agent.ts "));
    throw new CliError(
      "entry_not_synced",
      reason ?? "agent.ts exists locally but was not synced.",
      "The entry file must sync to deploy — reduce its size or fix its encoding.",
    );
  }

  let project = config?.studioProject;
  let baseHash = config?.studioSourceHash;
  let slug = config?.slug;
  if (!project) {
    // First push from this directory: link it. The deployed slug (an older
    // project.json) or the directory name names the project; a same-named
    // project already in the studio must be an explicit choice to overwrite.
    project = slug ?? projectNameFromDir(opts.cwd) ?? undefined;
    if (!project) {
      throw new Error(
        `Can't derive a project name from ${path.basename(opts.cwd)} — rename the directory or run \`aai pull <project>\` to link an existing one.`,
      );
    }
    const existing = await fetchStudioProject(serverUrl, apiKey, project);
    if (existing && !opts.force) {
      throw new CliError(
        "project_exists",
        `Your studio already has a project named "${project}".`,
        `Run \`aai pull ${project}\` to link this directory to it, or \`aai push --force\` to overwrite it.`,
      );
    }
    baseHash = existing?.sourceHash;
    slug ??= existing?.deployedSlug;
  }

  const result = await pushStudioSource(serverUrl, apiKey, project, {
    files,
    ...(opts.force ? {} : { baseHash }),
  });
  await updateProjectConfig(opts.cwd, {
    serverUrl,
    studioProject: project,
    studioSourceHash: result.sourceHash,
    ...omitUndefined({ slug }),
  });
  return {
    project,
    sourceHash: result.sourceHash,
    created: result.created,
    serverUrl,
    apiKey,
    slug,
    warnings,
  };
}

export async function executePush(opts: {
  cwd: string;
  server?: string | undefined;
  force?: boolean | undefined;
}): Promise<
  CommandResult<{ project: string; created: boolean; url: string; warnings?: string[] }>
> {
  const pushed = await pushProject(opts);
  const url = studioProjectUrl(pushed.serverUrl, pushed.project);
  log.success(
    `${pushed.created ? "Created" : "Synced"} studio project ${pushed.project} — ${fmtUrl(url)}`,
  );
  return ok({
    project: pushed.project,
    created: pushed.created,
    url,
    // Omitted when empty so a clean push's result stays exactly as before.
    ...(pushed.warnings.length > 0 ? { warnings: pushed.warnings } : {}),
  });
}

/**
 * Mirror `.env` into the deployed agent's secrets (the same `/:slug/secret`
 * routes `aai secret` uses). Secrets are merged into the agent env at
 * deploy time, which is why publish syncs them BEFORE deploying when the
 * slug is already known.
 */
async function syncEnvSecrets(
  cwd: string,
  serverUrl: string,
  apiKey: string,
  project: string,
): Promise<string[]> {
  const env = await resolveServerEnv(cwd);
  const names = Object.keys(env);
  if (names.length === 0) return [];
  // The PROJECT route, not the deployed slug's: a project has a preview agent
  // too — one this very command created — and a `.env` synced to production
  // alone leaves it failing at its first session. The server fans out.
  await apiRequest(`${studioProjectApiUrl(serverUrl, project)}/secret`, {
    apiKey,
    action: "secret",
    method: "PUT",
    body: env,
  });
  log.info(`Synced ${names.length} ${plural(names.length, "secret")} from .env`);
  return names;
}

export async function executePublish(opts: {
  cwd: string;
  server?: string | undefined;
  force?: boolean | undefined;
  skipTypecheck?: boolean | undefined;
}): Promise<
  CommandResult<{
    project: string;
    slug: string;
    url: string;
    studioUrl: string;
    output: string;
    warnings?: string[];
  }>
> {
  const { assertTypechecks } = await import("./_typecheck-gate.ts");
  await assertTypechecks(opts.cwd, { skip: opts.skipTypecheck });
  const pushed = await pushProject(opts);
  const { project, serverUrl, apiKey } = pushed;

  // Secrets merge into the agent env at deploy time — sync them first when
  // the slug already exists so this publish picks them up.
  if (pushed.slug) await syncEnvSecrets(opts.cwd, serverUrl, apiKey, project);

  log.step(`Publishing ${project} (builds in the project's sandbox)…`);
  // Wire data, so it is checked rather than trusted. A 200 whose body lacks
  // `slug`/`output` — an intercepting proxy, a mismatched server — used to
  // surface as a bare `Cannot read properties of undefined (reading 'trim')`,
  // and the missing slug was then written into .aai/project.json. This is the
  // incident `checkedResponse` is named after; the other four response shapes
  // now go through the same helper.
  const result = checkedResponse(
    await publishStudioProject(serverUrl, apiKey, project, {
      skipTypecheck: opts.skipTypecheck,
    }),
    (value): value is { slug: string; output: string } =>
      isRecord(value) && typeof value.slug === "string" && typeof value.output === "string",
    `the publish route at ${serverUrl}`,
  );
  if (result.output.trim()) log.message(result.output.trim());

  await updateProjectConfig(opts.cwd, { serverUrl, slug: result.slug });
  // First publish: the slug didn't exist to attach secrets to until now.
  // `pushed` is a const, so this reads the same value the branch above tested —
  // one predicate, one spelling. The two used to differ (`!== undefined` here,
  // truthiness there), which disagree on an empty slug.
  if (!pushed.slug) {
    const synced = await syncEnvSecrets(opts.cwd, serverUrl, apiKey, result.slug);
    if (synced.length > 0) log.info("They apply on the next `aai publish`.");
  }

  const agentUrl = `${serverUrl}/${result.slug}`;
  const studioUrl = studioProjectUrl(serverUrl, project);
  log.success(`Published ${fmtUrl(agentUrl)}`);
  log.info(`Edit in studio: ${fmtUrl(studioUrl)}`);
  return ok({
    project,
    slug: result.slug,
    url: agentUrl,
    studioUrl,
    output: result.output,
    // See PushOutcome.warnings — silenced in JSON mode, so they ride here.
    ...(pushed.warnings.length > 0 ? { warnings: pushed.warnings } : {}),
  });
}
