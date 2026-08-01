// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio coding agent's tool set — executed INSIDE the guest sandbox.
 *
 * Every tool operates on a real filesystem workspace (materialized by
 * `studio/session-init`) in the tenant's own container: a hostile regex, a
 * pathological diff, or a runaway `bash` command costs this sandbox's CPU
 * and nothing else — the Modal container is the isolation boundary, exactly
 * as it is for deployed agents' tools. That is why there is no host-side
 * scan worker anymore: the host never touches workspace content with CPU.
 *
 * `bash` is the Claude-Code-style escape hatch: the agent can run node,
 * install packages, and execute its own scripts with the same authority as
 * the rest of the sandboxed agent (open egress, filesystem) — and no more.
 * The one thing scrubbed from its environment is the control-channel
 * bearer token, so workspace code can't impersonate the host on a future
 * connection.
 *
 * `test_agent` builds IN THE GUEST through the aai CLI's own bundlers
 * (studio-build.ts — the toolchain's node_modules are baked next to the
 * harness) and then loads and trials the bundle locally via the harness's
 * own loader. One build path with `aai deploy`, exercised on every call.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { jsonSchema, type Tool, type ToolSet, tool } from "ai";
import picomatch from "picomatch";
import { z } from "zod";
import { withTimeout } from "./harness-rpc.ts";
import { MAX_STUDIO_FILE_BYTES, MAX_STUDIO_FILES } from "./limits.ts";
import { applyEdit, StudioEditError } from "./studio-edit.ts";
import { grepWorkspace, StudioGrepError } from "./studio-grep.ts";

/** Per-call deadline for every tool; bash carries its own tighter default. */
const TOOL_TIMEOUT_MS = 120_000;
/** Default and max wall-clock for one bash command. */
const BASH_TIMEOUT_MS = 60_000;
const BASH_TIMEOUT_MAX_MS = 300_000;
/** Output cap per stream; beyond it the tail is kept (errors print last). */
const BASH_OUTPUT_CAP = 16_000;
/** Directories never listed, grepped, or synced back to the workspace. */
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".aai"]);
/** read_file paging defaults — opencode's read-tool semantics. */
const READ_LIMIT = 2000;
const READ_MAX_LINE = 2000;
/** Max glob results before truncation. */
const GLOB_LIMIT = 100;

/**
 * User-friendly labels for every studio tool, web builtins included —
 * served to the browser via the chat surface's `GET /studio/tools` so the
 * UI never shows a raw snake_case tool name. One map, guest-side, because
 * the guest is where the tool set is defined.
 */
export const STUDIO_TOOL_LABELS: Readonly<Record<string, string>> = {
  list_files: "List files",
  read_file: "Read file",
  write_file: "Write file",
  edit_file: "Edit file",
  delete_file: "Delete file",
  grep: "Search code",
  glob: "Find files",
  bash: "Run command",
  todo_write: "Update plan",
  test_agent: "Test agent",
  web_search: "Search the web",
  visit_webpage: "Read webpage",
  get_page_design: "Study page design",
};

export type StudioToolDeps = {
  /** Absolute workspace root the session materialized. */
  dir: string;
  /** Build the session workspace into a worker bundle, in this sandbox. */
  build: () => Promise<{ worker?: string; buildError?: string }>;
  /** Load a built worker bundle into this harness; returns its config. */
  loadBundle: (code: string) => Promise<{ config?: unknown }>;
  /** Trial-run one tool of the loaded bundle. */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
};

/** Resolve a workspace-relative path, refusing escapes from the root. */
function resolveInside(dir: string, rel: string): string {
  const abs = path.resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) {
    throw new Error(`Path escapes the workspace: ${rel}`);
  }
  return abs;
}

/**
 * Numbered, windowed file view (ported shape from opencode's read tool):
 * `NNNNN| line`, with offset/limit paging and per-line length truncation, so
 * a large or generated file costs a bounded number of tokens per read.
 */
