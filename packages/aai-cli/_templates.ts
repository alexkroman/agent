// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadTemplate } from "giget";
import { isDevMode } from "./_agent.ts";
import { fileExists } from "./_utils.ts";

const GIGET_SOURCE = "github:alexkroman/agent/packages/aai-templates";
const GIGET_REF = process.env.AAI_TEMPLATES_REF ?? "main";

/** Resolve the local aai-templates package directory (dev mode only). */
function resolveLocalTemplatesDir(): string {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const fromSrc = path.resolve(cliDir, "../aai-templates");
  const fromDist = path.resolve(cliDir, "../../aai-templates");
  if (existsSync(fromSrc)) return fromSrc;
  if (existsSync(fromDist)) return fromDist;
  throw new Error("Cannot find local aai-templates package");
}

/** Resolve the templates directory — local in dev, giget download in prod. */
async function resolveTemplatesDir(): Promise<string> {
  if (process.env.AAI_TEMPLATES_DIR) return process.env.AAI_TEMPLATES_DIR;
  if (isDevMode()) return resolveLocalTemplatesDir();
  // Extract into a unique tmp dir; otherwise giget defaults to
  // `<cwd>/<repo-owner>-<repo-name>`, which dumps a stray
  // `alexkroman-agent/` folder next to the user's project.
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-templates-"));
  const { dir } = await downloadTemplate(`${GIGET_SOURCE}#${GIGET_REF}`, {
    dir: extractDir,
    force: true,
    forceClean: true,
  });
  return dir;
}

/**
 * Download a template into targetDir, merging scaffold files underneath.
 */
export async function downloadAndMergeTemplate(template: string, targetDir: string): Promise<void> {
  const root = await resolveTemplatesDir();
  const templatesDir = path.join(root, "templates");

  const available = await fs.readdir(templatesDir, { withFileTypes: true });
  const names = available.filter((e) => e.isDirectory()).map((e) => e.name);
  if (!names.includes(template)) {
    throw new Error(`Unknown template "${template}". Available templates: ${names.join(", ")}`);
  }

  // Copy template-specific files first
  await fs.cp(path.join(templatesDir, template), targetDir, { recursive: true, force: true });

  // Layer scaffold files underneath (force: false skips files the template
  // already wrote, so template files win).
  const scaffoldDir = path.join(root, "scaffold");
  if (await fileExists(scaffoldDir)) {
    await fs.cp(scaffoldDir, targetDir, { recursive: true, force: false, errorOnExist: false });
  }
}
