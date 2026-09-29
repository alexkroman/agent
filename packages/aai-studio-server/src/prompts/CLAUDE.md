---
summary: >-
  The studio coding agent's system prompt: the per-kind preambles, the
  scaffold reference they embed, the project kind that selects one, and what
  the prompt must say about the agent's capabilities.
read_when: >-
  editing prompt text in `src/prompts/`, the project-kind switch, or what the
  coding agent is told it can and cannot do.
---

# `src/prompts/` — the coding agent's system prompt

- **Prompt text lives in this directory, and nothing else does.**
  `check-doc-examples` compiles every `ts` fence in it by reading the directory,
  so a new module here is gated by default.
- `studio-prompt.ts` composes a kind's preamble with the scaffold `CLAUDE.md`
  (or a built-in fallback), cached per kind. `studio-preamble.ts` is the shared
  preamble; `studio-preamble-mode.ts` names the fragments that differ.
- `pnpm sync:studio-prompt` regenerates the committed copies in
  `packages/aai-guest-studio/studio-prompts/` that the guest's eval reads;
  `check:studio-prompt` fails when they are stale.

## A project has a KIND

Chosen once at create time (`studio-project-kind.ts`; the hero's Agent/Workflow
switcher sends it and `POST /studio/projects` stamps it on the workspace).
`agent` is a voice session; `workflow` is a static `workflowApp()` — a form,
durable runs, no microphone — whose default template is
`transcription-workflow`.

- **It lives on the WORKSPACE, not on a request.** The prompt is installed per
  session (`studio/session-init` → `sessionParams` in
  `../studio-session-ensure.ts`), which recurs on every open, reload, CLI push
  refresh and adopt; a per-request flag would let a second tab build the other
  product. That is why `sessionParams` takes the whole `StudioWorkspace`.
- **Absent reads as `agent`** (`resolveProjectKind`, which narrows an `unknown`
  from stored JSON): every pre-switcher workspace was a voice agent, and a
  caller naming no kind (the CLI's first push, evals) gets it.
- **One preamble, five fragments swapped** — the overview line, the
  product-shape section, the spoken-replies rule, the `client.tsx` section, and
  the alignment examples. Tools, the write-then-typecheck loop, "you cannot
  publish", the refusals and the scaffold reference are shared: two copies
  drift, and a project that changes shape must keep the whole reference (it
  documents both `agent()` and `workflowApp()`).
- **The kind is a default, not a cage.** Both prompts switch shapes when the
  user asks outright; nothing rewrites the stamp.

## What the prompt must tell the agent

- **It cannot publish** — stated outright, so it never claims a deploy or
  invents a production URL. The preview auto-deploy is platform-triggered.
- **It will not see a Publish result** — the output goes to the Publish menu,
  so it asks the user what the menu said.
- **No MCP.** The prompt embeds a snapshot of the scaffold guide; for anything
  outside it (a voice, a new gateway model, a provider option) the agent uses
  `visit_webpage`, the AssemblyAI docs included, rather than guessing.
- **Toolchain paths are appended by the GUEST, never written here**
  (`toolchainPromptSection` in `aai-guest-studio`, appended at
  `initStudioSession`). The baked `node_modules` (SDK `.d.ts`, `aai-ui`
  component `.d.ts`, `aai-cli/dist/templates`) sits above the workspace at a
  depth that differs per layout, and only `bash` can reach it.
  `toolchainRoot()` searches upward and emits absolute paths or nothing;
  `build.test.ts` asserts each exists. Never name a monorepo path
  (`packages/aai-templates/…`) — no sandbox has one.

## The tool surface the prompt describes

Guest-side; the detail is "The coding agent is an ordinary `agent()`" in
`packages/aai-guest-studio/CLAUDE.md`. Keep the prompt consistent with it:

- `createTextAgent` with `text: true`, `MAX_CHAT_STEPS` = 80 plus a wall-clock
  turn budget.
- Tools: list/read (windowed, numbered)/write/edit/delete, `glob`, `grep`,
  `bash` (guest token scrubbed), `todo_write`, `test_agent` (the ONE
  verification tool — there is no `check_types`), `read_logs`,
  `list_templates`/`use_template` (copies files verbatim), the dependency
  tools, and the keyless web builtins (`visit_webpage`, `get_page_design`,
  `web_search`) named in `builtinTools`.
- Every successful write/edit appends capped type diagnostics; a write is never
  rejected for type errors.
- Deadlines: 120s per tool; `bash` 60s default, 300s max.
- Tools run with an empty env (the key is `providerEnv`), so they never read a
  credential; `safeFetch` still screens model-controlled URLs.
- `update_dependencies` refuses the six toolchain-owned packages
  (`TOOLCHAIN_MANAGED`) and reports what it skipped — see "A workspace's own
  package.json is REIFIED" in `packages/aai-guest-studio/CLAUDE.md`.