function windowedRead(content: string, offset = 1, limit = READ_LIMIT): string {
  const lines = content.split("\n");
  const start = Math.max(1, Math.floor(offset));
  const count = Math.max(1, Math.min(Math.floor(limit), READ_LIMIT));
  const window = lines.slice(start - 1, start - 1 + count);
  const body = window
    .map((line, i) => {
      const text =
        line.length > READ_MAX_LINE ? `${line.slice(0, READ_MAX_LINE)}... (line truncated)` : line;
      return `${String(start + i).padStart(5, "0")}| ${text}`;
    })
    .join("\n");
  const end = start - 1 + window.length;
  const note =
    end < lines.length
      ? `\n\n(${lines.length - end} more lines — pass offset: ${end + 1} to continue)`
      : "";
  return body + note;
}

/** Workspace-relative paths of all non-ignored files under `dir`. */
async function walkWorkspace(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(path.join(current, entry.name));
        continue;
      }
      if (entry.isFile()) out.push(path.relative(dir, path.join(current, entry.name)));
    }
  }
  await walk(dir);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Snapshot the workspace as a path→content record — the shape builds, grep,
 * and the host sync speak. Files over the store's byte cap are skipped with
 * a warning entry so a `bash`-generated artifact can't wedge every sync.
 */
export async function snapshotWorkspace(
  dir: string,
): Promise<{ files: Record<string, string>; warnings: string[] }> {
  const files: Record<string, string> = {};
  const warnings: string[] = [];
  const paths = await walkWorkspace(dir);
  if (paths.length > MAX_STUDIO_FILES) {
    warnings.push(
      `Workspace has ${paths.length} files; only the first ${MAX_STUDIO_FILES} sync to the project ` +
        "(delete extras, and keep generated artifacts out of the workspace root).",
    );
  }
  for (const rel of paths.slice(0, MAX_STUDIO_FILES)) {
    const st = await stat(path.join(dir, rel));
    if (st.size > MAX_STUDIO_FILE_BYTES) {
      warnings.push(`${rel} is ${st.size} bytes (max ${MAX_STUDIO_FILE_BYTES}) — not synced.`);
      continue;
    }
    files[rel] = await readFile(path.join(dir, rel), "utf-8");
  }
  return { files, warnings };
}

/** Materialize a files record into `dir`, replacing whatever was there. */
export async function materializeWorkspace(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolveInside(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
}

const keepTail = (text: string): string =>
  text.length > BASH_OUTPUT_CAP ? `…${text.slice(-BASH_OUTPUT_CAP)}` : text;

/** Run one bash command in the workspace; the token never enters its env. */
function runBash(
  dir: string,
  command: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string }> {
  const env = { ...process.env };
  delete env.AAI_GUEST_TOKEN;
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], { cwd: dir, env, timeout: timeoutMs });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out = keepTail(out + chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out = keepTail(out + chunk.toString());
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        exitCode: code,
        output: signal ? `${out}\n[killed by ${signal} after ${timeoutMs}ms]` : out,
      });
    });
  });
}

const TodoItemSchema = z.object({
  content: z.string().describe("The step, specific and actionable"),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
});

const TODO_MARKS = { pending: "[ ]", in_progress: "[>]", completed: "[x]", cancelled: "[-]" };

function renderTodos(todos: z.infer<typeof TodoItemSchema>[]): string {
  if (todos.length === 0) return "(empty todo list)";
  const remaining = todos.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  ).length;
  return `${todos.map((t) => `${TODO_MARKS[t.status]} ${t.content}`).join("\n")}\n\n${remaining} remaining`;
}

/** Summarize a loaded bundle's self-described config without server schemas. */
function describeConfig(config: unknown): { summary: string; toolNames: string[] } {
  const cfg = (config ?? {}) as {
    name?: unknown;
    mode?: unknown;
    toolSchemas?: { name?: unknown }[];
  };
  const toolNames = Array.isArray(cfg.toolSchemas)
    ? cfg.toolSchemas.map((schema) => String(schema?.name ?? "")).filter(Boolean)
    : [];
  const name = typeof cfg.name === "string" ? cfg.name : "(unnamed)";
  const mode = cfg.mode === "pipeline" ? "pipeline" : "s2s";
  const summary =
    `Bundle loaded in the sandbox. Agent "${name}" (${mode} mode), ` +
    `tools: ${toolNames.length > 0 ? toolNames.join(", ") : "(none)"}.`;
  return { summary, toolNames };
}

