// Copyright 2025 the AAI authors. MIT license.

import { type Dirent, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
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
export async function listTemplates(): Promise<string[]> {
  const templatesDir = path.join(resolveTemplatesDir(), "templates");
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
 * Copy a template into targetDir, merging scaffold files underneath.
 */
export async function downloadAndMergeTemplate(template: string, targetDir: string): Promise<void> {
  const root = resolveTemplatesDir();
  const templatesDir = path.join(root, "templates");

  const names = await listTemplates();
  if (!names.includes(template)) {
    throw new Error(`Unknown template "${template}". Available templates: ${names.join(", ")}`);
  }

  // Copy template-specific files first
  await fs.cp(path.join(templatesDir, template), targetDir, { recursive: true, force: true });

  // Layer scaffold files underneath (don't overwrite template files)
  const scaffoldDir = path.join(root, "scaffold");
  if (existsSync(scaffoldDir)) {
    await fs.cp(scaffoldDir, targetDir, { recursive: true, force: false, errorOnExist: false });
  }
}
