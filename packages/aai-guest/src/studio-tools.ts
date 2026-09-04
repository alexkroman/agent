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

import type { Stats } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage, type ToolDef, tool } from "@alexkroman1/aai";
import picomatch from "picomatch";
import { z } from "zod";
import type { HarnessBundleAccess } from "./harness-types.ts";
import { MAX_STUDIO_FILE_BYTES } from "./limits.ts";
import { applyEdit, clearEditMisses, rewriteHint, StudioEditError } from "./studio-edit.ts";
import { globMatcher, grepWorkspace, StudioGrepError } from "./studio-grep.ts";
import { outputWithKillNote, runCapped, workspaceChildEnv } from "./studio-spawn.ts";
import { formatRejection, syntaxError } from "./studio-syntax.ts";
import { formatTestRun, runWorkspaceTests } from "./studio-test.ts";
import {
  BASH_TIMEOUT_MAX_MS,
  BASH_TIMEOUT_MS,
  GLOB_LIMIT,
  READ_LIMIT,
  STUDIO_TOOL_DESCRIPTIONS,
} from "./studio-tool-descriptions.ts";
import { resolveInside, walkWorkspace, writeFileWithParents } from "./studio-workspace-fs.ts";
import type { PostWriteDiagnostics } from "./studio-write-diagnostics.ts";

/** Output cap per stream; beyond it the tail is kept (errors print last). */
const BASH_OUTPUT_CAP = 16_000;
/** Per-line length cap for read_file's windowed view. */
const READ_MAX_LINE = 2000;

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
  npm_info: "Look up package",
  add_dependency: "Add dependency",
  remove_dependency: "Remove dependency",
  update_dependencies: "Update dependencies",
  download_to_workspace: "Download file",
  list_templates: "List templates",
  use_template: "Use template",
  generate_design_inspiration: "Design inspiration",
  todo_write: "Update plan",
  read_logs: "Read agent logs",
  test_agent: "Test agent",
  web_search: "Search the web",
  visit_webpage: "Read webpage",
  get_page_design: "Study page design",
};

export type StudioToolDeps = HarnessBundleAccess & {
  /** Absolute workspace root the session materialized. */
  dir: string;
  /** The shared post-write checker — same instance the template tools use. */
  diagnostics: PostWriteDiagnostics;
  /** Build the session workspace into a worker bundle, in this sandbox. */
  build: () => Promise<{ worker?: string; buildError?: string }>;
};

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

/**
 * Read a workspace file, or null when it is not there.
 *
 * The resolve is INSIDE the catch on purpose: a path that escapes the
 * workspace reads to these tools as a file that is not there, which is the
 * answer `read_file` has always given (`write_file` lets the throw out, so the
 * executor turns a real escape into an error result the model cannot mistake
 * for a typo). The three tools that open a path by hand then answer with the
 * same prose sentence ({@link noSuchFile}), and the `try`/`catch` that decides
 * "missing" lives here rather than at each of them.
 */
async function readWorkspaceFile(dir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(resolveInside(dir, rel), "utf-8");
  } catch {
    return null;
  }
}

/** The answer every path-taking tool gives for a path that is not there. */
function noSuchFile(rel: string): string {
  return `Error: no such file: ${rel}`;
}

