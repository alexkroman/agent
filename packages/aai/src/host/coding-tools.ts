// Copyright 2026 the AAI authors. MIT license.
/**
 * A coding agent's workspace tool set: read, search, write, edit, delete, run.
 *
 * This is the tool half of an agent that edits code — the nine tools every such
 * agent turns out to need, over one directory, with no opinion about what the
 * code IS. It was the studio's coding agent and nothing else could reach it:
 * the tools lived in the guest harness (a private package), closed over that
 * session's workspace, and were tangled with the things only the studio wants —
 * a type-check after each write, an npm reifier, a bundle trial. What is here
 * is what survives deleting all of that, which is most of it.
 *
 * ## Every tool ANSWERS; none of them throws
 *
 * A missing file, a bad regex, a command that exits 1, an edit whose text is
 * not there — each is a sentence the model reads and can act on, because each
 * is a thing the model can FIX on its next step. The one deliberate exception
 * is a path that escapes the workspace: `write_file` lets that throw so the
 * executor turns it into an error result the model cannot mistake for a typo,
 * while `read_file` answers "no such file", which is the same answer it gives
 * for a path that is merely absent.
 *
 * ## What a HOST supplies, and why each seam exists
 *
 * - {@link CodingToolsOptions.validate} refuses a write before it lands. The
 *   studio parses the file and rejects one that does not parse: a file that
 *   cannot be parsed cannot be edited back into shape by text matching, so
 *   writing it strands the turn (observed: sixteen steps of read → edit →
 *   "could not find that text", no work produced).
 * - {@link CodingToolsOptions.afterWrite} appends to a SUCCESSFUL write. The
 *   studio type-checks the workspace and hands the errors back inside the write
 *   result that caused them, which is the cheap half of what a language server
 *   would do and where a repair round is actually saved.
 * - {@link CodingToolsOptions.env} is the `bash` child's environment. It
 *   defaults to this process's, which is right for a CLI-shaped host and wrong
 *   for a sandboxed one — there, hand it an allow-list, so a credential the
 *   host holds is out by construction rather than by remembering to subtract
 *   it.
 * - {@link CodingToolsOptions.descriptions} overrides the prose per tool, for
 *   the host that has something of its own to say (a build tool to run
 *   afterwards, a dependency tool to prefer over `npm install`).
 *
 * ## `bash` is the escape hatch, and it is exactly as trusted as the agent
 *
 * It runs whatever the model wrote with the authority of the process that
 * called this factory. That is the same authority the model's other tools have
 * — it can write a file and run it — so `bash` grants nothing new; what it does
 * is make the grant visible. Run a coding agent inside a container, and treat
 * the container as the boundary.
 */

import type { Stats } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { tool } from "../sdk/define.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import type { ToolDef } from "../sdk/tool-def.ts";
import { errorMessage } from "../sdk/utils.ts";
import { applyEdit, CodingEditError, clearEditMisses, rewriteHint } from "./coding-edit.ts";
import { CodingGrepError, globMatcher, grepWorkspace } from "./coding-grep.ts";
import { outputWithKillNote, runCapped } from "./coding-spawn.ts";
import {
  BASH_TIMEOUT_MAX_MS,
  BASH_TIMEOUT_MS,
  CODING_TOOL_DESCRIPTIONS,
  type CodingToolName,
  GLOB_LIMIT,
  READ_LIMIT,
} from "./coding-tool-descriptions.ts";
import {
  MAX_WORKSPACE_FILE_BYTES,
  resolveInside,
  walkWorkspaceFiles,
  writeFileWithParents,
} from "./workspace-files.ts";

/** Output cap per `bash` stream; beyond it the tail is kept (errors print last). */
const BASH_OUTPUT_CAP = 16_000;

/** Per-line length cap for `read_file`'s windowed view. */
const READ_MAX_LINE = 2000;

/**
 * What {@link createCodingTools} takes.
 *
 * Generic in the tool NAMES so the result is a record with literal keys rather
 * than an index signature: a `tools/read_file.ts` that default-exports
 * `codingTools.read_file` has to type-check as a `ToolDef`, and under
 * `noUncheckedIndexedAccess` a `Record<string, ToolDef>` hands back
 * `ToolDef | undefined`. Nothing has to name the parameter — it is inferred
 * from {@link CodingToolsOptions.only}, and defaults to every tool.
 */
export type CodingToolsOptions<N extends CodingToolName = CodingToolName> = {
  /** Absolute path of the workspace root. Nothing outside it is reachable. */
  dir: string;
  /**
   * Refuse a write before it lands: answer a message to REJECT the content, or
   * undefined to let it through. The message is returned to the model verbatim,
   * so say what to do about it and not only what is wrong.
   */
  validate?: (rel: string, content: string) => Promise<string | undefined>;
  /**
   * Text appended to a successful `write_file` / `edit_file` result — the seam
   * a host hangs diagnostics on. Answer undefined when there is nothing to add.
   */
  afterWrite?: (rel: string) => Promise<string | undefined>;
  /** The `bash` child's environment. Defaults to this process's own. */
  env?: NodeJS.ProcessEnv;
  /** Per-tool description overrides, merged over {@link CODING_TOOL_DESCRIPTIONS}. */
  descriptions?: Partial<Record<CodingToolName, string>>;
  /**
   * Build only these tools. Defaults to all nine.
   *
   * A host that has a better tool of its own for one of these jobs names the
   * rest here, rather than building the full set and deleting a key — which
   * reads as an accident at the call site and cannot be type-checked.
   */
  only?: readonly N[];
};

