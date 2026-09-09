// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { getMonorepoRoot, isDevMode } from "./_agent.ts";
import { downloadAndMergeTemplate, REPO_URL } from "./_templates.ts";
import { compareCodeUnits, isEexist, readJson, writeJson } from "./_utils.ts";

/**
 * The package managers `aai init` can install a project with, in PREFERENCE
 * order — which is also the order `detectPackageManager` (`init.ts`) probes
 * `PATH` in.
 *
 * pnpm first because it stays the preference where it is present (the scaffold
 * is a pnpm workspace root and its lockfile is pnpm's), but it is no longer the
 * only answer: the install instructions everywhere teach
 * `npm i -g @alexkroman1/aai-cli`, and `init` then installed with pnpm alone —
 * reaching it through `corepack enable`, which does not exist on Node >= 25,
 * i.e. half the range `scaffold/package.json` declares.
 *
 * The list lives here, beside {@link PM_COMMANDS}, so the ORDER and the
 * per-manager command spellings cannot disagree about which managers exist: a
 * fifth entry fails to compile until that record has a row for it.
 */
export const PACKAGE_MANAGERS = ["pnpm", "npm", "bun", "yarn"] as const;

/** One of {@link PACKAGE_MANAGERS}. */
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** The manager `aai init` installed with, and the version to pin to it. */
export type PackageManagerInfo = {
  readonly name: PackageManager;
  /**
   * What goes in the manifest's `packageManager` field. Absent means the field
   * is REMOVED — see {@link stampPackageManager}.
   */
  readonly version?: string | undefined;
};

/**
 * The three spellings the generated README needs per manager.
 *
 * Everything a project's README tells an author to type is one of these: the
 * install, a package script, or the local `aai` binary. `run` carries the
 * explicit `run` in every row (`pnpm run dev` as well as `npm run dev`) rather
 * than each manager's shorthand — every one of the four accepts it, so the
 * table stays a table.
 */
const PM_COMMANDS: Record<PackageManager, { install: string; run: string; exec: string }> = {
  pnpm: { install: "pnpm install", run: "pnpm run", exec: "pnpm exec" },
  npm: { install: "npm install", run: "npm run", exec: "npx" },
  bun: { install: "bun install", run: "bun run", exec: "bunx" },
  // `yarn run aai …` rather than `yarn dlx`: dlx fetches a package from the
  // registry, and the binary wanted here is the one in this project.
  yarn: { install: "yarn install", run: "yarn run", exec: "yarn run" },
};

/**
 * The README every scaffolded project gets, and the first thing a new author
 * reads. Four things in it are corrections rather than prose:
 *
 * - **`<pm> run dev`, never a bare `aai dev`.** The CLI is a devDependency, so
 *   after the install the binary is in `node_modules/.bin` and NOT on
 *   `PATH`. The old quickstart said `aai dev`, which fails with
 *   `command not found` for everyone who has not installed the CLI globally.
 * - **Every command names the manager the install actually used.** It said
 *   `npm install` unconditionally, directly beside the pnpm lockfile `init`
 *   had just written — so the one file a new author reads disagreed with the
 *   directory it describes.
 * - **The key `aai dev` needs is named, with the two LOCAL ways first.** No
 *   step of local development needs a platform account; a twenty-persona DX
 *   audit read the account-shaped failure it used to get and concluded the
 *   opposite, then stopped using the loop this file documents.
 * - **`aai login` appears where it is actually required.** It was in no
 *   user-facing doc at all, while the quickstart's own publish step needs it.
 */
function readmeContent(slug: string, pm: PackageManager): string {
  const { install, run, exec } = PM_COMMANDS[pm];
  return `# ${slug}

A voice agent built with [aai](${REPO_URL}).

## Getting started

\`\`\`sh
${install.padEnd(18)}# Install dependencies
${`${run} dev`.padEnd(18)}# Run locally on http://localhost:3000 (opens browser)
\`\`\`

The \`aai\` CLI is a devDependency of this project, so it lives in
\`node_modules/.bin\` rather than on your \`PATH\`. Run it through ${pm}
(\`${run} dev\`, \`${run} test\`, \`${run} build\`) or with \`${exec} aai <command>\`.
Installing it globally (\`npm i -g @alexkroman1/aai-cli\`) also works, and is
what the project docs assume.

### The one key local development needs

The default pipeline (speech-to-text → LLM → text-to-speech) runs on a single
AssemblyAI key. **Any one of these is enough, and the first two need no aai
account** — nothing about running this agent locally is gated on one:

1. Put \`ASSEMBLYAI_API_KEY=<your key>\` in \`.env\` (this project's \`.env.example\`
   documents it, and it is the same file \`aai publish\` uploads as secrets).
2. Or export it in your shell: \`export ASSEMBLYAI_API_KEY=<your key>\`.
3. Or run \`${exec} aai login\`, and \`${run} dev\` will use your account's key.

Get a key at <https://www.assemblyai.com/dashboard>.

## Publishing

Publishing (and the studio it syncs to) is the one part that does need an
account:

\`\`\`sh
${`${exec} aai login`.padEnd(23)}# Link your account — once per machine
${`${run} publish:agent`.padEnd(23)}# Publish to production (and sync to the studio)
\`\`\`

You can also run this agent as a plain Node server, with no aai account and
nothing managed:

\`\`\`sh
${`${run} start`.padEnd(23)}# Builds, then serves on http://127.0.0.1:3000
\`\`\`

## Secrets

Access secrets in your agent via \`ctx.env.MY_KEY\`.

**Local development** — add secrets to \`.env\` (auto-loaded by \`aai dev\`):

\`\`\`sh
ALPHA_VANTAGE_KEY=sk-abc123
MY_API_KEY=secret-value
\`\`\`

**Production** — set secrets on the server:

\`\`\`sh
${`${exec} aai secret put MY_KEY`.padEnd(29)}# Set a secret (prompts for value)
${`${exec} aai secret list`.padEnd(29)}# List secret names
${`${exec} aai secret delete MY_KEY`.padEnd(29)}# Remove a secret
\`\`\`

`;
}

