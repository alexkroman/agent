// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadTemplate } from "giget";
import { isDevMode } from "./_discover.ts";

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
  if (isDevMode()) return resolveLocalTemplatesDir();
  const { dir } = await downloadTemplate(`${GIGET_SOURCE}#${GIGET_REF}`, { force: true });
  return dir;
}

/** List available template names. */
export async function listTemplates(): Promise<string[]> {
  const dir = await resolveTemplatesDir();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Download a template into targetDir, merging _shared files underneath.
 */
export async function downloadAndMergeTemplate(template: string, targetDir: string): Promise<void> {
  const templatesDir = await resolveTemplatesDir();

  const available = await fs.readdir(templatesDir, { withFileTypes: true });
  const names = available
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name);
  if (!names.includes(template)) {
    throw new Error(`unknown template '${template}' -- available: ${names.join(", ")}`);
  }

  // Copy template-specific files first
  await fs.cp(path.join(templatesDir, template), targetDir, { recursive: true, force: true });

  // Layer _shared files underneath (don't overwrite template files)
  const sharedDir = path.join(templatesDir, "_shared");
  if (existsSync(sharedDir)) {
    const entries = await fs.readdir(sharedDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const rel = path.relative(sharedDir, path.join(entry.parentPath, entry.name));
      const destPath = path.join(targetDir, rel);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      try {
        await fs.copyFile(path.join(sharedDir, rel), destPath, fs.constants.COPYFILE_EXCL);
      } catch (err: unknown) {
        if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
      }
    }
  }
}