/**
 * Numbered, windowed file view (ported shape from opencode's read tool):
 * `NNNNN| line`, with offset/limit paging and per-line length truncation, so a
 * large or generated file costs a bounded number of tokens per read.
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
 * The resolve is INSIDE the catch on purpose: a path that escapes the workspace
 * reads to these tools as a file that is not there, which is the answer
 * `read_file` has always given. The tools that open a path by hand then answer
 * with the same prose sentence ({@link noSuchFile}), and the `try`/`catch` that
 * decides "missing" lives here rather than at each of them.
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
 * Build a coding agent's tool set over one directory.
 *
 * The result is keyed by the name the model calls, so it goes onto a definition
 * through `withTools` (a resolved registry) rather than through `tools/` files:
 * every tool here closes over THIS workspace, and a host serving more than one
 * builds the set per workspace for exactly that reason.
 */
export function createCodingTools<const N extends CodingToolName = CodingToolName>(
  options: CodingToolsOptions<N>,
): Record<N, ToolDef> {
  const { dir, validate, afterWrite } = options;
  const describe = { ...CODING_TOOL_DESCRIPTIONS, ...options.descriptions };
  /** The suffix a write result carries, or "" — one spelling for both writers. */
  const written = async (rel: string): Promise<string> => (await afterWrite?.(rel)) ?? "";

  const all: Record<CodingToolName, ToolDef> = {
    list_files: tool({
      description: describe.list_files,
      execute: async () => {
        const paths = await walkWorkspaceFiles(dir);
        return paths.length > 0 ? paths.join("\n") : "(empty workspace)";
      },
    }),
    read_file: tool({
      description: describe.read_file,
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
      description: describe.glob,
      inputSchema: z.object({
        pattern: z.string().describe("The glob pattern to match files against"),
      }),
      execute: async ({ pattern }) => {
        let match: (p: string) => boolean;
        try {
          match = globMatcher(pattern);
        } catch (err) {
          return `Error: ${errorMessage(err)}`;
        }
        // Not `.filter(match)`: filter's index argument would land in
        // picomatch's `returnObject` parameter and match everything.
        const paths = (await walkWorkspaceFiles(dir)).filter((p) => match(p));
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
    grep: tool({
      description: describe.grep,
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
          // `glob` is consumed HERE and not forwarded: `grepWorkspace` would
          // otherwise compile the identical matcher a second time and re-test
          // every path that has already passed this filter.
          const { glob, ...searchOpts } = opts;
          const filter = glob ? globMatcher(glob) : null;
          const paths = (await walkWorkspaceFiles(dir)).filter((p) => !filter || filter(p));
          const files: Record<string, string> = {};
          await Promise.all(
            paths.map(async (rel) => {
              const abs = path.join(dir, rel);
              // Oversized artifacts are never searched: one minified bundle
              // otherwise costs more memory than the whole source tree.
              if ((await stat(abs)).size > MAX_WORKSPACE_FILE_BYTES) return;
              files[rel] = await readFile(abs, "utf-8");
            }),
          );
          return grepWorkspace(files, pattern, searchOpts);
        } catch (err) {
          if (err instanceof CodingGrepError) return `Error: ${err.message}`;
          throw err;
        }
      },
    }),
    write_file: tool({
      description: describe.write_file,
      inputSchema: z.object({
        path: z.string().describe("Workspace-relative path"),
        content: z.string().describe("Full new file contents"),
      }),
      execute: async ({ path: rel, content }) => {
        const abs = resolveInside(dir, rel);
        // Validate BEFORE persisting: a host that refuses a write is saying the
        // content would strand the agent, and half-writing it is the state it
        // is refusing.
        const rejection = await validate?.(rel, content);
        if (rejection !== undefined) return rejection;
        await writeFileWithParents(abs, content);
        clearEditMisses(rel);
        return `Wrote ${rel} (${content.length} bytes)${await written(rel)}`;
      },
    }),
    edit_file: tool({
      description: describe.edit_file,
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
          const rejection = await validate?.(rel, content);
          if (rejection !== undefined) return rejection;
          await writeFile(abs, content, "utf-8");
          clearEditMisses(rel);
          const label = replacements === 1 ? "" : ` (${replacements} replacements)`;
          return `Edited ${rel}${label}\n\n${diff}${await written(rel)}`;
        } catch (err) {
          if (err instanceof CodingEditError) return `Error: ${err.message}${rewriteHint(rel)}`;
          throw err;
        }
      },
    }),
    delete_file: tool({
      description: describe.delete_file,
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
        // would escape as a Node error where every neighbour answers in prose.
        // It stays a REFUSAL rather than becoming a recursive delete: this tool
        // is `delete_file`, the agent may have meant one file inside, and
        // `bash` is the deliberate escape hatch for the rest.
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
    bash: tool({
      description: describe.bash,
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
          const result = await runCapped("bash", ["-c", command], {
            cwd: dir,
            ...omitUndefined({ env: options.env }),
            timeoutMs: limit,
            cap: BASH_OUTPUT_CAP,
            combineStreams: true,
          });
          const body = outputWithKillNote(result, limit).trim() || "(no output)";
          return result.exitCode === 0 ? body : `[exit code ${result.exitCode}]\n${body}`;
        } catch (err) {
          return `Error: ${errorMessage(err)}`;
        }
      },
    }),
    todo_write: tool({
      description: describe.todo_write,
      inputSchema: z.object({
        todos: z
          .array(TodoItemSchema)
          .describe("The complete updated todo list; replaces the previous list"),
      }),
      execute: async ({ todos }) => renderTodos(todos),
    }),
  };

  if (options.only === undefined) return all as Record<N, ToolDef>;
  return Object.fromEntries(options.only.map((name) => [name, all[name]])) as Record<N, ToolDef>;
}