export type InitOptions = {
  targetDir: string;
  template: string;
  /**
   * The manager the caller is about to install with — see
   * {@link detectPackageManager} in `init.ts`.
   *
   * It reaches this far because the two files that have to AGREE with it are
   * written here: the README's every command, and the manifest's
   * `packageManager` pin. Omitted means npm and no pin, which is what a caller
   * with no opinion should generate — npm is the one manager every Node install
   * already has.
   */
  packageManager?: PackageManagerInfo | undefined;
};

/**
 * Map from npm package name to directory name under packages/.
 * Used to rewrite published version ranges to link: paths in dev mode.
 */
const WORKSPACE_PKG_DIRS: Record<string, string> = {
  "@alexkroman1/aai": "aai",
  "@alexkroman1/aai-cli": "aai-cli",
  "@alexkroman1/aai-runtime": "aai-runtime",
  "@alexkroman1/aai-ui": "aai-ui",
};

/** Rewrite workspace deps to link: paths so pnpm links to local source. */
export async function patchPackageJsonForWorkspace(targetDir: string): Promise<void> {
  const pkgPath = path.join(targetDir, "package.json");
  const pkgJson = (await readJson(pkgPath)) as {
    name?: string;
    packageManager?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null;
  if (!pkgJson) return; // no package.json to patch

  pkgJson.name = path.basename(targetDir);
  delete pkgJson.packageManager;

  const root = getMonorepoRoot();
  if (!root) return; // shouldn't happen — caller checks isDevMode()
  const packagesDir = path.join(root, "packages");

  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = pkgJson[field];
    if (!deps) continue;
    for (const key of Object.keys(deps)) {
      const dir = WORKSPACE_PKG_DIRS[key];
      if (dir) {
        deps[key] = `link:${path.relative(targetDir, path.join(packagesDir, dir))}`;
      }
    }
  }

  await writeJson(pkgPath, pkgJson);
  await pinSharedDeps(targetDir, packagesDir, pkgJson);
}

/**
 * Pin every THIRD-PARTY dependency this project shares with a linked workspace
 * package to the copy that workspace package resolved.
 *
 * Linking is what makes this necessary, and it only bites in dev mode. The
 * project's `@alexkroman1/*` deps become `link:` paths, so the SDK's types come
 * out of the WORKSPACE's `node_modules` — while the project installs its own
 * copy of anything it also declares. Two copies of a structurally identical
 * library are two NOMINALLY different types to TypeScript, and the error runs to
 * a hundred lines of `Type 'AnyActorLogic' is not assignable to type
 * 'AnyActorLogic'` with two absolute paths in it.
 *
 * Measured: `aai init --template technical-support-agent` produced exactly that. The
 * workspace lockfile pinned `xstate@5.32.5`, the fresh project resolved
 * `^5.32.5` to `5.32.6`, the CLI's typecheck gate failed, and the deploy was
 * REFUSED — `"deployed": false` with the whole error as a warning. One
 * `overrides` entry fixes it; verified end to end.
 *
 * A published install has no such problem, which is why this is dev-mode only:
 * a user's project and the published SDK both ask for `^5.32.5` and pnpm
 * resolves ONE copy. Nothing here changes what a user gets.
 *
 * Written to `pnpm-workspace.yaml` rather than `pnpm.overrides` in the manifest:
 * the scaffold ships that file, which makes the project its own workspace root,
 * and pnpm 10+ reads overrides from there. Verified both ways — the manifest
 * spelling installed `5.32.6` anyway.
 */
