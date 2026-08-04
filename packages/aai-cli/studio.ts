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

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveDeployTarget } from "./_agent.ts";
import { apiRequest } from "./_api-client.ts";
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
  studioProjectUrl,
} from "./_studio.ts";
import { layerScaffold } from "./_templates.ts";
import { fmtUrl, log } from "./_ui.ts";

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
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      throw new Error(`Pulled file path escapes the project directory: ${rel}`);
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
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
      "Run `aai list` to see your projects.",
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
    ...(remote.deployedSlug ? { slug: remote.deployedSlug } : {}),
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
    ...(slug ? { slug } : {}),
  });
  return {
    project,
    sourceHash: result.sourceHash,
    created: result.created,
    serverUrl,
    apiKey,
    slug,
  };
}

export async function executePush(opts: {
  cwd: string;
  server?: string | undefined;
  force?: boolean | undefined;
}): Promise<CommandResult<{ project: string; created: boolean; url: string }>> {
  const pushed = await pushProject(opts);
  const url = studioProjectUrl(pushed.serverUrl, pushed.project);
  log.success(
    `${pushed.created ? "Created" : "Synced"} studio project ${pushed.project} — ${fmtUrl(url)}`,
  );
  return ok({ project: pushed.project, created: pushed.created, url });
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
  slug: string,
): Promise<string[]> {
  const env = await resolveServerEnv(cwd);
  const names = Object.keys(env);
  if (names.length === 0) return [];
  await apiRequest(`${serverUrl}/${slug}/secret`, {
    apiKey,
    action: "secret",
    method: "PUT",
    body: env,
  });
  log.info(`Synced ${names.length} secret${names.length === 1 ? "" : "s"} from .env`);
  return names;
}

export async function executePublish(opts: {
  cwd: string;
  server?: string | undefined;
  force?: boolean | undefined;
  skipTypecheck?: boolean | undefined;
}): Promise<
  CommandResult<{ project: string; slug: string; url: string; studioUrl: string; output: string }>
> {
  if (!opts.skipTypecheck) {
    const { assertTypechecks } = await import("./_typecheck-gate.ts");
    await assertTypechecks(opts.cwd);
  }
  const pushed = await pushProject(opts);
  const { project, serverUrl, apiKey } = pushed;

  // Secrets merge into the agent env at deploy time — sync them first when
  // the slug already exists so this publish picks them up.
  const hadSlug = pushed.slug !== undefined;
  if (pushed.slug) await syncEnvSecrets(opts.cwd, serverUrl, apiKey, pushed.slug);

  log.step(`Publishing ${project} (builds in the project's sandbox)…`);
  const result = await publishStudioProject(serverUrl, apiKey, project);
  if (result.output.trim()) log.message(result.output.trim());

  await updateProjectConfig(opts.cwd, { serverUrl, slug: result.slug });
  // First publish: the slug didn't exist to attach secrets to until now.
  if (!hadSlug) {
    const synced = await syncEnvSecrets(opts.cwd, serverUrl, apiKey, result.slug);
    if (synced.length > 0) log.info("They apply on the next `aai publish`.");
  }

  const agentUrl = `${serverUrl}/${result.slug}`;
  const studioUrl = studioProjectUrl(serverUrl, project);
  log.success(`Published ${fmtUrl(agentUrl)}`);
  log.info(`Edit in studio: ${fmtUrl(studioUrl)}`);
  return ok({ project, slug: result.slug, url: agentUrl, studioUrl, output: result.output });
}
