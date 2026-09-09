// Copyright 2026 the AAI authors. MIT license.
/**
 * The prose a coding agent's model READS, kept out of `coding-tools.ts` so it
 * can be tuned without touching execution code — and so neither file goes past
 * the repo's length cap.
 *
 * Every numeric limit a description quotes is declared HERE and imported back
 * by the tool that enforces it: a description naming a different number than
 * the code enforces is worse than one naming no number at all, because the
 * model plans around the number it was told.
 *
 * These are the GENERIC descriptions — what each tool does, and the working
 * rules that make an agent use it well (read before editing, prefer `edit_file`
 * to a rewrite, one `in_progress` todo). Anything a particular host wants said
 * — a build tool to run afterwards, a dependency tool to prefer over
 * `npm install` — is an override at the call site
 * ({@link CodingToolsOptions.descriptions}) rather than a line here, because a
 * description that names a tool this module does not define is a description
 * that goes stale silently.
 */

/** `read_file` paging default and hard cap, in lines. */
export const READ_LIMIT = 2000;

/** Max `glob` results before the list is truncated, newest first. */
export const GLOB_LIMIT = 100;

/** Default and maximum wall-clock for one `bash` command. */
export const BASH_TIMEOUT_MS = 60_000;
export const BASH_TIMEOUT_MAX_MS = 300_000;

/** Every tool {@link createCodingTools} can build, by the name the model calls. */
export type CodingToolName =
  | "list_files"
  | "read_file"
  | "glob"
  | "grep"
  | "write_file"
  | "edit_file"
  | "delete_file"
  | "bash"
  | "todo_write";

export const CODING_TOOL_DESCRIPTIONS: Readonly<Record<CodingToolName, string>> = {
  list_files: `List every file in the workspace (node_modules, dist, and .git are excluded).

WHEN TO USE:
- Orienting at the start of a request, or when unsure what exists.
- For targeted lookups prefer glob (find by name) or grep (search contents).`,

  read_file: `Read a file from the workspace. Returns numbered lines ("NNNNN| text"); use offset/limit to page through large files.

GUIDELINES:
- Read a file before editing it, and read multiple files in parallel when gathering context.
- Do NOT re-read a file after a successful edit_file — the diff it returned already shows the result.
- Only pass offset/limit when a previous read said the file continues.`,

  glob: `Find workspace files whose path matches a glob pattern (e.g. **/*.ts, "*.tsx"), newest first, capped at ${GLOB_LIMIT} results.

WHEN TO USE:
- Locating files by name or extension.
- Use grep instead when you are searching by contents.`,

  grep: `Regex-based search across workspace file contents. Returns "path:line: text" for each match.

GUIDELINES:
- Filter which files are searched with glob (e.g. "*.ts"), and set literal: true to match plain text without regex escaping.
- Cheaper than reading whole files — use it to find where something is defined, then read_file just that file.
- When matches span several files, check each before deciding where a change belongs.`,

  write_file: `Create a new file, or fully replace an existing one. Parent directories are created automatically.

IMPORTANT — minimize full rewrites:
- PREFER edit_file for changes to an existing file; use write_file only for new files or genuine wholesale rewrites.
- When creating multiple new files, issue the write_file calls in parallel — it is much faster than one by one.
- Never rewrite a file you have not read this conversation; it may have changed since you last saw it.`,

  edit_file: `The PREFERRED and PRIMARY tool for modifying an existing file: replaces one exact snippet and returns a diff of what changed.

GUIDELINES:
- oldText must match the file exactly — whitespace and indentation included — and appear exactly once. Include a few surrounding lines when the snippet alone would be ambiguous.
- Set replaceAll: true to change every occurrence (e.g. renaming a symbol).
- Multiple independent edits? Invoke edit_file several times in parallel.
- Trust the returned diff; do not re-read the file just to confirm the edit applied.`,

  delete_file: `Delete one file from the workspace.

WHEN TO USE:
- Removing scratch scripts, debug artifacts, or files nothing imports anymore.
- Deleting is permanent — check what a file is before removing something you didn't create.`,

  bash: `Run a bash command in the workspace directory.

COMMONLY USED FOR:
- Running the project's own tooling: its tests, its linter, its build.
- Scratch scripts and one-liners to check logic or probe an API's response shape.
- Inspecting files and directories (ls, cat, wc) when a dedicated tool doesn't fit.

RULES:
- Make source changes with edit_file/write_file, not shell redirection — the dedicated tools show the user a diff and refuse a write that would strand you.
- Output is capped with the tail kept; long-running commands are killed at the timeout (default ${BASH_TIMEOUT_MS}ms, max ${BASH_TIMEOUT_MAX_MS}ms).`,

  todo_write: `Replace your todo list for the current request. The user sees the list, so it doubles as a progress report.

WHEN TO USE:
- Multi-step work: several named capabilities, or a change plus a cleanup. Write the steps up front, then resend the full list as statuses change.
- Keep exactly one item in_progress at a time, and use milestone-level steps, not micro-steps.
- SKIP it for single-step changes and questions.`,
};