/** Run one bash command in the workspace; the token never enters its env. */
async function runBash(
  dir: string,
  command: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string }> {
  const result = await runCapped("bash", ["-c", command], {
    cwd: dir,
    env: workspaceChildEnv(),
    timeoutMs,
    cap: BASH_OUTPUT_CAP,
    combineStreams: true,
  });
  return { exitCode: result.exitCode, output: outputWithKillNote(result, timeoutMs) };
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

/**
 * Shown when a built agent turns out to be S2S.
 *
 * The preamble states the cascaded-pipeline default about as plainly as prose
 * can, and agents still shipped S2S in roughly one run in seven — a rule read
 * once at the top of a long turn loses to whatever the model reached for.
 * Since the pipeline-by-default flip, S2S can no longer happen by omission
 * (a provider-less agent gets the pipeline injected) — reaching S2S now means
 * the agent *wrote* `s2s: assemblyAIS2s()`, so the notice checks that the
 * request actually asked for it. It fires at the only moment the mistake is
 * visible and cheap: the agent has just seen its own config and has not yet
 * told the user it is done.
 *
 * It asks the agent to re-read the request rather than to switch, because S2S
 * is correct when it was asked for, and a nudge that overrode that would trade
 * one wrong mode for another.
 */
const S2S_NOTICE =
  "\nNote: this agent is S2S because it sets the s2s field. That is " +
  "right ONLY if the request asked for the voice agent API (or " +
  "speech-to-speech) by name. Re-read the request: if it did not, this is " +
  "the wrong mode — remove the s2s field (the default is the all-AssemblyAI " +
  "pipeline) and build again. If it did, S2S is correct and there is " +
  "nothing to change.";

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
  const isPipeline = cfg.mode === "pipeline";
  const summary =
    `Bundle loaded in the sandbox. Agent "${name}" (${isPipeline ? "pipeline" : "s2s"} mode), ` +
    `tools: ${toolNames.length > 0 ? toolNames.join(", ") : "(none)"}.` +
    (isPipeline ? "" : S2S_NOTICE);
  return { summary, toolNames };
}

