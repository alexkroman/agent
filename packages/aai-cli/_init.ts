// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { getMonorepoRoot, isDevMode } from "./_agent.ts";
import { downloadAndMergeTemplate } from "./_templates.ts";

function readmeContent(slug: string): string {
  return `# ${slug}

A voice agent built with [aai](https://github.com/anthropics/aai).

## Getting started

\`\`\`sh
npm install        # Install dependencies
aai dev            # Run locally (opens browser)
aai deploy         # Deploy to production
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
  template?: string;
};

// Maps published npm names to monorepo directories so dev-mode init swaps
// version ranges for `link:` paths against the local packages/ tree.
const WORKSPACE_PKG_DIRS: Record<string, string> = {
  "@alexkroman1/aai": "aai",
  "@alexkroman1/aai-cli": "aai-cli",
  "@alexkroman1/aai-ui": "aai-ui",
  "aai-server": "aai-server",
  "aai-templates": "aai-templates",
};

export async function patchPackageJsonForWorkspace(targetDir: string): Promise<void> {
  const pkgPath = path.join(targetDir, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, "utf-8");
  } catch {
    return;
  }
  const pkgJson = JSON.parse(raw);

  pkgJson.name = path.basename(targetDir);
  delete pkgJson.packageManager;

  const root = getMonorepoRoot();
  if (!root) return;
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

  await fs.writeFile(pkgPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
}

export async function runInit(opts: InitOptions): Promise<string> {
  const { targetDir } = opts;
  const template = opts.template ?? "simple";

  await downloadAndMergeTemplate(template, targetDir);

  if (isDevMode()) {
    await patchPackageJsonForWorkspace(targetDir);
    // Workspace root .npmrc takes over; the per-template one would shadow it.
    await fs.unlink(path.join(targetDir, ".npmrc")).catch(() => {
      /* ok if missing */
    });
  }

  await fs
    .copyFile(path.join(targetDir, ".env.example"), path.join(targetDir, ".env"))
    .catch(() => {
      /* template may not have a .env.example */
    });

  const slug = path.basename(path.resolve(targetDir));
  try {
    await fs.writeFile(path.join(targetDir, "README.md"), readmeContent(slug), { flag: "wx" });
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
  }

  return targetDir;
}
