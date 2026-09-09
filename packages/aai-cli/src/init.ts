// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { styleText } from "node:util";
import * as p from "@clack/prompts";
import { execa } from "execa";
import { getMonorepoRoot, isDevMode } from "./_agent.ts";
import {
  PACKAGE_MANAGERS,
  type PackageManager,
  type PackageManagerInfo,
  runInit,
} from "./_init.ts";
import { type CommandResult, ok } from "./_output.ts";
import { listTemplates } from "./_templates.ts";
import { log, unwrapCancel } from "./_ui.ts";
import { AGENT_ENTRY, errorMessage, fileExists, readJson, resolveCwd } from "./_utils.ts";

type InitData = {
  dir: string;
  template: string;
  /**
   * Diagnostics a human sees as `log.warn` lines — today only a failed
   * dependency install.
   *
   * They have to ride the result for the same reason `PushOutcome.warnings`
   * does — `log.warn` is silenced in JSON mode and JSON mode is AUTO-DETECTED
   * on a pipe, so a scripted `aai init` was told `{ ok: true }` for a project
   * whose dependencies never installed and could not tell that apart from a
   * clean run.
   */
  warnings?: string[];
};

/**
 * Run `fn` behind a clack spinner, stopping it in EVERY outcome.
 *
 * The naked form (`s?.start(); await work(); s?.stop()`) leaks the spinner on a
 * failure: clack keeps its interval and its raw-mode stdin hook, so a throw
 * left a spinner ticking under the error message with the cursor hidden. The
 * `catch` label is what the terminal is left showing, so it names the step.
 */
async function withSpinner<T>(
  silent: boolean | undefined,
  labels: { start: string; done: string; failed: string },
  fn: () => Promise<T>,
): Promise<T> {
  const s = silent ? undefined : p.spinner();
  s?.start(labels.start);
  // Not named `ok` — that is the result constructor this module imports.
  let succeeded = false;
  try {
    const value = await fn();
    succeeded = true;
    return value;
  } finally {
    s?.stop(succeeded ? labels.done : labels.failed);
  }
}

const DEFAULT_PROJECT_NAME = "my-voice-agent";

/** Prompt for project name or return default when --yes is set. */
async function promptProjectName(yes?: boolean): Promise<string> {
  if (yes) return DEFAULT_PROJECT_NAME;
  const result = unwrapCancel(
    await p.text({
      message: "What is your project named?",
      placeholder: DEFAULT_PROJECT_NAME,
      defaultValue: DEFAULT_PROJECT_NAME,
    }),
    "Setup cancelled",
  );
  return result || DEFAULT_PROJECT_NAME;
}

/**
 * The template a non-interactive `init` gets, and the entry the selector opens
 * on — so an author who just presses Enter lands where they used to.
 */
const DEFAULT_TEMPLATE = "quickstart-agent";

/**
 * Ask which template to scaffold, listing what this CLI actually ships.
 *
 * The options are derived from {@link listTemplates} rather than a roster kept
 * here: that function already backs `aai templates` AND the unknown-template
 * error, so a template added to the package shows up in the picker with no
 * second list to update. {@link DEFAULT_TEMPLATE} is hoisted to the top and
 * pre-selected, which is what keeps a bare `aai init` a single Enter away from
 * the project it produced before there was a picker.
 *
 * Callers must not reach here when there is nobody to answer — `--yes` and
 * JSON mode (auto-detected on a pipe) resolve the default without prompting.
 */
