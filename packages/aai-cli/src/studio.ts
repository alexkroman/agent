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
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isRecord, omitUndefined, plural } from "@alexkroman1/aai/utils";
import { IGNORED_WORKSPACE_DIRS, isLocalOnlyFile } from "@alexkroman1/aai/workspace-files";
import { isPathInside } from "@alexkroman1/aai-runtime/internal";
import type { resolveDeployTarget } from "./_agent.ts";
import { checkedResponse } from "./_api-client.ts";
import { updateProjectConfig } from "./_config.ts";
import { CliError, type CommandResult, ok } from "./_output.ts";
import { refuseUnsafeTarget, writeFileNoFollow } from "./_safe-write.ts";
import { resolveServerEnv } from "./_server-common.ts";
import {
  collectSourceFiles,
  fetchStudioProject,
  isSlugShaped,
  isUsableProjectName,
  listStudioProjects,
  projectNameFromDir,
  publishStudioProject,
  pushStudioSource,
  REAL_STUDIO_DEPS,
  type StudioDeps,
  studioProjectApiUrl,
  studioProjectUrl,
} from "./_studio.ts";
import { layerScaffold, refuseUnsafeScaffoldTargets } from "./_templates.ts";
import { defaultUi, fmtUrl, type Ui } from "./_ui.ts";
import { formatCappedList } from "./_utils.ts";

export async function executeList(
  opts: {
    cwd: string;
    server?: string | undefined;
  },
  ui: Ui = defaultUi,
  deps: StudioDeps = REAL_STUDIO_DEPS,
): Promise<CommandResult<{ projects: string[] }>> {
  const { serverUrl, apiKey } = await deps.resolveDeployTarget(opts.cwd, opts.server);
  const projects = await listStudioProjects(serverUrl, apiKey, deps.apiRequest);
  if (projects.length === 0) {
    ui.log.info("No studio projects yet. Push one with `aai push`, or create one in the studio.");
  }
  for (const name of projects) {
    ui.log.message(`${name}  ${fmtUrl(studioProjectUrl(serverUrl, name))}`);
  }
  return ok({ projects });
}

/** A refusal of the pulled map as a whole: nothing has been written yet. */
function unsafePull(rel: string, reason: string): CliError {
  return new CliError(
    "unsafe_pull",
    `The studio sent a file path aai pull will not write: ${JSON.stringify(rel)} (${reason}).`,
    "Nothing was written. Rename or delete that file in the studio, then pull again.",
  );
}

/** C0 controls, DEL and the C1 range — a NUL truncates a path at the syscall. */
const CONTROL_CHARS = /\p{Cc}/u;

/**
 * The paths a push would never have sent: inside a directory the walk does not
 * enter (`.git`, `.aai`, `node_modules`, …) or a local-only file (`.env`, a
 * lockfile). The rules are the push side's own (`IGNORED_WORKSPACE_DIRS` and
 * `isLocalOnlyFile`, which `collectSourceFiles` walks with), applied to the
 * other direction: a row holding `.git/config` with a `core.fsmonitor` made
 * the next `git status` run a command, and a row's `.aai/project.json`
 * survived the link write below it.
 */
function isNeverSyncedPath(segments: readonly string[]): boolean {
  const name = segments.at(-1) ?? "";
  return segments.slice(0, -1).some((s) => IGNORED_WORKSPACE_DIRS.has(s)) || isLocalOnlyFile(name);
}

/**
 * Screen a pulled file map as a WHOLE, before anything is written: a path that
 * is empty, carries a control character, has a `.`/`..`/empty segment, escapes
 * `dir`, or names a file that is also another path's parent directory refuses
 * the pull. Each of those used to fail midway, after `agent.ts` had already
 * landed, under a comment promising all-or-nothing. Paths a push would never
 * have sent are not errors — they are SKIPPED, and named in `skipped`.
 */
function planPull(
  dir: string,
  files: Record<string, string>,
): { writes: { rel: string; abs: string; content: string }[]; skipped: string[] } {
  const all = new Set(Object.keys(files));
  const writes: { rel: string; abs: string; content: string }[] = [];
  const skipped: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const { abs, segments } = screenPulledPath(dir, rel, all);
    if (isNeverSyncedPath(segments)) skipped.push(rel);
    else writes.push({ rel, abs, content });
  }
  return { writes, skipped };
}

