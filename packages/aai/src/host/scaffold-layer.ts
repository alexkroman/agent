// Copyright 2026 the AAI authors. MIT license.
/**
 * Complete a studio workspace's SOURCE into a runnable PROJECT by layering the
 * scaffold underneath it — as a pure function over file maps.
 *
 * A workspace is deliberately not a project on its own. Its manifest declares
 * no platform packages and no scripts (the guest image bakes the toolchain in,
 * and declaring it made every sandbox install re-fetch the SDK — see
 * `aai-guest-studio/project-shape.ts`), and it carries no `.gitignore`,
 * `.env.example` or `pnpm-workspace.yaml`. Anything that hands a workspace to a
 * laptop has to finish the job, and there are two such exits:
 *
 * - `aai pull` writes the files into a directory (`aai-cli/_templates.ts`).
 * - The studio's GitHub sync commits them to a branch
 *   (`aai-studio-server/studio-github-sync.ts`).
 *
 * The second one used to skip it, so a repository synced from the studio had a
 * `package.json` with `dependencies: {}` and no scripts: `pnpm install`
 * installed nothing, `pnpm dev` was "Command not found", `aai` was not on the
 * path at all, and `npx aai` resolves to an UNRELATED npm package. Both exits
 * now call {@link layerScaffoldFiles}, so there is one rule rather than a
 * second copy that drifts. It lives here, in the SDK, because the CLI may not
 * import the server and the server may not import the CLI — this subpath is the
 * one both already share for "what a project's files are".
 *
 * @internal Not part of the published API surface — see `./workspace-files`.
 */

import { isRecord } from "../sdk/is-record.ts";
import { isLocalOnlyFile, snapshotWorkspaceFiles } from "./workspace-files.ts";

/** A parsed `package.json` — open-ended, since only a few fields are merged. */
export type PackageManifest = Record<string, unknown>;

/** package.json fields merged key-by-key rather than whole. */
const MERGED_MANIFEST_FIELDS = ["dependencies", "devDependencies", "scripts"] as const;

/**
 * Fill a manifest's gaps from the scaffold's, `existing` always winning.
 *
 * The same rule the file layering uses, one level deeper: a top-level field
 * the manifest already declares is left alone, and for the three map fields
 * it is each ENTRY that is left alone. Per-entry matters both ways — a
 * workspace manifest pins its `dependencies` to exact installed versions and
 * must keep them, while a single agent-added `devDependencies` entry must not
 * shadow the whole toolchain block.
 *
 * Returns null when nothing was missing, so the common case writes no file.
 */
export function mergeScaffoldManifest(
  existing: PackageManifest,
  scaffold: PackageManifest,
): PackageManifest | null {
  const merged: PackageManifest = { ...existing };
  let changed = false;
  for (const [key, value] of Object.entries(scaffold)) {
    const mine = merged[key];
    if (mine === undefined) {
      merged[key] = value;
      changed = true;
      continue;
    }
    if (!(MERGED_MANIFEST_FIELDS as readonly string[]).includes(key)) continue;
    if (!(isRecord(mine) && isRecord(value))) continue;
    const entries = { ...mine };
    for (const [dep, spec] of Object.entries(value)) {
      if (dep in entries) continue;
      entries[dep] = spec;
      changed = true;
    }
    merged[key] = entries;
  }
  return changed ? merged : null;
}

/**
 * The project-root `CLAUDE.md` a project gets — a POINTER at the guide inside
 * the resolved SDK, not a copy of it.
 *
 * `scaffold/CLAUDE.md` is the authoring guide itself (~120k characters). It
 * has three consumers and only one wanted the bytes in a project, and that one
 * could not be right: a copy is frozen at scaffold time while
 * `pnpm update @alexkroman1/aai` moves the SDK beside it, and Claude Code loads
 * a project-root `CLAUDE.md` in FULL on every session. The guide already ships
 * in the SDK tarball as `AGENT_GUIDE.md`, version-matched by construction, so
 * a project gets a pointer at that. The path is named inside a FENCE, the
 * documented spelling for "mention, do not import" — an `@path` outside
 * backticks would be expanded into context at launch and put the 120KB back.
 */
