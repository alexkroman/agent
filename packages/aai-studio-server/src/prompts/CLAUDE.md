---
summary: >-
  The studio coding agent's system prompt: the one preamble, the scaffold
  reference it embeds, and what the prompt must say about the agent's
  capabilities.
read_when: >-
  editing prompt text in `src/prompts/`, or what the coding agent is told it
  can and cannot do.
---

# `src/prompts/` — the coding agent's system prompt

- **Prompt text lives in this directory, and nothing else does.**
  `check-doc-examples` compiles every `ts` fence in it by reading the directory,
  so a new module here is gated by default (its `MIN_PROMPT_SOURCES` floor
  counts these modules — lower it deliberately when one goes).
- `studio-prompt.ts` composes the preamble (`studio-preamble.ts`) with the
  scaffold `CLAUDE.md` plus every `agent-guide/` topic file inlined after it in
  routing-table order (the studio agent cannot open a topic file the way a
  laptop agent does), or a built-in fallback, and caches the result.
- `pnpm sync:studio-prompt` regenerates the committed copies in
  `packages/aai-guest-studio/studio-prompts/` (`system-prompt.md`,
  `starters.json`) that the guest's eval reads; `check:studio-prompt` fails when
  they are stale.

## Every project is a voice agent

There is ONE prompt: it defaults to `agent()` — a microphone, a session — and
builds a form-fronted `workflowApp()` only when the user asks outright. The
scaffold reference below it documents both. The Voice agent / Workflow switch
(and its per-kind prompt) is retired: a stored workspace's `kind` key is
ignored, and nothing selects a prompt per project.

## What the prompt must tell the agent

- **It cannot publish** — stated outright, so it never claims a deploy or
  invents a production URL. The preview auto-deploy is platform-triggered.
- **It will not see a Publish result** — the output goes to the Publish menu, so
  it asks the user what the menu said.
- **No MCP.** The prompt embeds a snapshot of the scaffold guide; for anything
  outside it (a voice, a new gateway model, a provider option) the agent uses
  `visit_webpage`, the AssemblyAI docs included, rather than guessing.
- **Toolchain paths are appended by the GUEST, never written here**
  (`toolchainPromptSection` in `aai-guest-studio`, appended at
  `initStudioSession`). The baked `node_modules` (SDK `.d.ts`, `aai-ui`
  component `.d.ts`, `aai-cli/dist/templates`) sits above the workspace at a
  depth that differs per layout, and only `bash` can reach it. `toolchainRoot()`
  searches upward and emits absolute paths or nothing; `build.test.ts` asserts
  each exists. Never name a monorepo path (`packages/aai-templates/…`) — no
  sandbox has one.

## The tool surface the prompt describes

Guest-side; the detail is "The coding agent is an ordinary `agent()`" in
`packages/aai-guest-studio/CLAUDE.md`. Keep the prompt consistent with it:

- `createTextAgent` with `mode: "text"`, `MAX_CHAT_STEPS` = 80 plus a wall-clock
  turn budget.
- Tools: list/read (windowed, numbered)/write/edit/delete, `glob`, `grep`,
  `bash` (guest token scrubbed), `todo_write`, `test_agent` (the ONE
  verification tool — there is no `check_types`), `read_logs`,
  `list_templates`/`use_template` (copies files verbatim), the dependency tools,
  and the keyless web builtins (`visit_webpage`, `get_page_design`,
  `web_search`) named in `builtinTools`.
- Every successful write/edit appends capped type diagnostics; a write is never
  rejected for type errors.
- Deadlines: 120s per tool; `bash` 60s default, 300s max.
- Tools run with an empty env (the key is `providerEnv`), so they never read a
  credential; `safeFetch` still screens model-controlled URLs.
- `update_dependencies` refuses the six toolchain-owned packages
  (`TOOLCHAIN_MANAGED`) and reports what it skipped — see "A workspace's own
  package.json is REIFIED" in `packages/aai-guest-studio/CLAUDE.md`.