/** One path of {@link planPull}: its resolved target and segments, or a refusal. */
function screenPulledPath(
  dir: string,
  rel: string,
  all: ReadonlySet<string>,
): { abs: string; segments: string[] } {
  if (rel === "") throw unsafePull(rel, "an empty path");
  if (CONTROL_CHARS.test(rel)) throw unsafePull(rel, "a control character");
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw unsafePull(rel, "an empty, `.` or `..` segment");
  }
  const abs = path.resolve(dir, rel);
  // `isPathInside`, not a third copy of the line: this was open-coded here and
  // in `aai-guest/studio-workspace-fs.ts`, and both copies were correct only
  // for an absolute, normalized, trailing-slash-free `dir` — a precondition
  // nothing stated, so a `dir` with a trailing separator refused every path in
  // the tree. `aai-runtime/internal` is a permitted import here; `aai-server`
  // and `aai-guest` are not.
  if (!isPathInside(dir, abs)) throw unsafePull(rel, "it escapes the project directory");
  for (let i = 1; i < segments.length; i++) {
    const parent = segments.slice(0, i).join("/");
    if (all.has(parent)) throw unsafePull(rel, `${parent} is also a file`);
  }
  return { abs, segments };
}

/**
 * Write a pulled file map under `dir`, refusing (before ANY write) a path
 * {@link planPull} rejects or one that would go through a symlink already on
 * disk, and skipping what push would never have sent. Returns the warnings.
 */
