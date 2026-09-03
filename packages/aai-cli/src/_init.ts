// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { getMonorepoRoot, isDevMode } from "./_agent.ts";
import { downloadAndMergeTemplate, REPO_URL } from "./_templates.ts";
import { isEexist, readJson, writeJson } from "./_utils.ts";

function readmeContent(slug: string): string {
  return `# ${slug}

A voice agent built with [aai](${REPO_URL}).

## Getting started

\`\`\`sh
npm install        # Install dependencies
aai dev            # Run locally (opens browser)
aai publish        # Publish to production (and sync to the studio)
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
aai secret put MY_KEY    # Set a secret (prompts for value)
aai secret list          # List secret names
aai secret delete MY_KEY # Remove a secret
\`\`\`

`;
}

export type InitOptions = {
  targetDir: string;
  template: string;
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
 * Code-unit ordering, never `localeCompare`.
 *
 * With no explicit locale that answers to the runtime's ICU default, so the same
 * project would scaffold a differently-ordered file on a different machine —
 * which is the reason the repo's own generated artifacts sort this way too.
 */
function compareNames(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
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
 * Measured: `aai init --template support-line` produced exactly that. The
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

  const pins = new Map<string, string>();
  for (const name of Object.keys(declared)) {
    if (name in WORKSPACE_PKG_DIRS) continue;
    for (const dir of linked) {
      const manifest = (await readJson(
        path.join(packagesDir, dir, "node_modules", name, "package.json"),
      )) as { version?: string } | null;
      // The FIRST workspace package that resolved it wins. They install from one
      // lockfile, so two of them holding different versions of the same
      // dependency is a state this repo's own syncpack gate refuses.
      if (typeof manifest?.version === "string") {
        pins.set(name, manifest.version);
        break;
      }
    }
  }
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
    .sort(([a], [b]) => compareNames(a, b))
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

export async function runInit(opts: InitOptions): Promise<void> {
  const { targetDir, template } = opts;

  await downloadAndMergeTemplate(template, targetDir);

  if (isDevMode()) {
    await patchPackageJsonForWorkspace(targetDir);
    // Remove standalone .npmrc — workspace root .npmrc governs
    try {
      await fs.unlink(path.join(targetDir, ".npmrc"));
    } catch {
      /* ok if missing */
    }
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
    await fs.writeFile(readmePath, readmeContent(slug), { flag: "wx" });
  } catch (err: unknown) {
    if (!isEexist(err)) throw err;
  }
}