export const PROJECT_GUIDE_POINTER = `# Agent instructions

This is an [aai](https://github.com/alexkroman/agent) voice-agent project. An agent is a directory
containing \`agent.ts\`; the \`aai\` CLI bundles it and deploys it.

## Read the SDK guide before writing agent code

The complete authoring guide ships inside the installed package:

\`\`\`text
node_modules/@alexkroman1/aai/AGENT_GUIDE.md
\`\`\`

Read it with your file tools. It is version-matched by construction — it lives
in the same tarball as the \`@alexkroman1/aai\` this project resolved, so it
cannot describe a different release than the one being imported. Prefer it over
anything remembered about the SDK, and over anything in this file.

The types are the second source of truth: the shipped declarations are in
\`node_modules/@alexkroman1/aai/dist/\`. When the guide and the types disagree,
the types are what the compiler enforces.

## Commands

\`\`\`sh
npm run dev            # Run locally on http://localhost:3000
npm test               # This project's suite, minus the evals
npm run test:agent     # Just agent.test.ts, via the CLI
npm run eval           # Drive a real session against a live model (spends money)
npm run build          # Bundle the agent
npm start              # Build, then self-host on http://127.0.0.1:3000
npm run publish:agent  # Publish to the managed platform
\`\`\`

The \`aai\` CLI is a devDependency, so it is in \`node_modules/.bin\` rather than
on \`PATH\`: reach it through these scripts or with \`npx aai <command>\`.

## Project-specific notes

<!-- Add conventions, gotchas and decisions for THIS agent below. -->
`;

/** Parse a manifest, or null when it is not a JSON object. */
function parseManifest(text: string): PackageManifest | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The files layering `scaffold` under `files` adds or changes — and ONLY
 * those, so a caller writing to disk touches nothing it does not have to, and
 * one building a commit spreads the result over what it already holds.
 *
 * Three rules, and `files` always wins:
 *
 * - A scaffold file `files` lacks is added verbatim.
 * - `package.json` present on both sides is MERGED ({@link mergeScaffoldManifest}),
 *   because a studio manifest's gap is exactly the scaffold's toolchain and
 *   scripts. An existing manifest that does not parse is left for the package
 *   manager to report, never overwritten.
 * - The scaffold's `CLAUDE.md` is the authoring guide and is never copied; a
 *   project without its own gets {@link PROJECT_GUIDE_POINTER} instead.
 *
 * An empty `scaffold` adds nothing at all: with no scaffold to layer there is
 * no project shape to complete, and a lone `CLAUDE.md` would not be one.
 */
export function layerScaffoldFiles(
  files: Readonly<Record<string, string>>,
  scaffold: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (Object.keys(scaffold).length === 0) return out;
  for (const [rel, content] of Object.entries(scaffold)) {
    if (rel === "CLAUDE.md") continue;
    const mine = files[rel];
    if (mine === undefined) {
      out[rel] = content;
      continue;
    }
    if (rel !== "package.json") continue;
    const [existing, theirs] = [parseManifest(mine), parseManifest(content)];
    if (!(existing && theirs)) continue;
    const merged = mergeScaffoldManifest(existing, theirs);
    if (merged) out[rel] = `${JSON.stringify(merged, null, 2)}\n`;
  }
  if (files["CLAUDE.md"] === undefined) out["CLAUDE.md"] = PROJECT_GUIDE_POINTER;
  return out;
}

/**
 * Read a scaffold directory into the map {@link layerScaffoldFiles} takes, or
 * `{}` when it is missing.
 *
 * Filtered the way every copy out of a template is: an ignored directory
 * (`node_modules`, `.aai`, …) is never walked, and a local-only file (`.env`,
 * a lockfile) never read. A scaffold checkout is also a directory somebody may
 * have run a command in, and none of that belongs in a user's project.
 */
export async function readScaffoldFiles(dir: string): Promise<Record<string, string>> {
  try {
    const { files } = await snapshotWorkspaceFiles(dir, { skipFile: isLocalOnlyFile });
    return files;
  } catch (err) {
    if (isRecord(err) && err.code === "ENOENT") return {};
    throw err;
  }
}
