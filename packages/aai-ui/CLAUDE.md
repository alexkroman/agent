---
summary: >-
  Browser client package: exports and subpaths, the public-vs-internal surface
  rule, key files, and pointers to the directory guides for the session core,
  hooks, workflow apps, components, worklets and contracts.
read_when: >-
  working anywhere in `@alexkroman1/aai-ui` — the browser client, its audio
  path, or a workflow app's page.
---

# packages/aai-ui — browser client guide

The browser client (`@alexkroman1/aai-ui`): session, audio, React UI. Repo-wide
rules are in the root `AGENTS.md`.

## Directory guides

- [`src/CLAUDE.md`](src/CLAUDE.md) — session core (statecharts, fatal latch,
  handshake guard, client-config lookup), public hooks, fuzz harnesses, and the
  workflow-app hooks and HTTP API.
- [`src/components/CLAUDE.md`](src/components/CLAUDE.md) — memoized-props and
  TypeDoc rules, conversation/chrome components, `AutoScroll`, forms and
  `<WorkflowFields>`, workflow-page components.
- [`src/worklets/CLAUDE.md`](src/worklets/CLAUDE.md) — capture and playback
  processors: jitter buffer, concealment, capture rate and constraints, dead-mic
  probe.
- [`src/contracts/CLAUDE.md`](src/contracts/CLAUDE.md) — the ten `aai-ui:`
  capabilities and the `.tsx` compatibility fixtures.
- [`PLAYBACK-CLAUDE.md`](PLAYBACK-CLAUDE.md) (reference, read on demand) —
  playback tuning measurements against a real TTS reply.

Guides under `src/` are not published: `package.json` `files` is `dist` +
`styles.css`.

## Package exports

- `.` — mounts (`mountClient`, `mountPage`), session, hooks, components, forms,
  workflow client.
- `./styles.css` — default styles and the `--aai-*` → Tailwind token map.
- `./client-dir` — **Node only**: `defaultClientDir()`, the path of the prebuilt
  default client (`dist/default-client/`, not an export of its own) for
  `createRuntimeServer`/`createAgentServer`'s `clientDir`. Its own subpath because
  it imports `node:*`, which the root barrel may not
  (`ui-browser-barrel-has-no-node-module` in `konsistent.json`). A FUNCTION,
  not a constant, so a missing package fails at call time, not import time.
- `./internal` — what `mountClient()` installs for itself and framework tuning
  constants (`SessionProvider`, `ThemeProvider`, `ToolConfigContext`, the URL
  chips, `buildAgentUrl`, `loadClientConfig`, `VOICE_CAPTURE_CONSTRAINTS`,
  `TRANSCRIBING_PLACEHOLDER`, the poll defaults). Not an authoring surface.

## Public vs internal surface

Every export of `.` and `/client-dir` is `@public` and belongs to a capability
contract (`src/contracts/CLAUDE.md`); `pnpm check:api-contracts` fails otherwise.

- **No `@internal` export on the root barrel — the ratchet is at zero.** A name
  that should be public drops the tag and joins a capability; a name that is
  internal moves to `/internal`. API Extractor reads `@internal` only at the
  DECLARATION, so a tag on an `export { … } from` member is silently ignored —
  the subpath is the boundary, not the tag.
- **Wiring for `internal.ts`**: an `exports` triple in `package.json` and an
  entry in `tsdown.config.ts` (the entry list is HARDCODED here). It is not a
  typedoc entry point — `UNDOCUMENTED_SUBPATHS` in `scripts/docs-markdown.mjs`
  lists it, and that gate fails both ways. `/internal` is deny-listed by
  `NON_AUTHORING_SUBPATHS` in `scripts/_api-contracts-tree.mjs`.
- **A name a public doc tells authors to call must be public**
  (`fetchClientConfig` is, in the `page` capability). `loadClientConfig` (its
  `null`-vs-`{}` split is a session detail) and `buildAgentUrl` stay internal.
- **Tuning constants no public signature names are internal**; the hook that
  owns an interval takes it as an OPTION instead.

## Key files

- `index.ts` — the root barrel; `internal.ts` — the `/internal` subpath.
- `session-core.ts` — `createBrowserSession`, WebSocket session + reactive
  snapshot; split across `session-core-*.ts` (messages, state machine, audio
  state/effects/setup, handshake, reconnect, user turn, types).
- `context.ts` — `SessionProvider`, `useSession`, `useSessionCore`,
  `useSessionSelector`, `ThemeProvider`, `useTheme`.
- `hooks.ts` — `useAgentState`, `useToolResult`, `useToolCallStart`, `useEvent`.
- `audio.ts` — PCM encode/decode, AudioWorklet management.
- `client-config.ts` — the `GET /client-config` lookups.
- `define-client.tsx` — `mountClient()`, plus `resolveContainer` and
  `mountRoot`, which `mountPage()` (`page.tsx`) shares.
- `default-client.tsx` / `build-default-client.ts` — the default UI for agents
  with no `client.tsx`, and its build step.
- `use-*.ts` — public hooks (conversation, session controls, push-to-talk,
  workflow run/runs/progress/submit/stream, download URL, flash, copy).
- `_workflow-api-ref.ts` / `_repeat-until.ts` — the client-in-a-ref preamble and
  the bounded-read loop the workflow hooks share; `_upload-*.ts` — upload
  session, recall, report, file claiming.
- `workflow-client.ts` — `createWorkflowApi`, the re-exported workflow types.
- `types.ts` — UI types, `VOICE_CAPTURE_CONSTRAINTS`.
- `components/`, `worklets/`, `contracts/` — see the directory guides.
