// Copyright 2025 the AAI authors. MIT license.

import { type Dirent, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@alexkroman1/aai/utils";
import { IGNORED_WORKSPACE_DIRS, isLocalOnlyFile } from "@alexkroman1/aai/workspace-files";
import { getMonorepoRoot } from "./_agent.ts";
import { errorMessage, writeJson } from "./_utils.ts";

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

/** package.json fields merged key-by-key rather than whole. */
const MERGED_MANIFEST_FIELDS = ["dependencies", "devDependencies", "scripts"] as const;

type Manifest = Record<string, unknown>;

/**
 * Fill a manifest's gaps from the scaffold's, `existing` always winning.
 *
 * The same rule the file layering uses, one level deeper: a top-level field
 * the manifest already declares is left alone, and for the three map fields
 * it is each ENTRY that is left alone. Per-entry matters both ways — a
 * workspace manifest pins its `dependencies` to exact installed versions and
 * must keep them, while a single agent-added `devDependencies` entry must not
 * shadow the whole toolchain block.
 *
 * Returns null when nothing was missing, so the common case writes no file.
 */
export function mergeScaffoldManifest(existing: Manifest, scaffold: Manifest): Manifest | null {
  const merged: Manifest = { ...existing };
  let changed = false;
  for (const [key, value] of Object.entries(scaffold)) {
    const mine = merged[key];
    if (mine === undefined) {
      merged[key] = value;
      changed = true;
      continue;
    }
    if (!(MERGED_MANIFEST_FIELDS as readonly string[]).includes(key)) continue;
    if (!(isRecord(mine) && isRecord(value))) continue;
    const entries = { ...mine };
    for (const [dep, spec] of Object.entries(value)) {
      if (dep in entries) continue;
      entries[dep] = spec;
      changed = true;
    }
    merged[key] = entries;
  }
  return changed ? merged : null;
}

/**
 * Merge the scaffold's package.json UNDER the one already in `targetDir`.
 *
 * The file-level layering below can only skip a manifest that already exists,
 * and for `aai pull` that manifest is the studio workspace's — which declares
 * its runtime dependencies and nothing else. Toolchain packages are baked into
 * the guest sandbox, so the workspace deliberately never names them (see
 * aai-guest/studio-project-shape.ts); on a laptop nothing bakes them, so
 * `pnpm install` fetched no `vite`, no `@vitejs/plugin-react`, no
 * `@tailwindcss/vite`, and `aai dev` died resolving the vite.config.ts the
 * very same layering had just written. Completing the manifest is the same job
 * as completing the file tree.
 */
async function layerScaffoldManifest(scaffoldDir: string, targetDir: string): Promise<void> {
  const target = path.join(targetDir, "package.json");
  const [mine, theirs] = await Promise.all([
    readJsonFile(target),
    readJsonFile(path.join(scaffoldDir, "package.json")),
  ]);
  // No manifest of its own means `fs.cp` copied the scaffold's verbatim.
  if (!(mine && theirs)) return;
  const merged = mergeScaffoldManifest(mine, theirs);
  // `writeJson`, which emits byte-identical output (same indent, same trailing
  // newline) and adds the temp-file + atomic rename every other config this CLI
  // writes already gets — `_init.ts` writes THIS same file through it.
  if (merged) await writeJson(target, merged);
}

/** Parse a JSON file, or null when it is missing or unparseable. */
async function readJsonFile(file: string): Promise<Manifest | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf-8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    // Missing, or mid-edit — leave it for the package manager to report.
    return null;
  }
}

/**
 * Directory holding the base scaffold — the files every project gets
 * underneath its template (package.json, tsconfig, `server.mjs`, …).
 *
 * The scaffold is the single definition of the self-hosted entrypoint, so a
 * caller needing one of its files resolves it here rather than carrying a
 * second copy of that file's contents.
 */
export function scaffoldDir(): string {
  return path.join(resolveTemplatesDir(), "scaffold");
}

/**
 * Layer the base scaffold (package.json, tsconfig, …) into targetDir
 * WITHOUT overwriting anything already there. Shared by `aai init`
 * (underneath a template) and `aai pull` (underneath the studio workspace
 * files — the workspace stores source, and the scaffold completes it into a
 * runnable project the same way the guest's `ensureProjectShape` does
 * before an in-sandbox build).
 *
 * package.json is the one file merged rather than skipped — see
 * {@link layerScaffoldManifest}.
 */
export async function layerScaffold(targetDir: string): Promise<void> {
  const dir = scaffoldDir();
  if (!existsSync(dir)) return;
  await fs.cp(dir, targetDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: templateCopyFilter,
  });
  await layerScaffoldManifest(dir, targetDir);
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
