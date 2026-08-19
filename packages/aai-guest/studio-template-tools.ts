// Copyright 2026 the AAI authors. MIT license.
/**
 * Template tools for the studio coding agent — `list_templates` and
 * `use_template`, executed INSIDE the guest sandbox like every studio tool.
 *
 * The templates are the worked example agents bundled into the aai CLI's
 * tarball (`@alexkroman1/aai-cli/dist/templates`, the same set `aai init`
 * scaffolds), resolved from the toolchain `node_modules` baked next to the
 * harness. Before these tools the prompt pointed the agent at that directory
 * with `bash` — which works, but ends with the agent retyping hundreds of
 * lines through write_file, paying tokens and typo risk for code that
 * already exists byte-perfect on disk. `use_template` copies the files
 * directly into the workspace instead, so template code arrives verbatim
 * and syncs back to the project exactly like the agent's own edits.
 *
 * Copies respect the same workspace invariants as write_file: nothing lands
 * outside the workspace root (`resolveInside`), existing files are never
 * clobbered without `overwrite: true`, the store's file-count and byte caps
 * are checked before anything is written, and the post-copy result carries
 * the workspace's type errors the way a write's result does.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { errorMessage, type ToolDef, tool } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { MAX_STUDIO_FILE_BYTES, MAX_STUDIO_FILES } from "./limits.ts";
import { toolchainModules } from "./studio-build.ts";
import { isScriptFile } from "./studio-syntax.ts";
import { STUDIO_TOOL_DESCRIPTIONS } from "./studio-tool-descriptions.ts";
import { resolveInside, walkWorkspace, writeFileWithParents } from "./studio-workspace-fs.ts";
import type { PostWriteDiagnostics } from "./studio-write-diagnostics.ts";

/**
 * The bundled templates directory in the baked toolchain, or null when the
 * toolchain (and therefore the CLI package carrying the templates) is not
 * resolvable in this sandbox. Same degrade-to-absent posture as
 * `toolchainPromptSection`: never name a path that does not resolve.
 */
export function bundledTemplatesRoot(): string | null {
  const modules = toolchainModules();
  return modules === null
    ? null
    : path.join(modules, "@alexkroman1", "aai-cli", "dist", "templates");
}

const NO_TEMPLATES = "Error: no templates are available in this sandbox (toolchain not resolvable)";

/** Sorted template names under `root` — directories only. */
async function templateNames(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Template-relative paths of one template's files (recursive, sorted). */
async function templateFilePaths(templateDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) out.push(path.relative(templateDir, abs));
    }
  }
  await walk(templateDir);
  return out.sort((a, b) => a.localeCompare(b));
}

