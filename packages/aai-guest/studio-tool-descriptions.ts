// Copyright 2026 the AAI authors. MIT license.
/**
 * Descriptions for the studio coding agent's workspace tools — the prose
 * the model reads, kept out of `studio-tools.ts` so it can be tuned
 * without touching execution code (and so that file stays under the
 * repo's length cap).
 *
 * The numeric limits a description quotes live here too and are imported
 * back by `studio-tools.ts` for enforcement — a description that names a
 * different number than the code enforces is worse than no number at all.
 */

/** read_file paging defaults — opencode's read-tool semantics. */
export const READ_LIMIT = 2000;
/** Max glob results before truncation. */
export const GLOB_LIMIT = 100;
/**
 * Lines one `read_logs` call may ask for.
 *
 * It must not exceed the host's own clamp (`MAX_LOG_TOOL_LINES` in
 * `aai-studio-server/studio-agent-logs.ts`), which is the authority — the two
 * are separate because the guest may not import the studio server, and a guest
 * asking for more than the host admits is a rejected RPC rather than a clamp.
 */
export const LOGS_TOOL_MAX_LINES = 500;
/** Default and max wall-clock for one bash command. */
export const BASH_TIMEOUT_MS = 60_000;
export const BASH_TIMEOUT_MAX_MS = 300_000;

