// Copyright 2025 the AAI authors. MIT license.

import { type Dirent, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadTemplate } from "giget";
import { getMonorepoRoot, isDevMode } from "./_agent.ts";
import { errorMessage } from "./_utils.ts";

const GIGET_SOURCE = "github:alexkroman/agent/packages/aai-templates";
const GIGET_REF = process.env.AAI_TEMPLATES_REF ?? "main";
// Git ref shapes only (branch/tag/sha). The source repo is fixed, but the
// ref is environment-controlled — a trust-sensitive override that pins init
// to an arbitrary branch of the templates repo, so it must at least be
// shaped like a ref rather than free text.
const VALID_REF_RE = /^[\w./-]+$/;

/**
 * Resolved templates location. `cleanup` disposes any temp extraction dir —
 * a no-op for the local (dev / AAI_TEMPLATES_DIR) paths.
 */
type TemplatesDir = { root: string; cleanup: () => Promise<void> };

const noCleanup = async (): Promise<void> => undefined;

/** Resolve the templates directory — local in dev, giget download in prod. */
async function resolveTemplatesDir(): Promise<TemplatesDir> {
  if (process.env.AAI_TEMPLATES_DIR) {
    return { root: process.env.AAI_TEMPLATES_DIR, cleanup: noCleanup };
  }
  // isDevMode() implies a monorepo checkout, so getMonorepoRoot() is non-null.
  const monorepoRoot = isDevMode() ? getMonorepoRoot() : null;
  if (monorepoRoot) {
    return { root: path.join(monorepoRoot, "packages", "aai-templates"), cleanup: noCleanup };
  }
  if (!VALID_REF_RE.test(GIGET_REF)) {
    throw new Error(`Invalid AAI_TEMPLATES_REF: ${JSON.stringify(GIGET_REF)} is not a git ref.`);
  }
  // Extract into a unique tmp dir; otherwise giget defaults to
  // `<cwd>/<repo-owner>-<repo-name>`, which dumps a stray
  // `alexkroman-agent/` folder next to the user's project.
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-templates-"));
  const cleanup = async (): Promise<void> => {
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const { dir } = await downloadTemplate(`${GIGET_SOURCE}#${GIGET_REF}`, {
      dir: extractDir,
      force: true,
      forceClean: true,
    });
    return { root: dir, cleanup };
  } catch (err) {
    // Don't leave a half-extracted tmp dir behind on a failed download.
    await cleanup();
    throw new Error(
      `Failed to download templates from ${GIGET_SOURCE}#${GIGET_REF}: ${errorMessage(err)}`,
      { cause: err },
    );
  }
}

/**
 * Download a template into targetDir, merging scaffold files underneath.
 */
export async function downloadAndMergeTemplate(template: string, targetDir: string): Promise<void> {
  const { root, cleanup } = await resolveTemplatesDir();
  try {
    const templatesDir = path.join(root, "templates");

    let available: Dirent[];
    try {
      available = await fs.readdir(templatesDir, { withFileTypes: true });
    } catch (err) {
      // A missing templates/ dir means the download was incomplete or corrupt,
      // not that the user picked a bad name — say so instead of a raw ENOENT.
      throw new Error(
        `Templates directory is missing or unreadable at ${templatesDir} ` +
          `(corrupt or incomplete template download?): ${errorMessage(err)}`,
        { cause: err },
      );
    }
    const names = available.filter((e) => e.isDirectory()).map((e) => e.name);
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
  } finally {
    // The extraction dir used to be abandoned on success — every production
    // `aai init` leaked a full template checkout into the OS temp dir.
    await cleanup();
  }
}