export async function promptTemplate(
  list: () => Promise<string[]> = listTemplates,
): Promise<string> {
  const [first, ...rest] = await list();
  // An empty list means a broken install, whose error belongs to
  // downloadAndMergeTemplate; one template is not a choice. Neither is a prompt.
  if (first === undefined) return DEFAULT_TEMPLATE;
  if (rest.length === 0) return first;
  const names = [first, ...rest];
  const hasDefault = names.includes(DEFAULT_TEMPLATE);
  const ordered = hasDefault
    ? [DEFAULT_TEMPLATE, ...names.filter((name) => name !== DEFAULT_TEMPLATE)]
    : names;
  return unwrapCancel(
    await p.select({
      message: "Which template?",
      // `maxItems` scrolls rather than printing all of them: the list is over
      // two dozen entries and a full dump pushes the intro off the screen.
      maxItems: 12,
      initialValue: hasDefault ? DEFAULT_TEMPLATE : first,
      // Two literals rather than one with an optional `hint`: `Option.hint` is
      // optional under `exactOptionalPropertyTypes`, so a present-and-undefined
      // field is not assignable to it.
      options: ordered.map((name) =>
        name === DEFAULT_TEMPLATE
          ? { value: name, hint: "the default starting point" }
          : { value: name },
      ),
    }),
    "Setup cancelled",
  );
}

/** Check if the project has any dependencies to install. */
async function hasDeps(cwd: string): Promise<boolean> {
  if (await fileExists(path.join(cwd, "node_modules"))) return false;
  const pkgJson = ((await readJson(path.join(cwd, "package.json"))) ?? {}) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = Object.keys(pkgJson.dependencies ?? {});
  const devDeps = Object.keys(pkgJson.devDependencies ?? {});
  return deps.length > 0 || devDeps.length > 0;
}

/**
 * A version string fit for the manifest's `packageManager` field.
 *
 * That field takes `name@version` and corepack REFUSES a value it cannot parse,
 * so anything a `--version` probe prints that is not a plain version (a banner,
 * a warning line, `?`) must produce no pin rather than an unusable one.
 */
const VERSION_RE = /^\d+\.\d+\.\d+\S*$/;

/** The first token of an `npm_config_user_agent`: `pnpm/10.29.3 npm/? node/v24…`. */
const USER_AGENT_HEAD = /^([a-z]+)\/(\S+)/;

function isPackageManager(name: string | undefined): name is PackageManager {
  return PACKAGE_MANAGERS.includes(name as PackageManager);
}

/**
 * The manager that INVOKED this process, from `npm_config_user_agent`.
 *
 * Every one of the four sets it when it runs a binary or a script, so this is
 * the strongest signal available and it is checked first: a user who followed
 * the documented `npm i -g @alexkroman1/aai-cli` and then ran `npx aai init`
 * has said which manager they use, and the old code installed with pnpm
 * regardless. An unrecognized head (`deno/…`, nothing at all) falls through to
 * the PATH probe rather than guessing.
 */
export function packageManagerFromUserAgent(
  ua: string | undefined = process.env.npm_config_user_agent,
): PackageManagerInfo | undefined {
  const match = USER_AGENT_HEAD.exec(ua?.trim() ?? "");
  const name = match?.[1];
  if (!isPackageManager(name)) return undefined;
  const version = match?.[2];
  return version !== undefined && VERSION_RE.test(version) ? { name, version } : { name };
}

/**
 * A manager's own version, or `undefined` when it is not on PATH at all.
 *
 * An empty string means "present, but it did not print a version I can pin" —
 * the two outcomes have to stay distinguishable, because the first decides
 * which manager RUNS and the second only decides whether the manifest gets a
 * `packageManager` pin.
 */
async function binVersion(cmd: string): Promise<string | undefined> {
  // `reject: false` covers a non-zero exit and a missing binary, and the
  // `catch` covers everything left — this probe runs BEFORE the scaffold, so a
  // throw here would fail `aai init` outright rather than fall back to the next
  // manager, which is a worse outcome than any answer it could give.
  const result = await execa(cmd, ["--version"], { reject: false }).catch(() => undefined);
  const { failed, stdout } = result ?? { failed: true, stdout: "" };
  if (failed) return undefined;
  const first = String(stdout ?? "")
    .trim()
    .split("\n", 1)[0]
    ?.trim();
  return first !== undefined && VERSION_RE.test(first) ? first : "";
}

