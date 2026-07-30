// Copyright 2026 the AAI authors. MIT license.
/**
 * Filesystem authoring conventions — the discovery half.
 *
 * An agent directory may declare parts of its definition as conventional
 * files next to `agent.ts` (see `applyAgentConventions` in
 * `@alexkroman1/aai/manifest` for the merge half and the full contract):
 *
 * - `instructions.md` — the system prompt
 * - `tools/<name>.ts` — one tool per file, default-exporting `tool({...})`
 * - `skills/<name>.md` — on-demand procedures, exposed as `skill_<name>` tools
 *
 * This module scans the directory and generates the entry module that both
 * bundlers build instead of `agent.ts` when convention files exist. The
 * generated entry imports `agent.ts` and every discovered file, then merges
 * them with `applyAgentConventions` — so the merge runs inside the bundle
 * and the exported default is always the *composed* definition, whether the
 * bundle is evaluated by `aai dev`, the deploy eval, or the guest sandbox
 * (the studio's `bundle/load` config extraction included).
 *
 * Both bundlers hook it in the same way: a plugin redirects any resolution
 * of `agent.ts` to the generated entry (`CONVENTIONS_ENTRY_ID`). Redirecting
 * the *import* rather than swapping the build input is what makes the studio
 * work unchanged — its wrapper entry imports `./agent.ts` and must see the
 * composed definition, or `toAgentConfig` would extract a config missing
 * every convention file.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Virtual module id for the generated composing entry. */
export const CONVENTIONS_ENTRY_ID = "\0aai-conventions-entry.ts";

/** Convention files discovered next to `agent.ts` (absolute paths). */
export type DiscoveredConventions = {
  instructionsPath?: string;
  toolFiles: { name: string; path: string }[];
  skillFiles: { name: string; path: string }[];
};

/** Mirrors the merge-side rule — see VALID_CONVENTION_NAME in sdk/conventions.ts. */
const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

/** Non-tool files allowed to live in `tools/` without becoming tools. */
function isToolModuleFile(basename: string): boolean {
  if (!basename.endsWith(".ts")) return false;
  if (basename.startsWith("_") || basename.startsWith(".")) return false;
  return !/\.(test|test-d|spec|d)\.ts$/.test(basename);
}

function isSkillFile(basename: string): boolean {
  return basename.endsWith(".md") && !basename.startsWith("_") && !basename.startsWith(".");
}

async function listDir(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // no such directory — the convention simply isn't used
  }
}

async function fileExists(p: string): Promise<boolean> {
  return await fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

function assertValidName(name: string, rel: string): void {
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `Invalid convention filename ${rel} — names may only use letters, digits, "_" and "-".`,
    );
  }
}

/**
 * Scan `cwd` for convention files. Returns `null` when the directory uses
 * none of them (or has no `agent.ts` to compose them onto), so callers can
 * skip the generated entry entirely and build `agent.ts` as before.
 */
export async function discoverConventions(cwd: string): Promise<DiscoveredConventions | null> {
  if (!(await fileExists(path.join(cwd, "agent.ts")))) return null;

  const instructionsPath = path.join(cwd, "instructions.md");
  const hasInstructions = await fileExists(instructionsPath);

  const toolFiles = (await listDir(path.join(cwd, "tools"))).filter(isToolModuleFile).map((f) => {
    const name = f.slice(0, -".ts".length);
    assertValidName(name, `tools/${f}`);
    return { name, path: path.join(cwd, "tools", f) };
  });

  const skillFiles = (await listDir(path.join(cwd, "skills"))).filter(isSkillFile).map((f) => {
    const name = f.slice(0, -".md".length);
    assertValidName(name, `skills/${f}`);
    return { name, path: path.join(cwd, "skills", f) };
  });

  if (!hasInstructions && toolFiles.length === 0 && skillFiles.length === 0) return null;
  return { ...(hasInstructions ? { instructionsPath } : {}), toolFiles, skillFiles };
}

/**
 * Generate the composing entry module. Markdown imports rely on the raw-md
 * plugin both bundlers already carry for `import prompt from "./x.md"`.
 */
export function generateConventionsEntry(agentPath: string, conv: DiscoveredConventions): string {
  const lines = [
    `import { applyAgentConventions } from "@alexkroman1/aai/manifest";`,
    `import __agent from ${JSON.stringify(agentPath)};`,
  ];
  if (conv.instructionsPath) {
    lines.push(`import __instructions from ${JSON.stringify(conv.instructionsPath)};`);
  }
  conv.toolFiles.forEach(({ path: p }, i) => {
    // Namespace import, not a default import: a tool file that forgot its
    // `export default` must reach applyAgentConventions (which names the
    // file in its error) instead of dying in the bundler with a bare
    // "no matching export" diagnostic.
    lines.push(`import * as __tool_${i} from ${JSON.stringify(p)};`);
  });
  conv.skillFiles.forEach(({ path: p }, i) => {
    lines.push(`import __skill_${i} from ${JSON.stringify(p)};`);
  });

  const toolEntries = conv.toolFiles
    .map(({ name }, i) => `${JSON.stringify(name)}: __tool_${i}.default`)
    .join(", ");
  const skillEntries = conv.skillFiles
    .map(({ name }, i) => `${JSON.stringify(name)}: __skill_${i}`)
    .join(", ");

  lines.push(
    "export default applyAgentConventions(__agent, {",
    ...(conv.instructionsPath ? ["  instructions: __instructions,"] : []),
    `  tools: { ${toolEntries} },`,
    `  skills: { ${skillEntries} },`,
    "});",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * True when a module request should be redirected to the generated entry:
 * any resolution landing on `agent.ts` — the build input itself (absolute,
 * no importer) or a relative/absolute import of it (the studio's wrapper
 * entry does `import def from "./agent.ts"`). Imports *from* the generated
 * entry are exempt or the redirect would recurse.
 */
export function redirectsToAgentEntry(
  source: string,
  importer: string | undefined,
  agentPath: string,
): boolean {
  if (importer === CONVENTIONS_ENTRY_ID) return false;
  let abs: string;
  if (path.isAbsolute(source)) {
    abs = source;
  } else if (source.startsWith(".") && importer) {
    abs = path.resolve(path.dirname(importer), source);
  } else {
    return false;
  }
  return abs === agentPath || `${abs}.ts` === agentPath;
}