async function materializeFiles(dir: string, files: Record<string, string>): Promise<string[]> {
  const { writes, skipped } = planPull(dir, files);
  // Screen the disk as well as the names, and for EVERY path this pull will
  // write: a `--force` pull into a directory holding `agent.ts ->
  // ../outside/victim.txt` (or a symlinked subdirectory) wrote through the
  // link. The scaffold's paths and the link file are written later, by other
  // functions, so they are screened here too — refusing before the first write.
  await Promise.all([
    ...writes.map(({ rel }) => refuseUnsafeTarget(dir, rel)),
    refuseUnsafeTarget(dir, ".aai/project.json"),
    refuseUnsafeScaffoldTargets(dir),
  ]);
  // The writes are independent, so they run concurrently.
  await Promise.all(writes.map(({ abs, content }) => writeFileNoFollow(abs, content)));
  return skipped
    .sort((a, b) => a.localeCompare(b))
    .map((rel) => `${rel} is never synced (push does not send it either) — not written.`);
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
async function notFoundHint(serverUrl: string, apiKey: string, deps: StudioDeps): Promise<string> {
  const projects = await listStudioProjects(serverUrl, apiKey, deps.apiRequest).catch(() => null);
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

export async function executePull(
  opts: {
    cwd: string;
    project: string;
    dir?: string | undefined;
    force?: boolean | undefined;
    server?: string | undefined;
  },
  ui: Ui = defaultUi,
  deps: StudioDeps = REAL_STUDIO_DEPS,
): Promise<CommandResult<{ project: string; dir: string; files: number; warnings?: string[] }>> {
  // The name is written into `.aai/project.json` as the link, so it is held to
  // the slug grammar every studio project name already satisfies.
  if (!isSlugShaped(opts.project)) {
    throw new CliError(
      "invalid_project",
      `${JSON.stringify(opts.project)} is not a studio project name.`,
      "Run `aai list` to see your projects.",
    );
  }
  const { serverUrl, apiKey } = await deps.resolveDeployTarget(opts.cwd, opts.server);
  const remote = await fetchStudioProject(serverUrl, apiKey, opts.project, deps.apiRequest);
  if (!remote) {
    throw new CliError(
      "not_found",
      `No studio project named "${opts.project}".`,
      await notFoundHint(serverUrl, apiKey, deps),
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

  const warnings = await materializeFiles(target, remote.files);
  for (const warning of warnings) ui.log.warn(warning);
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

  const count = Object.keys(remote.files).length - warnings.length;
  ui.log.success(`Pulled ${opts.project} (${count} files) into ${target}`);
  ui.log.info(`Next: cd ${opts.dir ?? opts.project} && pnpm install && aai dev`);
  ui.log.info(`Studio: ${fmtUrl(studioProjectUrl(serverUrl, opts.project))}`);
  return ok({
    project: opts.project,
    dir: target,
    files: count,
    // See PushOutcome.warnings — silenced in JSON mode, so they ride here.
    ...(warnings.length > 0 ? { warnings } : {}),
  });
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
 * A project name read from `.aai/project.json` arrives with the working tree —
 * a cloned repo can carry one — so it passes the rule a directory name does.
 */
function refuseUnusableRecordedName(recorded: string | undefined): void {
  if (recorded === undefined || isUsableProjectName(recorded)) return;
  throw new CliError(
    "invalid_project",
    `.aai/project.json names the studio project ${JSON.stringify(recorded)}, which is not a usable project name.`,
    'Fix or delete .aai/project.json (a name ending in "-preview" belongs to the studio\'s preview agents), or run `aai pull <project>` to link an existing one.',
  );
}

/**
 * The worker entry imports `../agent.ts`, so a tree missing it cannot build.
 * `collectSourceFiles` DROPS a file that is over the byte cap or not UTF-8
 * and only WARNS — and `log.warn` is silenced in JSON mode — so an oversized
 * agent.ts left `push` reporting success and the server, handed a tree with
 * no entry, answered a confusing `No agent.ts found in the current directory`.
 * Fail here with the real reason. Scoped to a file that EXISTS on disk but
 * did not sync: a directory with genuinely no agent.ts is left to the
 * server's own check (it may be a sync-only push the studio completes).
 */
function refuseUnsyncedEntry(
  cwd: string,
  files: Record<string, string>,
  warnings: readonly string[],
): void {
  if (files["agent.ts"] || !existsSync(path.join(cwd, "agent.ts"))) return;
  const reason = warnings.find((w) => w.startsWith("agent.ts "));
  throw new CliError(
    "entry_not_synced",
    reason ?? "agent.ts exists locally but was not synced.",
    "The entry file must sync to deploy — reduce its size or fix its encoding.",
  );
}

/** What `resolveDeployTarget` answers: the project config, server and key. */
type DeployTarget = Awaited<ReturnType<typeof resolveDeployTarget>>;

/**
 * The shared push core: collect local source, resolve (or mint) the linked
 * project, sync atomically, record the new fast-forward token.
 */
async function pushProject(
  opts: {
    cwd: string;
    server?: string | undefined;
    force?: boolean | undefined;
  },
  ui: Ui,
  deps: StudioDeps,
  /** Already resolved by the caller (`publish` resolves it before typechecking). */
  target?: DeployTarget,
): Promise<PushOutcome> {
  const { config, serverUrl, apiKey } =
    target ?? (await deps.resolveDeployTarget(opts.cwd, opts.server));
  const { files, warnings } = await collectSourceFiles(opts.cwd);
  for (const warning of warnings) ui.log.warn(warning);
  if (Object.keys(files).length === 0) {
    throw new Error("Nothing to push — this directory has no project files.");
  }
  refuseUnsyncedEntry(opts.cwd, files, warnings);

  let project = config?.studioProject;
  let baseHash = config?.studioSourceHash;
  let slug = config?.slug;
  refuseUnusableRecordedName(project ?? slug);
  // The existence probe runs whenever there is no fast-forward token, LINKED
  // or not. A `studioProject` with no `studioSourceHash` is exactly what a
  // repo can ship in `.aai/project.json`, and it used to skip the probe and
  // PUT with no `baseHash` — an unconditional overwrite of whatever project
  // that name already held.
  if (!(project && baseHash)) {
    // First push from this directory: link it. The deployed slug (an older
    // project.json) or the directory name names the project; a same-named
    // project already in the studio must be an explicit choice to overwrite.
    project = project ?? slug ?? projectNameFromDir(opts.cwd) ?? undefined;
    if (!project) {
      throw new Error(
        `Can't derive a project name from ${path.basename(opts.cwd)} — rename the directory or run \`aai pull <project>\` to link an existing one.`,
      );
    }
    const existing = await fetchStudioProject(serverUrl, apiKey, project, deps.apiRequest);
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

  const result = await pushStudioSource(
    serverUrl,
    apiKey,
    project,
    {
      files,
      // `--force` overwrites, so it sends no fast-forward token at all.
      ...omitUndefined({ baseHash: opts.force ? undefined : baseHash }),
    },
    deps.apiRequest,
  );
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

export async function executePush(
  opts: {
    cwd: string;
    server?: string | undefined;
    force?: boolean | undefined;
  },
  ui: Ui = defaultUi,
  deps: StudioDeps = REAL_STUDIO_DEPS,
): Promise<CommandResult<{ project: string; created: boolean; url: string; warnings?: string[] }>> {
  const pushed = await pushProject(opts, ui, deps);
  const url = studioProjectUrl(pushed.serverUrl, pushed.project);
  ui.log.success(
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
 * Mirror `.env` into the project's secrets, which is what makes this callable
 * BEFORE anything has been deployed.
 *
 * The route is the PROJECT's (`/studio/projects/:project/secret`), and that is
 * the whole reason publish syncs unconditionally rather than only once a slug
 * exists. A project holds its own secret record — `studio-secrets.ts` argues
 * it, and the argument is exactly this failure: writing only to the slugs that
 * exist forces "deploy it broken, then attach the key, then deploy again",
 * which was the shortest path to a working agent and is not an order anybody
 * should have to learn. `reconcileProjectSecrets` is wired as the broker's
 * post-deploy hook and FLOORS a newly minted slug from that record, so the
 * deploy this call precedes picks the values up as it claims its slug — and
 * the preview agent, auto-deployed on the first edit, gets them too.
 *
 * Only the project row has to exist, and `pushProject` has already created it:
 * server-side, a project with nothing deployed resolves to an empty target set
 * and the record write is the whole operation.
 */
async function syncEnvSecrets(
  cwd: string,
  serverUrl: string,
  apiKey: string,
  project: string,
  ui: Ui,
  request: StudioDeps["apiRequest"],
): Promise<string[]> {
  const env = await resolveServerEnv(cwd);
  const names = Object.keys(env);
  if (names.length === 0) return [];
  // The PROJECT route, not the deployed slug's: a project has a preview agent
  // too — one this very command created — and a `.env` synced to production
  // alone leaves it failing at its first session. The server fans out over the
  // slugs that exist and records the rest against the project.
  await request(`${studioProjectApiUrl(serverUrl, project)}/secret`, {
    apiKey,
    action: "secret",
    method: "PUT",
    body: env,
  });
  ui.log.info(`Synced ${names.length} ${plural(names.length, "secret")} from .env`);
  return names;
}

export async function executePublish(
  opts: {
    cwd: string;
    server?: string | undefined;
    force?: boolean | undefined;
    skipTypecheck?: boolean | undefined;
  },
  ui: Ui = defaultUi,
  deps: StudioDeps = REAL_STUDIO_DEPS,
): Promise<
  CommandResult<{
    project: string;
    slug: string;
    url: string;
    studioUrl: string;
    output: string;
    warnings?: string[];
  }>
> {
  // Target FIRST, typecheck second. The gate runs the project's own
  // `node_modules` tsc — project code — so an untrusted `serverUrl` in a cloned
  // repo's `.aai/project.json`, or a missing login, must fail before it runs,
  // not after.
  const target = await deps.resolveDeployTarget(opts.cwd, opts.server);
  const { assertTypechecks } = await import("./_typecheck-gate.ts");
  await assertTypechecks(opts.cwd, { skip: opts.skipTypecheck, ui });
  const pushed = await pushProject(opts, ui, deps, target);
  const { project, serverUrl, apiKey } = pushed;

  // ALWAYS before the deploy, first publish included. Secrets are merged into
  // the agent env when the sandbox is BUILT, so anything synced afterwards
  // reaches nothing until the next publish — and the gate here used to be
  // `if (pushed.slug)`, i.e. "has this project ever been deployed", so every
  // brand-new agent's first deployment ran without its credentials and the
  // docs told the user to publish twice. `syncEnvSecrets` writes to the
  // project route, which needs only the row `pushProject` just created.
  await syncEnvSecrets(opts.cwd, serverUrl, apiKey, project, ui, deps.apiRequest);

  ui.log.step(`Publishing ${project} (builds in the project's sandbox)…`);
  // Wire data, so it is checked rather than trusted. A 200 whose body lacks
  // `slug`/`output` — an intercepting proxy, a mismatched server — used to
  // surface as a bare `Cannot read properties of undefined (reading 'trim')`,
  // and the missing slug was then written into .aai/project.json. This is the
  // incident `checkedResponse` is named after; the other four response shapes
  // now go through the same helper.
  const result = checkedResponse(
    await publishStudioProject(
      serverUrl,
      apiKey,
      project,
      { skipTypecheck: opts.skipTypecheck },
      deps.apiRequest,
    ),
    // `slug` slug-SHAPED, not merely a string: it is written into
    // .aai/project.json and joined into later request URLs, and a returned
    // `../../admin` was persisted verbatim.
    (value): value is { slug: string; output: string } =>
      isRecord(value) && isSlugShaped(value.slug) && typeof value.output === "string",
    `the publish route at ${serverUrl}`,
  );
  if (result.output.trim()) ui.log.message(result.output.trim());

  await updateProjectConfig(opts.cwd, { serverUrl, slug: result.slug });
  // No post-deploy re-sync. It used to run on a first publish, against
  // `result.slug` rather than the project — the asymmetry that made the
  // pre-deploy call look slug-dependent when it never was — and its own log
  // line ("They apply on the next `aai publish`") was the tell: a sync that
  // has to be followed by a second deploy is not a sync, it is a workaround
  // for the gate above.

  const agentUrl = `${serverUrl}/${result.slug}`;
  const studioUrl = studioProjectUrl(serverUrl, project);
  ui.log.success(`Published ${fmtUrl(agentUrl)}`);
  ui.log.info(`Edit in studio: ${fmtUrl(studioUrl)}`);
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