/**
 * Which package manager `aai init` installs with.
 *
 * It used to be pnpm, unconditionally, reached through `corepack enable` — and
 * corepack is absent from Node >= 25, half the range the scaffold's `engines`
 * allow, so on a current Node the documented install path (`npm i -g
 * @alexkroman1/aai-cli`) produced a scaffold whose install step needed a
 * manager the user had never been asked to have. The generated README then said
 * `npm install` beside the pnpm lockfile.
 *
 * Two signals, in order, and pnpm stays the preference in the second: the
 * manager that invoked us, then the first of {@link PACKAGE_MANAGERS} that is
 * really on PATH. npm is the last resort because every Node install ships one,
 * so the install command is at worst attempted rather than skipped.
 *
 * Note what this does NOT do: enable corepack, or install a manager. Running
 * only something that answered `--version` is what makes the corepack call
 * unnecessary, and it is the whole reason this function exists.
 */
export async function detectPackageManager(
  ua: string | undefined = process.env.npm_config_user_agent,
  // Injectable for tests, which must not depend on what is installed on the
  // machine running them — and, under vitest, `npm_config_user_agent` is set by
  // whatever ran the suite.
  probe: (name: PackageManager) => Promise<string | undefined> = binVersion,
): Promise<PackageManagerInfo> {
  const declared = packageManagerFromUserAgent(ua);
  if (declared) return declared;
  for (const name of PACKAGE_MANAGERS) {
    const version = await probe(name);
    if (version === undefined) continue;
    return version ? { name, version } : { name };
  }
  return { name: "npm" };
}

/** Check whether the safe-chain binary is on PATH. */
async function hasSafeChain(): Promise<boolean> {
  const { failed } = await execa("safe-chain", ["--version"], { reject: false });
  return !failed;
}

/**
 * Build the command + args that install `pm`'s dependencies.
 *
 * The safe-chain routing is pnpm-only and stays that way: it is what this repo
 * installs with, `--safe-chain-skip-minimum-package-age` exists because the
 * scaffold pins freshly published `@alexkroman1/*` versions, and safe-chain's
 * other wrappers are not what anything here was verified against. npm has no
 * such quarantine to skip, so nothing is lost on that path.
 */
export async function resolveInstallCommand(
  pm: PackageManager,
  checkSafeChain: () => Promise<boolean> = hasSafeChain,
): Promise<{ cmd: string; args: string[] }> {
  if (pm !== "pnpm") return { cmd: pm, args: [] };
  if (await checkSafeChain()) {
    return { cmd: "safe-chain", args: ["pnpm", "--safe-chain-skip-minimum-package-age"] };
  }
  return { cmd: "pnpm", args: [] };
}

/** Run the install and warn on failure. */
async function runInstall(cwd: string, pm: PackageManager): Promise<void> {
  const { cmd, args } = await resolveInstallCommand(pm);
  // `--ignore-workspace` is pnpm's, and only outside dev mode: in dev mode
  // workspace resolution is what links the SDK to local source, and for every
  // other manager the scaffold's `pnpm-workspace.yaml` means nothing anyway —
  // so a flag for one of them would just be an unknown argument.
  const workspaceArgs = pm === "pnpm" && !isDevMode() ? ["--ignore-workspace"] : [];
  // execa errors already include stderr + stdout in their message, so the
  // user sees what actually went wrong (pnpm writes failures to stdout).
  await execa(cmd, [...args, "install", ...workspaceArgs], { cwd });
}

/**
 * Install deps with `pm`, reporting a failure through `warn` rather than
 * throwing: the project is scaffolded either way, and the two warnings say how
 * to finish the install by hand. Nothing downstream branches on the outcome —
 * `init` stops here — so it returns nothing.
 */
async function installDeps(
  cwd: string,
  pm: PackageManager,
  warn: Warn,
  silent?: boolean,
): Promise<void> {
  if (!(await hasDeps(cwd))) return;

  try {
    await withSpinner(
      silent,
      {
        start: `Installing dependencies with ${pm}`,
        done: "Dependencies installed",
        failed: "Dependency install failed",
      },
      () => runInstall(cwd, pm),
    );
  } catch (err: unknown) {
    warn(`${pm} install failed: ${errorMessage(err)}`);
    // Names the manager that actually ran. It used to say "Install pnpm
    // (`npm install -g pnpm`)" whatever had failed, which for an npm user was
    // advice to install a second manager to work around a bug in this command.
    warn(`Finish the install by hand: cd ${cwd} && ${pm} install`);
  }
}