/** The agent's display name from a template's agent.ts, when extractable. */
function displayName(agentSource: string): string | null {
  const match = agentSource.match(/\bname:\s*["'`]([^"'`]+)["'`]/);
  return match?.[1] ?? null;
}

/** One `- name ("Display"): file, file` listing line per template. */
async function templateListing(root: string, names: string[]): Promise<string> {
  const lines = await Promise.all(
    names.map(async (name) => {
      const files = await templateFilePaths(path.join(root, name));
      let label = "";
      if (files.includes("agent.ts")) {
        const source = await readFile(path.join(root, name, "agent.ts"), "utf-8");
        const display = displayName(source);
        if (display) label = ` ("${display}")`;
      }
      return `- ${name}${label}: ${files.join(", ")}`;
    }),
  );
  return lines.join("\n");
}

type TemplateEntry = { rel: string; content: string };

/** Read the selected template files, skipping ones the sync cap refuses. */
async function readTemplateEntries(
  templateDir: string,
  selected: string[],
): Promise<{ entries: TemplateEntry[]; skipped: string[] }> {
  const skipped: string[] = [];
  const entries: TemplateEntry[] = [];
  for (const rel of selected) {
    const abs = path.join(templateDir, rel);
    const size = (await stat(abs)).size;
    if (size > MAX_STUDIO_FILE_BYTES) {
      skipped.push(`${rel} (${size} bytes — over the ${MAX_STUDIO_FILE_BYTES} sync cap)`);
      continue;
    }
    entries.push({ rel, content: await readFile(abs, "utf-8") });
  }
  return { entries, skipped };
}

/**
 * Classify template entries against the current workspace BEFORE anything
 * is written, so a refused copy leaves the workspace untouched.
 */
async function classifyAgainstWorkspace(
  dir: string,
  entries: TemplateEntry[],
  overwrite: boolean,
): Promise<{
  existing: Set<string>;
  conflicts: string[];
  unchanged: string[];
  writes: TemplateEntry[];
}> {
  const existing = new Set(await walkWorkspace(dir));
  const conflicts: string[] = [];
  const unchanged: string[] = [];
  const writes: TemplateEntry[] = [];
  for (const entry of entries) {
    if (!existing.has(entry.rel)) {
      writes.push(entry);
      continue;
    }
    const current = await readFile(resolveInside(dir, entry.rel), "utf-8").catch(() => null);
    if (current === entry.content) unchanged.push(entry.rel);
    else if (overwrite) writes.push(entry);
    else conflicts.push(entry.rel);
  }
  return { existing, conflicts, unchanged, writes };
}

/** The tool result for a copy that went through. */
function formatCopyResult(
  template: string,
  written: string[],
  unchanged: string[],
  skipped: string[],
): string {
  const parts = [
    written.length > 0
      ? `Copied ${written.length} file(s) from template "${template}": ${written.join(", ")}`
      : `Nothing to copy from template "${template}"`,
  ];
  if (unchanged.length > 0) parts.push(`Already present and identical: ${unchanged.join(", ")}`);
  if (skipped.length > 0) parts.push(`Skipped: ${skipped.join(", ")}`);
  if (written.length > 0) {
    parts.push(
      "The files are a working starting point — read them, then adapt names, prompts, and tools to the request with edit_file.",
    );
  }
  return parts.join("\n");
}

type UseTemplateArgs = { template: string; files?: string[]; overwrite?: boolean };

/** The whole use_template flow: validate → read → classify → write. */
async function copyTemplate(
  dir: string,
  root: string,
  { template, files: wanted, overwrite }: UseTemplateArgs,
): Promise<{ result: string; written: string[] }> {
  const names = await templateNames(root);
  // Membership in the real directory listing is the validation — a
  // traversal like "../x" can never match a readdir entry.
  if (!names.includes(template)) {
    return {
      result: `Error: unknown template "${template}". Available: ${names.join(", ")}`,
      written: [],
    };
  }
  const templateDir = path.join(root, template);
  const available = await templateFilePaths(templateDir);
  const unknown = (wanted ?? []).filter((rel) => !available.includes(rel));
  if (unknown.length > 0) {
    return {
      result: `Error: template "${template}" has no file ${unknown.join(", ")}. Its files: ${available.join(", ")}`,
      written: [],
    };
  }
  const selected = wanted && wanted.length > 0 ? wanted : available;

  const { entries, skipped } = await readTemplateEntries(templateDir, selected);
  const { existing, conflicts, unchanged, writes } = await classifyAgainstWorkspace(
    dir,
    entries,
    overwrite === true,
  );
  if (conflicts.length > 0) {
    return {
      result:
        `Error: the workspace already has ${conflicts.join(", ")} with different contents. ` +
        "Pass overwrite: true to replace them, or copy a subset with files: [...]",
      written: [],
    };
  }
  const newFiles = writes.filter((w) => !existing.has(w.rel)).length;
  if (existing.size + newFiles > MAX_STUDIO_FILES) {
    return {
      result:
        `Error: copying would put the workspace at ${existing.size + newFiles} files ` +
        `(max ${MAX_STUDIO_FILES}) — delete files you no longer need first`,
      written: [],
    };
  }

  await Promise.all(
    writes.map(({ rel, content }) => writeFileWithParents(resolveInside(dir, rel), content)),
  );

  const written = writes.map((w) => w.rel);
  return { result: formatCopyResult(template, written, unchanged, skipped), written };
}

export type TemplateToolDeps = {
  /** Absolute workspace root the session materialized. */
  dir: string;
  /** The shared post-write checker — same instance the write tools use. */
  diagnostics: PostWriteDiagnostics;
  /** Test seam. Defaults to the baked toolchain's bundled templates. */
  templatesRoot?: string | null;
};

/** Build the template tools over the session workspace. */
export function createTemplateTools(deps: TemplateToolDeps): Record<string, ToolDef> {
  const { dir, diagnostics: postWriteDiagnostics } = deps;
  // `?? null` would collapse a deliberate null (no toolchain) into the
  // default, so the seam distinguishes "absent" from "explicitly none".
  const root = "templatesRoot" in deps ? (deps.templatesRoot ?? null) : bundledTemplatesRoot();

  return {
    list_templates: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.list_templates,
      inputSchema: z.object({}),
      execute: async () => {
        if (root === null) return NO_TEMPLATES;
        let names: string[];
        try {
          names = await templateNames(root);
        } catch (err) {
          return `Error: templates directory is unreadable: ${errorMessage(err)}`;
        }
        if (names.length === 0) return "No templates found";
        const listing = await templateListing(root, names);
        return `${listing}\n\nCopy one into the workspace with use_template — the files arrive verbatim and sync to the project like your own edits.`;
      },
    }),
    use_template: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.use_template,
      inputSchema: z.object({
        template: z.string().describe("Template name, as reported by list_templates"),
        files: z
          .array(z.string())
          .optional()
          .describe("Copy only these template files (default: every file)"),
        overwrite: z
          .boolean()
          .optional()
          .describe("Replace workspace files that already exist (default: refuse)"),
      }),
      execute: async ({ template, files, overwrite }) => {
        if (root === null) return NO_TEMPLATES;
        let copied: { result: string; written: string[] };
        try {
          copied = await copyTemplate(dir, root, {
            template,
            ...omitUndefined({ files, overwrite }),
          });
        } catch (err) {
          return `Error: ${errorMessage(err)}`;
        }
        const checked = copied.written.find((rel) => isScriptFile(rel));
        const diagnostics = checked ? await postWriteDiagnostics(checked) : undefined;
        return copied.result + (diagnostics ?? "");
      },
    }),
  };
}
