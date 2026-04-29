// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadTemplate } from "giget";
import { isDevMode } from "./_agent.ts";

const GIGET_SOURCE = "github:alexkroman/agent/packages/aai-templates";
const GIGET_REF = process.env.AAI_TEMPLATES_REF ?? "main";

function resolveLocalTemplatesDir(): string {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(cliDir, "../aai-templates"),
    path.resolve(cliDir, "../../aai-templates"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Cannot find local aai-templates package");
}

async function resolveTemplatesDir(): Promise<string> {
  if (process.env.AAI_TEMPLATES_DIR) return process.env.AAI_TEMPLATES_DIR;
  if (isDevMode()) return resolveLocalTemplatesDir();
  // Force a unique tmp dir — without `dir`, giget extracts into
  // `<cwd>/<owner>-<repo>` and leaves a stray folder next to the user's project.
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-templates-"));
  const { dir } = await downloadTemplate(`${GIGET_SOURCE}#${GIGET_REF}`, {
    dir: extractDir,
    force: true,
    forceClean: true,
  });
  return dir;
}

export async function downloadAndMergeTemplate(template: string, targetDir: string): Promise<void> {
  const root = await resolveTemplatesDir();
  const templatesDir = path.join(root, "templates");

  const entries = await fs.readdir(templatesDir, { withFileTypes: true });
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (!names.includes(template)) {
    throw new Error(`Unknown template "${template}". Available templates: ${names.join(", ")}`);
  }

  await fs.cp(path.join(templatesDir, template), targetDir, { recursive: true, force: true });

  const scaffoldDir = path.join(root, "scaffold");
  if (!existsSync(scaffoldDir)) return;
  const scaffoldEntries = await fs.readdir(scaffoldDir, { recursive: true, withFileTypes: true });
  for (const entry of scaffoldEntries) {
    if (!entry.isFile()) continue;
    const srcPath = path.join(entry.parentPath, entry.name);
    const destPath = path.join(targetDir, path.relative(scaffoldDir, srcPath));
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    try {
      await fs.copyFile(srcPath, destPath, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
  }
}
