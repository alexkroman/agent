// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { downloadAndMergeTemplate } from "./templates.ts";

export type InitOptions = {
  targetDir: string;
  template: string;
};

export async function runInit(opts: InitOptions): Promise<string> {
  const { targetDir, template } = opts;

  await downloadAndMergeTemplate(template, targetDir);

  try {
    await fs.copyFile(path.join(targetDir, ".env.example"), path.join(targetDir, ".env"));
  } catch {
    /* no .env.example in template */
  }

  // Generate README.md with getting-started instructions (skip if template provides one)
  const readmePath = path.join(targetDir, "README.md");
  const slug = path.basename(path.resolve(targetDir));
  const readme = `# ${slug}

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

## Learn more

See \`CLAUDE.md\` for the full agent API reference.
`;
  try {
    await fs.writeFile(readmePath, readme, { flag: "wx" });
  } catch (err: unknown) {
    if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
  }

  return targetDir;
}
