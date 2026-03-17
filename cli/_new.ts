// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import glob from "fast-glob";
import fsExtra from "fs-extra";
import { step } from "./_output.ts";

export const _internals = {
  step,
};

export type NewOptions = {
  targetDir: string;
  template: string;
  templatesDir: string;
};

export async function listTemplates(dir: string): Promise<string[]> {
  const templates: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith("_")) {
      templates.push(entry.name);
    }
  }
  return templates.sort();
}

/**
 * Copy all files from `src` into `dest`, skipping files that already exist
 * in `dest` so that template-specific files take precedence over shared ones.
 */
async function copyDirNoOverwrite(src: string, dest: string): Promise<void> {
  const files = await glob("**/*", { cwd: src, dot: true, onlyFiles: true });
  for (const file of files) {
    const destPath = path.join(dest, file);
    try {
      await fs.access(destPath);
      // File exists, skip
    } catch {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(path.join(src, file), destPath);
    }
  }
}

export async function runNew(opts: NewOptions): Promise<string> {
  const { targetDir, template, templatesDir } = opts;
  const available = await listTemplates(templatesDir);

  if (!available.includes(template)) {
    throw new Error(`unknown template '${template}' -- available: ${available.join(", ")}`);
  }

  _internals.step("Create", `from template '${template}'`);

  // 1. Copy template-specific files first
  await fsExtra.copy(path.join(templatesDir, template), targetDir, { overwrite: true });

  // 2. Layer shared files underneath (don't overwrite template files)
  await copyDirNoOverwrite(path.join(templatesDir, "_shared"), targetDir);

  try {
    await fs.copyFile(path.join(targetDir, ".env.example"), path.join(targetDir, ".env"));
  } catch {
    /* no .env.example in template */
  }

  // Generate README.md with getting-started instructions (skip if template provides one)
  const readmePath = path.join(targetDir, "README.md");
  try {
    await fs.access(readmePath);
  } catch {
    const slug = path.basename(path.resolve(targetDir));
    const readme = `# ${slug}

A voice agent built with [aai](https://github.com/anthropics/aai).

## Getting started

\`\`\`sh
npm install        # Install dependencies
npm run dev        # Run locally (opens browser)
npm run deploy     # Deploy to production
\`\`\`

## Environment variables

Secrets are managed on the server, not in local files:

\`\`\`sh
aai env add MY_KEY # Set a secret (prompts for value)
aai env ls         # List secret names
aai env pull       # Pull names into .env for reference
aai env rm MY_KEY  # Remove a secret
\`\`\`

Access secrets in your agent via \`ctx.env.MY_KEY\`.

## Learn more

See \`CLAUDE.md\` for the full agent API reference.
`;
    await fs.writeFile(readmePath, readme);
  }

  _internals.step("Done", targetDir);
  return targetDir;
}
