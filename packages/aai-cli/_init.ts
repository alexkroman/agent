// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { isDevMode } from "./_agent.ts";
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
};

/**
 * Map from npm package name to directory name under packages/.
 * Used to rewrite published version ranges to link: paths in dev mode.
 */
const WORKSPACE_PKG_DIRS: Record<string, string> = {
  "@alexkroman1/aai-core": "aai-core",
  "@alexkroman1/aai-cli": "aai-cli",
  "@alexkroman1/aai-ui": "aai-ui",
  "@alexkroman1/aai-server": "aai-server",
  "@alexkroman1/aai-templates": "aai-templates",
};

/** Rewrite @alexkroman1/* deps to link: paths so pnpm links to local source. */
export async function patchPackageJsonForWorkspace(targetDir: string): Promise<void> {
  const pkgPath = path.join(targetDir, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, "utf-8");
  } catch {
    return; // no package.json to patch
  }
  const pkgJson = JSON.parse(raw);

  pkgJson.name = path.basename(targetDir);
  delete pkgJson.packageManager;

  const { getMonorepoRoot } = await import("./_agent.ts");
  const root = getMonorepoRoot();
  if (!root) return; // shouldn't happen — caller checks isDevMode()
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

  await downloadAndMergeTemplate("simple", targetDir);

  if (isDevMode()) {
    await patchPackageJsonForWorkspace(targetDir);
    // Remove standalone .npmrc — workspace root .npmrc governs
    try {
      await fs.unlink(path.join(targetDir, ".npmrc"));
    } catch {
      /* ok if missing */
    }
  }

  try {
    await fs.copyFile(path.join(targetDir, ".env.example"), path.join(targetDir, ".env"));
  } catch {
    /* no .env.example in template */
  }

  const readmePath = path.join(targetDir, "README.md");
  const slug = path.basename(path.resolve(targetDir));
  try {
    await fs.writeFile(readmePath, readmeContent(slug), { flag: "wx" });
  } catch (err: unknown) {
    if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
  }

  return targetDir;
}