/** Build the coding agent's workspace tool set over the session dir. */
export function createStudioTools(deps: StudioToolDeps): Record<string, ToolDef> {
  const { dir, diagnostics: postWriteDiagnostics } = deps;
  return {
    list_files: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.list_files,
      execute: async () => {
        const paths = await walkWorkspace(dir);
        return paths.length > 0 ? paths.join("\n") : "(empty workspace)";
      },
    }),
    read_file: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.read_file,
      inputSchema: z.object({
        path: z.string().describe("Workspace-relative path"),
        offset: z.number().optional().describe("1-indexed line to start reading from"),
        limit: z.number().optional().describe(`Max lines to read (default ${READ_LIMIT})`),
      }),
      execute: async ({ path: rel, offset, limit }) => {
        const content = await readWorkspaceFile(dir, rel);
        if (content === null) return noSuchFile(rel);
        return windowedRead(content, offset, limit);
      },
    }),
    glob: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.glob,
      inputSchema: z.object({
        pattern: z.string().describe("The glob pattern to match files against"),
      }),
      execute: async ({ pattern }) => {
        let match: (p: string) => boolean;
        try {
          match = picomatch(pattern, { dot: true });
        } catch (err) {
          return `Error: invalid glob: ${errorMessage(err)}`;
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
      description: STUDIO_TOOL_DESCRIPTIONS.write_file,
      inputSchema: z.object({
        path: z.string().describe("Workspace-relative path"),
        content: z.string().describe("Full new file contents"),
      }),
      execute: async ({ path: rel, content }) => {
        const abs = resolveInside(dir, rel);
        // Parse BEFORE persisting. A file that does not parse cannot be
        // edited back into shape by text matching, so writing it strands the
        // turn (see studio-syntax.ts).
        const bad = await syntaxError(dir, rel, content);
        if (bad !== undefined) return formatRejection(rel, bad);
        await writeFileWithParents(abs, content);
        clearEditMisses(rel);
        const diagnostics = await postWriteDiagnostics(rel);
        return `Wrote ${rel} (${content.length} bytes)${diagnostics ?? ""}`;
      },
    }),
    edit_file: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.edit_file,
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
        const current = await readWorkspaceFile(dir, rel);
        if (current === null) return noSuchFile(rel);
        try {
          const { content, diff, replacements } = applyEdit(rel, current, oldText, newText, {
            replaceAll,
          });
          const bad = await syntaxError(dir, rel, content);
          if (bad !== undefined) return formatRejection(rel, bad);
          await writeFile(abs, content, "utf-8");
          clearEditMisses(rel);
          const label = replacements === 1 ? "" : ` (${replacements} replacements)`;
          const diagnostics = await postWriteDiagnostics(rel);
          return `Edited ${rel}${label}\n\n${diff}${diagnostics ?? ""}`;
        } catch (err) {
          if (err instanceof StudioEditError) return `Error: ${err.message}${rewriteHint(rel)}`;
          throw err;
        }
      },
    }),
    delete_file: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.delete_file,
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path: rel }) => {
        const abs = resolveInside(dir, rel);
        let entry: Stats;
        try {
          entry = await stat(abs);
        } catch {
          return noSuchFile(rel);
        }
        // `stat` admits directories, and `rm` without `recursive` rejects one
        // with a raw `ERR_FS_EISDIR` — the only failure in this tool set that
        // escaped as a Node error where every neighbour answers in prose. It
        // stays a REFUSAL rather than becoming a recursive delete: this tool is
        // `delete_file`, the agent may have meant one file inside, and `bash`
        // is the deliberate escape hatch for the rest.
        if (entry.isDirectory()) {
          return (
            `Error: ${rel} is a directory, and delete_file removes one file. ` +
            "Delete the files inside it (list_files shows them), or use bash for the whole tree."
          );
        }
        try {
          await rm(abs, { force: true });
        } catch (err) {
          return `Error: could not delete ${rel}: ${errorMessage(err)}`;
        }
        return `Deleted ${rel}`;
      },
    }),
    grep: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.grep,
      inputSchema: z.object({
        pattern: z.string().describe("Regex, or plain text when literal is true"),
        glob: z.string().optional().describe("Only search paths matching this glob, e.g. *.ts"),
        literal: z.boolean().optional().describe("Match the pattern as plain text"),
        ignoreCase: z.boolean().optional(),
        context: z.number().optional().describe("Lines of context around each match"),
        limit: z.number().optional().describe("Max matches (default 100)"),
      }),
      execute: async ({ pattern, ...opts }) => {
        try {
          // Read only what the glob selects — a data or generated file the
          // filter excludes must not cost I/O and memory on every search.
          const filter = opts.glob ? globMatcher(opts.glob) : null;
          const paths = (await walkWorkspace(dir)).filter((p) => !filter || filter(p));
          const files: Record<string, string> = {};
          await Promise.all(
            paths.map(async (rel) => {
              const abs = path.join(dir, rel);
              const st = await stat(abs);
              // Oversized artifacts are never searched (nor synced).
              if (st.size > MAX_STUDIO_FILE_BYTES) return;
              files[rel] = await readFile(abs, "utf-8");
            }),
          );
          return grepWorkspace(files, pattern, opts);
        } catch (err) {
          if (err instanceof StudioGrepError) return `Error: ${err.message}`;
          throw err;
        }
      },
    }),
    bash: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.bash,
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
          return `Error: ${errorMessage(err)}`;
        }
      },
    }),
    todo_write: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.todo_write,
      inputSchema: z.object({
        todos: z
          .array(TodoItemSchema)
          .describe("The complete updated todo list; replaces the previous list"),
      }),
      execute: async ({ todos }) => renderTodos(todos),
    }),
    test_agent: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.test_agent,
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
          return `Bundle failed to load: ${errorMessage(err)}`;
        }
        const { summary, toolNames } = describeConfig(loaded.config);
        // Reported after the config rather than gating on it: a failing test
        // usually means the test and the agent drifted, which the agent can
        // only judge with the config in front of it.
        const tests = formatTestRun(await runWorkspaceTests(dir));
        const base = `${summary}\n${tests}`;
        if (!trialTool) return base;
        if (!toolNames.includes(trialTool)) {
          return `${base}\nCannot invoke "${trialTool}": not one of the agent's tools.`;
        }
        const output = await deps.executeTool(trialTool, args ?? {});
        return `${base}\n${trialTool}(${JSON.stringify(args ?? {})}) → ${output}`;
      },
    }),
  };
}