async function pinSharedDeps(
  targetDir: string,
  packagesDir: string,
  pkgJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
): Promise<void> {
  const declared = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
  // Only the workspace packages this project actually links: a dep resolved by
  // a package nothing here imports says nothing about what this project needs.
  const linked = Object.entries(WORKSPACE_PKG_DIRS)
    .filter(([name]) => name in declared)
    .map(([, dir]) => dir);

  // One overlapped pass per dependency rather than a nested sequential await:
  // most of these reads are ENOENT, so the serialized version paid a round trip
  // per (dependency x workspace package). Each name's own inner loop still stops
  // at the first package that resolved it, which is what preserves "first wins".
  const resolved = await Promise.all(
    Object.keys(declared)
      .filter((name) => !(name in WORKSPACE_PKG_DIRS))
      .map(async (name): Promise<[string, string] | null> => {
        for (const dir of linked) {
          const manifest = (await readJson(
            path.join(packagesDir, dir, "node_modules", name, "package.json"),
          )) as { version?: string } | null;
          // The FIRST workspace package that resolved it wins. They install from
          // one lockfile, so two of them holding different versions of the same
          // dependency is a state this repo's own syncpack gate refuses.
          if (typeof manifest?.version === "string") return [name, manifest.version];
        }
        return null;
      }),
  );
  const pins = new Map(resolved.filter((entry): entry is [string, string] => entry !== null));
  if (pins.size === 0) return;

  const file = path.join(targetDir, "pnpm-workspace.yaml");
  let existing: string;
  try {
    existing = await fs.readFile(file, "utf-8");
  } catch {
    return; // No workspace file to extend — nothing to pin against.
  }
  // Appended rather than parsed and rewritten: the scaffold's copy carries
  // comment blocks that argue for `minimumReleaseAgeExclude` and
  // `onlyBuiltDependencies`, and a YAML round trip drops every one of them.
  const block = [...pins]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    // QUOTED, both halves. A scoped name starts with `@`, which YAML reserves —
    // an unquoted `@tailwindcss/vite:` is `bad indentation of a mapping entry`
    // and fails the install outright. And a two-segment version (`5.0`) parses
    // as a FLOAT, which would silently pin something else.
    .map(([name, version]) => `  "${name}": "${version}"`)
    .join("\n");
  await fs.writeFile(
    file,
    `${existing.trimEnd()}\n\n# Added by \`aai init\` in DEV MODE only — see pinSharedDeps in\n` +
      "# packages/aai-cli/src/_init.ts. The @alexkroman1/* packages above are LINKED to\n" +
      "# this checkout, so anything they and this project both depend on has to be\n" +
      "# ONE copy: two copies of xstate are two incompatible sets of types, and the\n" +
      `# typecheck gate refuses the deploy.\noverrides:\n${block}\n`,
  );
}

/**
 * Pin the manifest's `packageManager` to the manager that actually installed —
 * or REMOVE the field when there is no version to pin.
 *
 * The scaffold ships `packageManager: pnpm@<v>` because it is a pnpm workspace
 * root in this repo, and it used to be copied verbatim into a project installed
 * with something else. That is not inert: pnpm and Yarn both READ the field and
 * refuse to run when it names another manager ("This project is configured to
 * use pnpm"), so a project installed with npm could not later be touched by
 * yarn without editing a field nobody chose. Stamping the manager that ran is
 * the whole fix, and dropping it when the version is unknown is the honest
 * fallback — a bare name is not a valid value for that field.
 */
async function stampPackageManager(targetDir: string, pm: PackageManagerInfo): Promise<void> {
  const pkgPath = path.join(targetDir, "package.json");
  const pkgJson = (await readJson(pkgPath)) as { packageManager?: string } | null;
  if (!pkgJson) return; // no package.json to stamp
  const pin = pm.version === undefined ? undefined : `${pm.name}@${pm.version}`;
  if (pkgJson.packageManager === pin) return;
  if (pin === undefined) delete pkgJson.packageManager;
  else pkgJson.packageManager = pin;
  await writeJson(pkgPath, pkgJson);
}

export async function runInit(opts: InitOptions): Promise<void> {
  const { targetDir, template } = opts;
  const pm: PackageManagerInfo = opts.packageManager ?? { name: "npm" };

  await downloadAndMergeTemplate(template, targetDir);

  if (isDevMode()) {
    // `patchPackageJsonForWorkspace` drops `packageManager` outright rather
    // than stamping it: a dev-mode project is installed INSIDE this pnpm
    // workspace, and a pin it does not need is one more thing to disagree with
    // the root.
    await patchPackageJsonForWorkspace(targetDir);
    // Remove standalone .npmrc — workspace root .npmrc governs
    try {
      await fs.unlink(path.join(targetDir, ".npmrc"));
    } catch {
      /* ok if missing */
    }
  } else {
    await stampPackageManager(targetDir, pm);
  }

  try {
    // COPYFILE_EXCL: never overwrite an existing .env — it may hold the user's
    // real secrets (e.g. re-running `aai init --force` in an existing project).
    await fs.copyFile(
      path.join(targetDir, ".env.example"),
      path.join(targetDir, ".env"),
      fs.constants.COPYFILE_EXCL,
    );
  } catch {
    /* no .env.example in template, or .env already exists — leave it */
  }

  const readmePath = path.join(targetDir, "README.md");
  const slug = path.basename(path.resolve(targetDir));
  try {
    await fs.writeFile(readmePath, readmeContent(slug, pm.name), { flag: "wx" });
  } catch (err: unknown) {
    if (!isEexist(err)) throw err;
  }
}
