// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadTemplate } from "giget";
import { isDevMode } from "./_agent.ts";

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
  const { dir } = await downloadTemplate(`${GIGET_SOURCE}#${GIGET_REF}`, { force: true });
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

  // Layer scaffold files underneath (don't overwrite template files)
  const scaffoldDir = path.join(root, "scaffold");
  if (existsSync(scaffoldDir)) {
    const entries = await fs.readdir(scaffoldDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const rel = path.relative(scaffoldDir, path.join(entry.parentPath, entry.name));
      const destPath = path.join(targetDir, rel);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      try {
        await fs.copyFile(path.join(scaffoldDir, rel), destPath, fs.constants.COPYFILE_EXCL);
      } catch (err: unknown) {
        if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
      }
    }
  }
}