/** Wrap `execute` in the shared per-call deadline. */
function deadline(t: ToolSet[string]): ToolSet[string] {
  const execute = t.execute;
  if (!execute) return t;
  const wrapped: Tool["execute"] = (args, opts) =>
    withTimeout(Promise.resolve(execute(args as never, opts)), TOOL_TIMEOUT_MS, "Tool call").catch(
      (err: unknown) => `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  return { ...t, execute: wrapped } as ToolSet[string];
}

/** Build the coding agent's workspace tool set over the session dir. */
export function createStudioTools(deps: StudioToolDeps): ToolSet {
  const { dir } = deps;
  const raw: ToolSet = {
    list_files: tool({
      description: "List the files in the project workspace",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => {
        const paths = await walkWorkspace(dir);
        return paths.length > 0 ? paths.join("\n") : "(empty workspace)";
      },
    }),
    read_file: tool({
      description:
        "Read a file from the project workspace. Returns numbered lines; " +
        "use offset/limit to page through large files.",
      inputSchema: z.object({
        path: z.string().describe("Workspace-relative path"),
        offset: z.number().optional().describe("1-indexed line to start reading from"),
        limit: z.number().optional().describe(`Max lines to read (default ${READ_LIMIT})`),
      }),
      execute: async ({ path: rel, offset, limit }) => {
        let content: string;
        try {
          content = await readFile(resolveInside(dir, rel), "utf-8");
        } catch {
          return `Error: no such file: ${rel}`;
        }
        return windowedRead(content, offset, limit);
      },
    }),
    glob: tool({
      description:
        "Find workspace files matching a glob pattern (e.g. **/*.ts), newest " +
        "first. Use this to locate files by name; use grep to search contents.",
      inputSchema: z.object({
        pattern: z.string().describe("The glob pattern to match files against"),
      }),
      execute: async ({ pattern }) => {
        let match: (p: string) => boolean;
        try {
          match = picomatch(pattern, { dot: true });
        } catch (err) {
          return `Error: invalid glob: ${err instanceof Error ? err.message : String(err)}`;
        }
        // Not `.filter(match)`: filter's index argument would land in
        // picomatch's `returnObject` parameter and match everything.
        const paths = (await walkWorkspace(dir)).filter((p) => match(p));
        if (paths.length === 0) return "No files found";
        const withMtime = await Promise.all(
          paths.map(async (rel) => ({ rel, mtime: (await stat(path.join(dir, rel))).mtimeMs })),
        );
        withMtime.sort((a, b) => b.mtime - a.mtime);
        const shown = withMtime.slice(0, GLOB_LIMIT).map((f) => f.rel);
        const truncated =
          withMtime.length > GLOB_LIMIT ? `\n(truncated: first ${GLOB_LIMIT} shown)` : "";
        return shown.join("\n") + truncated;
      },
    }),
    write_file: tool({
      description:
        "Create a new file, or fully replace one. For edits to an existing " +
        "file prefer edit_file.",
      inputSchema: z.object({
        path: z.string().describe("Workspace-relative path"),
        content: z.string().describe("Full new file contents"),
      }),
      execute: async ({ path: rel, content }) => {
        const abs = resolveInside(dir, rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf-8");
        return `Wrote ${rel} (${content.length} bytes)`;
      },
    }),
    edit_file: tool({
      description:
        "Replace an exact snippet in a workspace file. Prefer this over " +
        "write_file for changes to an existing file. oldText must appear " +
        "exactly once; include surrounding lines if it would otherwise be " +
        "ambiguous, or set replaceAll to change every occurrence. Returns a " +
        "diff of what changed.",
      inputSchema: z.object({
        path: z.string().describe("Workspace-relative path"),
        oldText: z.string().describe("Exact text to replace; must be unique in the file"),
        newText: z.string().describe("Replacement text"),
        replaceAll: z
          .boolean()
          .optional()
          .describe("Replace every occurrence of oldText instead of requiring a unique match"),
      }),
      execute: async ({ path: rel, oldText, newText, replaceAll }) => {
        const abs = resolveInside(dir, rel);
        let current: string;
        try {
          current = await readFile(abs, "utf-8");
        } catch {
          return `Error: no such file: ${rel}`;
        }
        try {
          const { content, diff, replacements } = applyEdit(rel, current, oldText, newText, {
            replaceAll,
          });
          await writeFile(abs, content, "utf-8");
          const label = replacements === 1 ? "" : ` (${replacements} replacements)`;
          return `Edited ${rel}${label}\n\n${diff}`;
        } catch (err) {
          if (err instanceof StudioEditError) return `Error: ${err.message}`;
          throw err;
        }
      },
    }),
    delete_file: tool({
      description: "Delete a file from the project workspace",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path: rel }) => {
        const abs = resolveInside(dir, rel);
        try {
          await stat(abs);
        } catch {
          return `Error: no such file: ${rel}`;
        }
        await rm(abs, { force: true });
        return `Deleted ${rel}`;
      },
    }),
    grep: tool({
      description:
        "Search file contents across the workspace. Returns `path:line: text` " +
        "for each match. Cheaper than reading whole files to find where " +
        "something is defined.",
      inputSchema: z.object({
        pattern: z.string().describe("Regex, or plain text when literal is true"),
        glob: z.string().optional().describe("Only search paths matching this glob, e.g. *.ts"),
        literal: z.boolean().optional().describe("Match the pattern as plain text"),
        ignoreCase: z.boolean().optional(),
        context: z.number().optional().describe("Lines of context around each match"),
        limit: z.number().optional().describe("Max matches (default 100)"),
      }),
      execute: async ({ pattern, ...opts }) => {
        const { files } = await snapshotWorkspace(dir);
        try {
          return grepWorkspace(files, pattern, opts);
        } catch (err) {
          if (err instanceof StudioGrepError) return `Error: ${err.message}`;
          throw err;
        }
      },
    }),
    bash: tool({
      description:
        "Run a bash command in the workspace directory (network access " +
        "available). Use it to run node scripts, install packages, or " +
        "inspect files. Output is capped; long-running commands are killed " +
        "at the timeout.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to run"),
        timeoutMs: z
          .number()
          .optional()
          .describe(
            `Wall-clock limit in ms (default ${BASH_TIMEOUT_MS}, max ${BASH_TIMEOUT_MAX_MS})`,
          ),
      }),
      execute: async ({ command, timeoutMs }) => {
        const limit = Math.min(Math.max(timeoutMs ?? BASH_TIMEOUT_MS, 1000), BASH_TIMEOUT_MAX_MS);
        try {
          const { exitCode, output } = await runBash(dir, command, limit);
          const body = output.trim() || "(no output)";
          return exitCode === 0 ? body : `[exit code ${exitCode}]\n${body}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
    todo_write: tool({
      description:
        "Replace your todo list for the current request. Use it for " +
        "multi-step work so no step gets dropped: write the steps up front, " +
        "then resend the full list as statuses change. Keep exactly one item " +
        "in_progress at a time. Skip it for single-step changes and questions.",
      inputSchema: z.object({
        todos: z
          .array(TodoItemSchema)
          .describe("The complete updated todo list; replaces the previous list"),
      }),
      execute: async ({ todos }) => renderTodos(todos),
    }),
    test_agent: tool({
      description:
        "Build the workspace and load it into the production agent runtime. " +
        "Reports build errors, load errors, and the agent config. Pass " +
        "`tool` and `args` to also invoke one of the agent's tools with " +
        "sample arguments and see its result. Secrets are NOT available in " +
        "test runs (ctx.env is empty); ctx.db is unavailable.",
      inputSchema: z.object({
        tool: z.string().optional().describe("Name of an agent tool to invoke after loading"),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments for the invoked tool"),
      }),
      execute: async ({ tool: trialTool, args }) => {
        const built = await deps.build();
        if (built.buildError) return built.buildError;
        if (!built.worker) return "Error: build returned no worker bundle";
        let loaded: { config?: unknown };
        try {
          loaded = await deps.loadBundle(built.worker);
        } catch (err) {
          return `Bundle failed to load: ${err instanceof Error ? err.message : String(err)}`;
        }
        const { summary, toolNames } = describeConfig(loaded.config);
        if (!trialTool) return summary;
        if (!toolNames.includes(trialTool)) {
          return `${summary}\nCannot invoke "${trialTool}": not one of the agent's tools.`;
        }
        const output = await deps.executeTool(trialTool, args ?? {});
        return `${summary}\n${trialTool}(${JSON.stringify(args ?? {})}) → ${output}`;
      },
    }),
  };

  const out: ToolSet = {};
  for (const [name, t] of Object.entries(raw)) out[name] = deadline(t);
  return out;
}
