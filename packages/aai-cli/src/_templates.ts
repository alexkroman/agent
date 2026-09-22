// Copyright 2025 the AAI authors. MIT license.

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  IGNORED_WORKSPACE_DIRS,
  isLocalOnlyFile,
  layerScaffoldFiles,
  readScaffoldFiles,
  writeFileWithParents,
} from "@alexkroman1/aai/workspace-files";
import { getMonorepoRoot } from "./_agent.ts";
import { errorMessage } from "./_utils.ts";

/** The GitHub repo (owner/name) that hosts this project and its templates. */
const REPO = "alexkroman/agent";
export const REPO_URL = `https://github.com/${REPO}`;

/**
 * Templates as shipped inside the published tarball, copied into `dist/` by
 * `bundle-templates.mjs` at build time — so this resolves to `dist/` for a
 * published CLI and to the (template-less) package root when running source
 * in the monorepo, where the branch above wins.
 *
 * They used to be fetched at `init` time with giget from
 * `github:alexkroman/agent/packages/aai-templates#main`. That required a
 * network for every `init`, and pinned templates to `main` regardless of the
 * CLI version the user had installed, so a template written against a newer
 * SDK could land in a project resolving an older one. Bundling pins the two
 * together by construction. It also puts the templates inside the studio's
 * guest sandbox, which has the CLI in its baked toolchain but no way to fetch
 * anything from GitHub.
 */
export function bundledTemplatesDir(): string {
  return import.meta.dirname;
}

/** Resolve the templates root — env override, then monorepo, then bundled. */
function resolveTemplatesDir(): string {
  const override = process.env.AAI_TEMPLATES_DIR;
  if (override) return override;
  const monorepoRoot = getMonorepoRoot();
  if (monorepoRoot) return path.join(monorepoRoot, "packages", "aai-templates");
  return bundledTemplatesDir();
}

/**
 * List the shipped template names (sorted). Backs `aai templates` and the
 * unknown-template error, so the discoverable list and the validated list
 * can never drift.
 */
export async function listTemplates(root = resolveTemplatesDir()): Promise<string[]> {
  const templatesDir = path.join(root, "templates");
  let available: Dirent[];
  try {
    available = await fs.readdir(templatesDir, { withFileTypes: true });
  } catch (err) {
    // A missing templates/ dir means a broken install (or an
    // AAI_TEMPLATES_DIR pointed somewhere wrong), not that the user picked a
    // bad name — say so instead of a raw ENOENT.
    throw new Error(
      `Templates directory is missing or unreadable at ${templatesDir} ` +
        `(incomplete @alexkroman1/aai-cli install?): ${errorMessage(err)}`,
      { cause: err },
    );
  }
  return available
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Directory holding the base scaffold — the files every project gets
 * underneath its template (package.json, tsconfig, `.gitignore`, …).
 *
 * The scaffold is the single definition of the self-hosted entrypoint, so a
 * caller needing one of its files resolves it here rather than carrying a
 * second copy of that file's contents.
 */
export function scaffoldDir(): string {
  return path.join(resolveTemplatesDir(), "scaffold");
}

/**
 * Layer the base scaffold (package.json, tsconfig, `.gitignore`, …) into
 * targetDir WITHOUT overwriting anything already there. Shared by `aai init`
 * (underneath a template) and `aai pull` (underneath the studio workspace
 * files — the workspace stores source, and the scaffold completes it into a
 * runnable project).
 *
 * The rule itself is `layerScaffoldFiles` in the SDK, over file maps, because
 * this is not its only caller: the studio's GitHub sync commits a workspace to
 * a repository and must complete it identically, and neither package may
 * import the other. This function is only the disk half — read what the rule
 * needs to see, write back what it returns. Only the scaffold's own paths are
 * read from the target: whether a project already has a given file is the one
 * thing the rule asks about it, and `package.json`'s content the one thing it
 * merges.
 */
export async function layerScaffold(targetDir: string): Promise<void> {
  const scaffold = await readScaffoldFiles(scaffoldDir());
  const existing: Record<string, string> = {};
  await Promise.all(
    [...Object.keys(scaffold), "CLAUDE.md"].map(async (rel) => {
      try {
        existing[rel] = await fs.readFile(path.join(targetDir, rel), "utf-8");
      } catch {
        // Missing (the common case) — the rule supplies it. An unreadable one
        // is left for whatever reads it next to report.
      }
    }),
  );
  const writes = layerScaffoldFiles(existing, scaffold);
  await Promise.all(
    Object.entries(writes).map(([rel, content]) =>
      writeFileWithParents(path.join(targetDir, rel), content),
    ),
  );
}

/**
 * `fs.cp` filter for every copy OUT of a template or the scaffold — the runtime
 * ones here and the build-time one in `bundle-templates.mjs`.
 *
 * A template directory is also a runnable project, so a developer who runs
 * `aai dev`, `aai build` or `aai publish` inside one leaves build output and
 * machine state in it: `.aai/` (which holds `project.json` — a SLUG and a
 * `serverUrl` — plus a built client), `.workflow-data/`, `node_modules/`, a
 * `.env`. None of it is git-tracked, and an unfiltered `fs.cp` copied all of it
 * anyway, to both destinations:
 *
 * - into every scaffolded project, so `aai init foo --template bar` produced a
 *   directory already LINKED to `bar`'s last local deploy. `aai init` publishes
 *   by default, so the first publish either targeted a slug the user never
 *   chose or — for the `http://localhost:8080` a dev checkout leaves behind —
 *   failed outright with "Refusing to send your API key to …", the project
 *   staying mis-linked for every later `push`/`publish`/`secret`.
 * - into `packages/aai-cli/dist/templates`, i.e. into the PUBLISHED tarball
 *   (`files: ["bin.mjs", "dist"]`). Measured on a real build: 26 stray
 *   `.aai/project.json` files and 9.4 MB of one developer's `.aai/client`
 *   bundles out of a 12 MB `templates/`.
 *
 * The vocabulary is the SDK's, not a fourth list: {@link IGNORED_WORKSPACE_DIRS}
 * is already "never walk this", and {@link isLocalOnlyFile} already means "this
 * exists only on a developer's machine" — including a `.env` that must not ship
 * to npm, and deliberately EXCLUDING `.env.example`, which the scaffold ships as
 * source and a scaffolded project cannot do without.
 */
export function templateCopyFilter(src: string): boolean {
  const name = path.basename(src);
  return !(IGNORED_WORKSPACE_DIRS.has(name) || isLocalOnlyFile(name));
}

/**
 * Copy a template into targetDir, merging scaffold files underneath.
 */
export async function downloadAndMergeTemplate(template: string, targetDir: string): Promise<void> {
  const root = resolveTemplatesDir();
  const templatesDir = path.join(root, "templates");

  const names = await listTemplates(root);
  if (!names.includes(template)) {
    throw new Error(`Unknown template "${template}". Available templates: ${names.join(", ")}`);
  }

  // Copy template-specific files first
  await fs.cp(path.join(templatesDir, template), targetDir, {
    recursive: true,
    force: true,
    filter: templateCopyFilter,
  });

  // Layer scaffold files underneath (don't overwrite template files)
  await layerScaffold(targetDir);
}