export const STUDIO_TOOL_DESCRIPTIONS = {
  list_files: `List every file in the project workspace (node_modules, dist, and .git are excluded).

WHEN TO USE:
- Orienting at the start of a request, or when unsure what exists.
- For targeted lookups prefer glob (find by name) or grep (search contents).`,

  read_file: `Read a file from the project workspace. Returns numbered lines ("NNNNN| text"); use offset/limit to page through large files.

GUIDELINES:
- Read a file before editing it, and read multiple files in parallel when gathering context.
- Do NOT re-read a file after a successful edit_file — the diff it returned already shows the result.
- Only pass offset/limit when a previous read said the file continues.`,

  glob: `Find workspace files whose path matches a glob pattern (e.g. **/*.ts, "*.tsx"), newest first, capped at ${GLOB_LIMIT} results.

WHEN TO USE:
- Locating files by name or extension.
- Use grep instead when you are searching by contents.`,

  write_file: `Create a new file, or fully replace an existing one. Parent directories are created automatically.

IMPORTANT — minimize full rewrites:
- PREFER edit_file for changes to an existing file; use write_file only for new files or genuine wholesale rewrites.
- When creating multiple new files, issue the write_file calls in parallel — it is much faster than one by one.
- Never rewrite a file you have not read this conversation; the user may have edited it since.

TYPE ERRORS: after each save the workspace is type-checked and any errors are appended to the result. The file IS saved either way — fix every reported error (in one pass when they repeat) before running test_agent; a result with no errors listed means the workspace type-checks.`,

  edit_file: `The PREFERRED and PRIMARY tool for modifying an existing file: replaces one exact snippet and returns a diff of what changed.

GUIDELINES:
- oldText must match the file exactly — whitespace and indentation included — and appear exactly once. Include a few surrounding lines when the snippet alone would be ambiguous.
- Set replaceAll: true to change every occurrence (e.g. renaming a symbol).
- Multiple independent edits? Invoke edit_file several times in parallel.
- Trust the returned diff; do not re-read the file just to confirm the edit applied.
- Like write_file, each successful edit reports the workspace's type errors in its result; no errors listed means the workspace type-checks.`,

  delete_file: `Delete a file from the project workspace.

WHEN TO USE:
- Removing scratch scripts, debug artifacts, or files nothing imports anymore.
- Deleting is permanent — check what a file is before removing something you didn't create.`,

  grep: `Regex-based code search across workspace file contents. Returns "path:line: text" for each match.

GUIDELINES:
- Filter which files are searched with glob (e.g. "*.ts"), and set literal: true to match plain text without regex escaping.
- Cheaper than reading whole files — use it to find where something is defined, then read_file just that file.
- When matches span several files, check each before deciding where a change belongs.`,

  bash: `Run a bash command in the workspace directory (network access available).

COMMONLY USED FOR:
- node one-liners and scratch scripts to check logic or probe an API's response shape
- Inspecting files and directories (ls, cat, wc)
- For npm packages, prefer the dedicated add_dependency / remove_dependency tools

RULES:
- Make source changes with edit_file/write_file, not shell redirection — the dedicated tools show the user a diff.
- The workspace ships without node_modules, and only workspace source files (never node_modules, dist, or .git) sync back to the project.
- Output is capped with the tail kept; long-running commands are killed at the timeout (default ${BASH_TIMEOUT_MS}ms, max ${BASH_TIMEOUT_MAX_MS}ms).`,

  npm_info: `Look up a package on the npm registry: name, version, description, homepage, exports, and peerDependencies.

WHEN TO USE:
- BEFORE add_dependency, to confirm the package exists and see its real import surface instead of guessing an API from memory.
- After installing, ground truth is local: read node_modules/<pkg>/package.json with read_file, or search inside it with bash.`,

  add_dependency: `Add an npm dependency to the project. The package should be a valid npm package name, optionally with a version (e.g. "lodash@4", "date-fns").

GUIDELINES:
- FIRST install the package, THEN write the code that imports it — builds bundle whatever package.json declares.
- Prefer the SDK's builtins and plain fetch over adding dependencies; reach for a package only when the request truly needs one.`,

  remove_dependency: `Uninstall an npm package from the project.

WHEN TO USE:
- Removing a dependency nothing imports anymore — check with grep before uninstalling.`,

  update_dependencies: `Update packages already declared in package.json to their latest published version. Pass names to update just those, or omit packages to update every updatable one. Reports each package's declared version before and after.

WHEN TO USE:
- The user asks to update/upgrade dependencies, or a package is too old for an API the request needs.
- Installing a NEW package is add_dependency's job, not this tool's.

NOTE:
- The platform-owned packages (@alexkroman1/aai, @alexkroman1/aai-ui, react, react-dom, tailwindcss, zod) stay pinned to the installed toolchain and are reported as left alone — that is correct, not a failure.
- Latest versions can bring breaking changes: run test_agent afterwards and fix what the build reports.`,

  list_templates: `List the worked example agents (templates) that ship with the platform — the same set \`aai init\` scaffolds — with each template's files.

WHEN TO USE:
- BEFORE writing an agent pattern from scratch: when a template covers the request's shape (ordering flow, game, research assistant, custom UI), starting from it is faster and more reliable than reinventing it.
- Follow up with use_template to copy one in; the code is real, working, and current for the installed SDK.`,

  use_template: `Copy a template's files VERBATIM into the workspace (every file, or a named subset). Much better than retyping template code through write_file — the bytes arrive exactly as shipped.

GUIDELINES:
- The copied files are a working starting point: read them, then adapt names, prompts, and tools to the request with edit_file.
- Existing workspace files are never replaced unless overwrite: true; files already identical are skipped.
- Like write_file, a copy reports the workspace's type errors in its result — none listed means it type-checks.`,

  download_to_workspace: `Download a TEXT file from a URL and save it into the workspace (e.g. a JSON dataset, an SVG logo, a CSV menu).

RULES:
- Text only: the workspace syncs as utf-8, so binary responses (images, audio) are refused — reference those by URL in client.tsx instead.
- Not for npm packages (use add_dependency) and not for reading pages (use visit_webpage).`,

  generate_design_inspiration: `Generate a design brief before any client.tsx design work, to ensure the UI is visually appealing rather than boilerplate.

WHEN TO USE:
- Vague design requests ("make it look nice", "modern UI") that need direction.
- New custom UIs with no established style to follow.

SKIP WHEN:
- The change is a minor styling tweak, or the user gave a specific design/site to copy (use get_page_design for sites).
- The project already has a client.tsx with an established style — preserve it instead.

IMPORTANT: if you generate a design brief, you MUST follow it.`,

  todo_write: `Replace your todo list for the current request. The user sees the list, so it doubles as a progress report.

WHEN TO USE:
- Multi-step work: several named capabilities, or a build plus a redesign. Write the steps up front, then resend the full list as statuses change.
- Keep exactly one item in_progress at a time, and use milestone-level steps, not micro-steps.
- SKIP it for single-step changes and questions.`,

  read_logs: `Read what the project's DEPLOYED agent has printed — the same output the user sees in the studio's Logs pane, most recent lines last.

WHEN TO USE:
- A runtime failure only a real call produces: a tool that throws mid-session, a missing provider key, a response shape that isn't what the code expects. test_agent loads the bundle HERE and cannot see any of that.
- After asking the user to try something in the Preview pane — their session's output lands here.
- Add console.log("[aai] ...") lines to the agent, wait for the preview to redeploy, then read them back.

WHICH AGENT:
- environment: "preview" (the default) is the agent your edits auto-deploy to — nearly always the one to read.
- environment: "production" is the published agent, and only exists once the user has published.

WHAT IT IS NOT:
- Not a log FILE: the buffer lives in the agent's sandbox and goes when the sandbox does, so it is recent output only, and an agent nobody has talked to has printed nothing.
- Not your own output: bash and test_agent already return what they print.`,

  test_agent: `Build the workspace and load it into the production agent runtime — the same build path Publish runs, so a clean test_agent means the publish will build.

WHAT IT REPORTS:
- Type errors and build errors (with diagnostics to act on), load errors, and the agent's self-described config (name, mode, tools).
- The result of the workspace's own tests (any *.test.ts), run after the build. A failure usually means the test and the agent have drifted — updating the test is as legitimate a fix as changing the agent.

TRIAL RUNS:
- Pass tool and args to also invoke one of the agent's tools with sample arguments and see its real output.
- Secrets are NOT available in trials (ctx.env is empty) and ctx.db is unavailable — exercise the parts that don't need them.

Run it after every meaningful change, before telling the user the work is ready.`,
} as const;