/** Resolve target directory relative to the user's current directory. */
function resolveTargetDir(dir: string): string {
  return path.resolve(resolveCwd(), dir);
}

/**
 * Record a diagnostic: shown to a human AND kept for the result.
 *
 * One call site, two destinations — that pairing is the point. `log.warn`
 * alone is silenced in JSON mode, and a second hand-written `warnings.push`
 * beside each call is how the two drift.
 */
type Warn = (message: string) => void;

function collectWarnings(): { warn: Warn; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    warn: (message) => {
      warnings.push(message);
      log.warn(message);
    },
  };
}

/**
 * Scaffold the project, optionally showing a spinner.
 *
 * `packageManager` is passed rather than re-detected inside `runInit`: the two
 * files it writes that name a manager — the README and the manifest's
 * `packageManager` pin — have to name the one {@link installDeps} is about to
 * run, and a second detection is a second chance to disagree.
 */
async function scaffoldProject(
  dir: string,
  cwd: string,
  template: string,
  pm: PackageManagerInfo,
  silent?: boolean,
): Promise<void> {
  await withSpinner(
    silent,
    { start: `Creating ${dir}`, done: "Project created", failed: `Could not create ${dir}` },
    () => runInit({ targetDir: cwd, template, packageManager: pm }),
  );
}

/** Print post-init instructions. */
function printPostInitInfo(cwd: string, monorepoRoot: string | null): void {
  log.success(`Created ${cwd}`);
  if (monorepoRoot) log.info("Dev mode: project linked to workspace packages");
  log.info(`Next: cd ${cwd} && aai dev`);
}

export async function executeInit(
  opts: {
    dir?: string | undefined;
    force?: boolean | undefined;
    template?: string | undefined;
    yes?: boolean | undefined;
  },
  extra?: { silent?: boolean | undefined },
): Promise<CommandResult<InitData>> {
  const suppressUi = extra?.silent;
  if (!suppressUi) {
    p.intro(styleText("cyanBright", "Create a new voice agent"));
  }

  const dir = opts.dir ?? (await promptProjectName(opts.yes));
  const monorepoRoot = getMonorepoRoot();
  const cwd = resolveTargetDir(dir);

  if (!opts.force && (await fileExists(path.join(cwd, AGENT_ENTRY)))) {
    throw new Error(
      `${AGENT_ENTRY} already exists in this directory. Use ${styleText("cyanBright", "--force")} to overwrite.`,
    );
  }

  // Prompted only when there is a human to answer: `--yes` and JSON mode both
  // mean "take the default" (JSON mode is auto-detected on a pipe, and passes
  // `yes` through from the CLI), and `silent` is a caller saying the same.
  const template =
    opts.template ?? (opts.yes || suppressUi ? DEFAULT_TEMPLATE : await promptTemplate());
  const { warn, warnings } = collectWarnings();

  // Detected BEFORE the scaffold, because the README and the manifest it writes
  // both name the manager — see `scaffoldProject`.
  const pm = await detectPackageManager();
  await scaffoldProject(dir, cwd, template, pm, suppressUi);
  // `init` SCAFFOLDS: it deliberately does not publish. Deploying to
  // production is an outward-facing act, and doing it as a side effect of
  // creating a directory means a fresh `aai init` reached for credentials the
  // author may not have yet, and shipped a template agent nobody had run.
  // `aai publish` is the explicit step, once `aai dev` says the agent works.
  await installDeps(cwd, pm.name, warn, suppressUi);

  if (!suppressUi) {
    printPostInitInfo(cwd, monorepoRoot);
  }

  const data: InitData = { dir: cwd, template };
  // Omitted when empty so a clean init's result stays exactly as before.
  if (warnings.length > 0) data.warnings = warnings;
  return ok(data);
}
