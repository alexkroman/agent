# aai-studio-client

## 0.6.25

### Patch Changes

- 6e9fd4b: Lower the engines floor on the private packages from Node >=26 to >=24, matching the published packages and the scaffold. The deployed images still run Node 26; the floor only stops a warning on every install under Node 24.
- @alexkroman1/aai@15.1.0
  - @alexkroman1/aai-ui@15.1.0

## 0.6.24

### Patch Changes

- 29fbf01: Studio client: read the project/chat event streams with the SDK's published `readEventStream` instead of a third private copy of the SSE parser, and narrow each pushed frame with a real guard instead of casting a `JSON.parse`.
- 29fbf01: aai-ui: publish the three behaviour rules the studio front-end had duplicated. `useFlash` and `useCopy` replace three hand-rolled flashes — including the one inside the URL chips, which swallowed a refused clipboard write so the button did nothing visible; a refusal now reports `Failed`. `fieldKindFor` is `<WorkflowFields>`'s own control-selection rule, extracted out of `SchemaField` so there is one decision and published so a reader documenting the form-to-JSON correspondence asks it rather than mirroring the switch. The studio's chat transcript and Logs pane also drop `use-stick-to-bottom` for `<AutoScroll>`, this package's one owner of that effect.
- Updated dependencies [f9c1a98]
- Updated dependencies [8dc4cbb]
- Updated dependencies [29fbf01]
  - @alexkroman1/aai@15.0.0
  - @alexkroman1/aai-ui@15.0.0

## 0.6.23

### Patch Changes

- 79e3ea6: Fix unstyled GitHub card inputs and a misplaced secrets refusal in the studio front-end, and consolidate its duplicated seams
- Updated dependencies [b5beca2]
- Updated dependencies [79e3ea6]
- Updated dependencies [292ae33]
- Updated dependencies [a9c1577]
- Updated dependencies [a1a4e1e]
- Updated dependencies [79e3ea6]
- Updated dependencies [292ae33]
- Updated dependencies [79e3ea6]
- Updated dependencies [292ae33]
- Updated dependencies [79e3ea6]
- Updated dependencies [292ae33]
- Updated dependencies [a9c1577]
- Updated dependencies [ef096bb]
  - @alexkroman1/aai@14.0.0
  - @alexkroman1/aai-ui@14.0.0

## 0.6.22

### Patch Changes

- Updated dependencies [25e42e8]
  - @alexkroman1/aai-ui@13.3.0
  - @alexkroman1/aai@13.3.0

## 0.6.21

### Patch Changes

- Updated dependencies [4fb6b05]
  - @alexkroman1/aai@13.2.0
  - @alexkroman1/aai-ui@13.2.0

## 0.6.20

### Patch Changes

- @alexkroman1/aai@13.1.0
  - @alexkroman1/aai-ui@13.1.0

## 0.6.19

### Patch Changes

- 9e12bb2: Bump dependencies across the workspace: the ai SDK and its provider adapters, zod, vite, vitest, hono, the Supabase clients, xstate, undici, modal, @cartesia/cartesia-js and the build/lint toolchain.
  
  Two source changes come with it. The scripted fake language model emitted a bare-string stream finish reason where the v3 provider spec declares a { unified, raw } pair — harmless until ai@7.0.70 made automatic tool execution conditional on that value, after which a scripted tool call never ran; the fake's doGenerate half already had the pair. And protocol-compat.test.ts moves off zod's deprecated ZodTypeAny to ZodType.
- Updated dependencies [9e12bb2]
- Updated dependencies [9e12bb2]
- Updated dependencies [9584e2e]
- Updated dependencies [9584e2e]
  - @alexkroman1/aai@13.0.0
  - @alexkroman1/aai-ui@13.0.0

## 0.6.18

### Patch Changes

- @alexkroman1/aai@12.0.0
  - @alexkroman1/aai-ui@12.0.0

## 0.6.17

### Patch Changes

- Updated dependencies [36a3f22]
- Updated dependencies [0718b57]
- Updated dependencies [fe3b6d6]
- Updated dependencies [63e1c8e]
- Updated dependencies [36a3f22]
- Updated dependencies [f10b6aa]
- Updated dependencies [7ab47cf]
- Updated dependencies [31459e8]
  - @alexkroman1/aai@11.0.0
  - @alexkroman1/aai-ui@11.0.0

## 0.6.16

### Patch Changes

- @alexkroman1/aai@10.0.1
  - @alexkroman1/aai-ui@10.0.1

## 0.6.15

### Patch Changes

- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
  - @alexkroman1/aai@10.0.0
  - @alexkroman1/aai-ui@10.0.0

## 0.6.14

### Patch Changes

- Updated dependencies [1ad4977]
- Updated dependencies [bee46bc]
  - @alexkroman1/aai@9.2.0
  - @alexkroman1/aai-ui@9.2.0

## 0.6.13

### Patch Changes

- Updated dependencies [041a5a2]
  - @alexkroman1/aai@9.1.0
  - @alexkroman1/aai-ui@9.1.0

## 0.6.12

### Patch Changes

- @alexkroman1/aai@9.0.2
  - @alexkroman1/aai-ui@9.0.2

## 0.6.11

### Patch Changes

- @alexkroman1/aai@9.0.1
  - @alexkroman1/aai-ui@9.0.1

## 0.6.10

### Patch Changes

- Updated dependencies [444e209]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
- Updated dependencies [e888216]
- Updated dependencies [444e209]
- Updated dependencies [444e209]
- Updated dependencies [444e209]
- Updated dependencies [f6be741]
- Updated dependencies [af284a7]
- Updated dependencies [af284a7]
- Updated dependencies [e20a992]
- Updated dependencies [444e209]
- Updated dependencies [841f460]
- Updated dependencies [b238ba0]
- Updated dependencies [6796ae3]
- Updated dependencies [5bac92d]
- Updated dependencies [841f460]
- Updated dependencies [044236f]
- Updated dependencies [841f460]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
- Updated dependencies [444e209]
- Updated dependencies [444e209]
  - @alexkroman1/aai@9.0.0
  - @alexkroman1/aai-ui@9.0.0

## 0.6.9

### Patch Changes

- @alexkroman1/aai@8.2.1
  - @alexkroman1/aai-ui@8.2.1

## 0.6.8

### Patch Changes

- @alexkroman1/aai@8.2.0
  - @alexkroman1/aai-ui@8.2.0

## 0.6.7

### Patch Changes

- Updated dependencies [2f899e1]
- Updated dependencies [1789a55]
  - @alexkroman1/aai@8.1.0
  - @alexkroman1/aai-ui@8.1.0

## 0.6.6

### Patch Changes

- 4c55d8a: Studio Logs pane: follow-the-bottom now runs on `use-stick-to-bottom` — already a dependency of this package, and the component the chat transcript mounts — instead of a hand-rolled scroll handler. The old version re-pinned only when a line arrived, so a line that wrapped, or a monospace font that finished loading, grew the content under a pane that thought it was already at the bottom.
- Updated dependencies [83edc89]
- Updated dependencies [1d58f53]
- Updated dependencies [6960bfa]
- Updated dependencies [c0e3d85]
- Updated dependencies [efa6152]
- Updated dependencies [01b790c]
- Updated dependencies [56b775c]
  - @alexkroman1/aai@8.0.0
  - @alexkroman1/aai-ui@8.0.0

## 0.6.5

### Patch Changes

- d98169a: **Breaking (nominally): `@alexkroman1/aai-ui/default-client/*` is removed.** It
  had no consumer in any form — not one import specifier in the repo, the
  templates, the scaffold, or any README — because every real consumer reaches
  those files by filesystem path through `./package.json` (`client-dir.ts`,
  `aai-server/transport-websocket.ts`). `files: ["dist"]` still ships them, so
  nothing that worked stops working. `aai-studio-client`'s `./dist/*` goes for the
  same reason: both of its consumers `require.resolve` the manifest and join
  `"dist"` themselves.
  
  Also widens `check:attw`. `aai-ui` pinned `--entrypoints .`, which silently
  excluded `./client-dir` — a typed, contracted subpath — and `aai-runtime`
  inherited the same pin. `aai-ui` now uses `--exclude-entrypoints styles.css`
  (a CSS entry point has no type declarations, which is the only reason the pin
  existed) and `aai-runtime` drops it entirely, so a NEW subpath defaults into
  being checked instead of out.
- Updated dependencies [d98169a]
- Updated dependencies [12ead27]
- Updated dependencies [abfc018]
- Updated dependencies [028044a]
- Updated dependencies [429126e]
- Updated dependencies [76ca287]
- Updated dependencies [abfc018]
- Updated dependencies [43ceb43]
- Updated dependencies [8c9ce20]
- Updated dependencies [9b9051a]
- Updated dependencies [55d5ec1]
- Updated dependencies [d98169a]
- Updated dependencies [ea0c9c9]
- Updated dependencies [d1e7c56]
- Updated dependencies [abfc018]
- Updated dependencies [a7309a5]
- Updated dependencies [51d571d]
- Updated dependencies [43ceb43]
- Updated dependencies [6596e4b]
- Updated dependencies [df8effa]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
- Updated dependencies [abfc018]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
  - @alexkroman1/aai-ui@7.0.0
  - @alexkroman1/aai@7.0.0

## 0.6.4

### Patch Changes

- aec3aa8: Studio: put the UI tab before the API tab in the pane switcher.
- Updated dependencies [11e4892]
- Updated dependencies [91364b0]
- Updated dependencies [3d20929]
- Updated dependencies [0397945]
- Updated dependencies [12deeec]
- Updated dependencies [8958dd1]
- Updated dependencies [1602a0e]
- Updated dependencies [0da62af]
- Updated dependencies [70e3ceb]
- Updated dependencies [f433015]
- Updated dependencies [298f3f2]
- Updated dependencies [1602a0e]
  - @alexkroman1/aai@6.11.0
  - @alexkroman1/aai-ui@6.11.0

## 0.6.3

### Patch Changes

- Updated dependencies [5556ed5]
  - @alexkroman1/aai@6.10.1
  - @alexkroman1/aai-ui@6.10.1

## 0.6.2

### Patch Changes

- Updated dependencies [1a76804]
  - @alexkroman1/aai@6.10.0
  - @alexkroman1/aai-ui@6.10.0

## 0.6.1

### Patch Changes

- Updated dependencies [9d45c1e]
  - @alexkroman1/aai@6.9.1
  - @alexkroman1/aai-ui@6.9.1

## 0.6.0

### Minor Changes

- 9134a61: Studio: the Playground tab is now labelled UI, and secrets move out of Settings into a Secrets pane of their own — a name/value form with the value in a password field, a live/on-next-deploy list with confirm-before-delete, and the .env paste box kept for bulk adds
- f802fac: Databases are off by default: a studio project now has no ctx.db until it is enabled in Settings, and the Database pane appears only once it is.

### Patch Changes

- Updated dependencies [ebd3c39]
- Updated dependencies [203c2d4]
- Updated dependencies [bbde9f9]
- Updated dependencies [a8e74a9]
  - @alexkroman1/aai-ui@6.9.0
  - @alexkroman1/aai@6.9.0

## 0.5.11

### Patch Changes

- Updated dependencies [c7bb199]
  - @alexkroman1/aai-ui@6.8.0
  - @alexkroman1/aai@6.8.0

## 0.5.10

### Patch Changes

- Updated dependencies [7f2637c]
- Updated dependencies [088eee6]
  - @alexkroman1/aai@6.7.2
  - @alexkroman1/aai-ui@6.7.2

## 0.5.9

### Patch Changes

- Updated dependencies [c46dac6]
  - @alexkroman1/aai@6.7.1
  - @alexkroman1/aai-ui@6.7.1

## 0.5.8

### Patch Changes

- Updated dependencies [9882411]
  - @alexkroman1/aai@6.7.0
  - @alexkroman1/aai-ui@6.7.0

## 0.5.7

### Patch Changes

- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
  - @alexkroman1/aai@6.6.0
  - @alexkroman1/aai-ui@6.6.0

## 0.5.6

### Patch Changes

- 58788ee: Internal quality pass: give repeated shapes one home each, remove stranded code, and hoist redundant work out of render and streaming paths. No API or behaviour change.
- Updated dependencies [58788ee]
- Updated dependencies [e2c2cda]
- Updated dependencies [153264f]
- Updated dependencies [153264f]
  - @alexkroman1/aai@6.5.1
  - @alexkroman1/aai-ui@6.5.1

## 0.5.5

### Patch Changes

- Updated dependencies [4da4327]
- Updated dependencies [4da4327]
  - @alexkroman1/aai@6.5.0
  - @alexkroman1/aai-ui@6.5.0

## 0.5.4

### Patch Changes

- Updated dependencies [5288539]
  - @alexkroman1/aai@6.4.0
  - @alexkroman1/aai-ui@6.4.0

## 0.5.3

### Patch Changes

- Updated dependencies [dd29277]
  - @alexkroman1/aai@6.3.1
  - @alexkroman1/aai-ui@6.3.1

## 0.5.2

### Patch Changes

- Updated dependencies [b04af38]
- Updated dependencies [2e103d8]
  - @alexkroman1/aai@6.3.0
  - @alexkroman1/aai-ui@6.3.0

## 0.5.1

### Patch Changes

- Updated dependencies [295e8db]
  - @alexkroman1/aai@6.2.0
  - @alexkroman1/aai-ui@6.2.0

## 0.5.0

### Minor Changes

- 320268c: Studio: switch between building a voice agent and a static workflow app on the new-project screen. The hero's position picks the starter examples and is stamped on the project, where it selects the coding agent's system prompt — workflow projects default to a workflowApp() in the shape of the transcription-workflow template.

### Patch Changes

- 16bec88: The studio's Workflows card reads the SDK's `WorkflowRunSnapshot`, `WorkflowSummary` and `isTerminal` instead of a local restatement, so a field added to a run snapshot reaches the card and a new run status cannot be silently classified as live. `errorText` unwraps message-bearing non-`Error` rejections through the SDK's `errorMessage`. (aai-studio-server is named so the client's `dist/` actually ships — it has no release of its own.)
- c4791cc: Split the local-dev sentinel in two: SUPABASE_DB_URL decides where platform state lives (no memory tier beside a real database), AAI_LOCAL_DEV=1 declares a local run. pnpm dev:aai-server resolves the local Supabase stack and a repo-root .env itself; studio sign-in offers the methods GoTrue reports, so email+password works locally with no OAuth app; boot verifies pg_cron instead of creating it. Studio projects get a database by DEFAULT (absent means on; the opt-out is an explicit false), and `@workflow/world-postgres` is no longer bundled into the guest harness — it ships on-disk Drizzle migrations the bundle cannot carry, so the durable Postgres workflow world could never start.

## 0.4.13

### Patch Changes

- Updated dependencies [df41665]
- Updated dependencies [24e8178]
  - @alexkroman1/aai@5.14.0
  - @alexkroman1/aai-ui@5.14.0

## 0.4.12

### Patch Changes

- Updated dependencies [4ba7ab3]
  - @alexkroman1/aai-ui@5.13.2
  - @alexkroman1/aai@5.13.2

## 0.4.11

### Patch Changes

- Updated dependencies [7e92c96]
  - @alexkroman1/aai@5.13.1
  - @alexkroman1/aai-ui@5.13.1

## 0.4.10

### Patch Changes

- Updated dependencies [5cfe26b]
- Updated dependencies [90e5c15]
- Updated dependencies [cdc8e54]
- Updated dependencies [db4b0fb]
- Updated dependencies [ce45435]
- Updated dependencies [cdc8e54]
  - @alexkroman1/aai@5.13.0
  - @alexkroman1/aai-ui@5.13.0

## 0.4.9

### Patch Changes

- 65dca0b: Studio gate screens never sit on an unexplained wait: the account and auth-config reads carry per-attempt deadlines, and a failed read shows "AssemblyAI Build is busy right now" with a Try again button instead of "Loading…" forever.
- 7cf76d3: Keep the studio UI alive across a Modal deploy: serve the app shell no-store (it names content-hashed assets that only exist in the image it was built into, and those are served immutable), and recover a tab whose chunks were deleted by the rollout — one guarded reload on a failed lazy import or Vite modulepreload error instead of a blank page.
- Updated dependencies [db3fb48]
- Updated dependencies [42cf8ab]
- Updated dependencies [c49f501]
- Updated dependencies [db3fb48]
- Updated dependencies [a91c3bc]
- Updated dependencies [db3fb48]
- Updated dependencies [c49f501]
- Updated dependencies [9fded19]
- Updated dependencies [348fa16]
- Updated dependencies [db3fb48]
- Updated dependencies [9fded19]
  - @alexkroman1/aai@5.12.0
  - @alexkroman1/aai-ui@5.12.0

## 0.4.8

### Patch Changes

- @alexkroman1/aai-ui@5.11.0

## 0.4.7

### Patch Changes

- @alexkroman1/aai-ui@5.10.1

## 0.4.6

### Patch Changes

- 3a6a510: Surface a failed sandbox spawn as a retryable 503 instead of an opaque 500, and stop pinning guest sandboxes to one Modal region
- 6b4a6d8: Run the platform on Node 26: the Modal service image, the guest sandbox base image, the repo's pinned toolchain, and CI all move from 24 to 26, matching the `@types/node` major the workspace already type-checks against. Published SDK packages keep `engines.node: >=24` so consumers on the previous LTS are unaffected.
- Updated dependencies [1c5056f]
  - @alexkroman1/aai-ui@5.10.0

## 0.4.5

### Patch Changes

- @alexkroman1/aai-ui@5.9.0

## 0.4.4

### Patch Changes

- @alexkroman1/aai-ui@5.8.1

## 0.4.3

### Patch Changes

- @alexkroman1/aai-ui@5.8.0

## 0.4.2

### Patch Changes

- 842d229: Add a Work locally section to the studio Settings panel with the aai CLI commands that pull the open project
- 1908738: Preview pane: probe the agent page before framing it, so a preview still deploying (or one whose agent was swept) shows the pane's own 'Starting your preview' screen instead of the platform's raw {"error":"HTML not found"} 404 body
  - @alexkroman1/aai-ui@5.7.0

## 0.4.1

### Patch Changes

- 9da9f65: Fix top-bar spacing/overflow: truncate long project names and production URLs, keep brand and buttons from wrapping

## 0.4.0

### Minor Changes

- 5cd6d50: Replace Supabase magic-link email sign-in with GitHub OAuth, and rework `aai login` as a device-link flow: the CLI no longer signs in (or creates accounts) itself — it opens the studio with a one-shot link code that a signed-in browser session approves, then exchanges the code for the account's stored API key. The `GET /studio/account/key` route is removed in favor of the one-shot exchange.

### Patch Changes

- e2a473a: Harden the aai login device link: the terminal and the browser approval gate now show a matching confirmation code (a phished approval link has a visible mismatch), and the studio stashes the ?cli-link code in per-tab sessionStorage and strips it from the URL at page load so it never rides the GitHub OAuth redirect chain.
- 77b0a80: Fix four sandbox-lifecycle defects found by stress testing: a stale studio chat token signing the user out, a silent TTS drain timeout, an unhandled publish-sandbox failure, and an unreachable guest idle-exit override.
- Updated dependencies [8b622e8]
- Updated dependencies [8b622e8]
- Updated dependencies [77b0a80]
  - @alexkroman1/aai-ui@5.6.0

## 0.3.4

### Patch Changes

- ea63c42: Studio code view: replace the file tab strip with a directory-grouped sidebar, and stop the file nav from stretching the page horizontally

## 0.3.3

### Patch Changes

- dcb1f99: Starter prompts now reference their aai-templates template by name (e.g. "Use the retail template."), so a pick copies the worked template verbatim via use_template instead of re-deriving it from a prose spec.
- c567faa: Add a retail support starter prompt to the studio's example catalog, modeled on the retail template

## 0.3.2

### Patch Changes

- 4076382: Studio: Settings moved next to Publish and no longer gated on a deploy, so Delete project works before anything is published
- 2d7913d: Studio chat no longer wedges on 'Starting sandbox…' when opened during a server restart: the session broker call now has a per-attempt timeout, transient failures retry with backoff, and the error state offers an in-place Try again instead of requiring a page reload.

## 0.3.1

### Patch Changes

- 65a1a92: Hide the Preview/Code/Settings switcher on the home page and add a Delete project button to the Settings panel
- 01d8a5f: Lock the Publish button while a chat turn streams — Publish now unlocks on the same end-of-turn event the preview deploy builds on, so a mid-turn workspace checkpoint can never be shipped to production.

## 0.3.0

### Minor Changes

- a96e9f8: Studio preview mode: edits auto-deploy to a per-project preview agent; Publish is production-only.

  - Every settled edit (the coding agent's turn-complete workspace sync — now flagged `done: true`, the analog of opencode's `session.idle` / codex's `agent-turn-complete` — and editor file writes/deletes) schedules a coalesced, fire-and-forget deploy of the workspace to `<project>-preview` through the same in-guest `aai deploy` path Publish uses. Mid-turn checkpoints never trigger deploys, so half-finished trees are never previewed.
  - The Live tab is renamed Preview and frames the preview agent, keyed by a `previewVersion` token so a fresh preview reloads the iframe exactly once; the client polls while a preview deploy is in flight, and failed preview builds surface their CLI output in the pane banner.
  - The production URL in the top bar stays a plain link that opens the deployed agent in a new tab, and the Secrets panel mirrors writes to the preview slug so previews run with the same third-party keys.

### Patch Changes

- d78137f: Studio top-bar rework: remove the project dropdown switcher and the sidebar's + New project button (the top bar shows the open project's name; switching happens from the home sidebar), move the Secrets panel behind a Settings toggle in the Live/Code segmented control, and replace "Change key" with a Log out button at the far right.

## 0.2.1

### Patch Changes

- 675ac6d: Redesign the studio home page: replace the three-step wizard with a Lovable-style hero prompt box, always land on the hero with a project sidebar, and show a random five starter examples in the hero instead of in the chat panel
- 38c1b97: Auto-create studio projects from the first chat message with server-generated v0-style names (prompt-derived base + random suffix) at shareable /studio/chat/<name> URLs; slugless CLI deploys now generate slugs from the agent's config name via the same shared generator.

## 0.2.0

### Minor Changes

- 293da11: The studio coding agent is now a Claude-Code-style agentic agent that runs
  INSIDE the project's own Modal sandbox, with the browser connected to it
  directly — mirroring the voice path. `POST /studio/projects/:project/
session` boots (or reuses) a guest sandbox through the same warm-pool
  machinery deployed agents use and returns the sandbox's public chat URL;
  turns stream browser→sandbox over SSE and never pass through the platform
  host. The loop runs in the guest on the caller's own key with tools over a
  real filesystem workspace — list/read (windowed)/write/edit/delete, glob,
  grep, bash (a real shell in the container), todo_write, test_agent, and
  the keyless web builtins — each with a user-friendly label served by the
  sandbox (`GET /studio/tools`) and rendered in the studio UI. End of turn,
  the guest syncs workspace edits and the conversation back over the
  authenticated control channel; test_agent builds via a guest→host RPC to
  the out-of-process build runner. The host-side chat loop, scan worker
  thread, and host tool implementations are removed — the SDK's
  `createServer` gains a `request` hook so the harness can serve the chat
  surface without a second HTTP server.

### Patch Changes

- df753ce: Remove the cascaded-agent (Assembly STT/TTS + Gemini Flash Lite) starter prompt from the studio

## 0.1.10

### Patch Changes

- 369f950: Ship a favicon.ico on the studio and voice agent pages: the AssemblyAI mark is bundled with the studio client and the default agent client, served at /favicon.ico (studio) and /:slug/favicon.ico (agents, with a custom client's own favicon taking precedence).
- 76b6f60: Default the studio coding agent to a cascaded pipeline (AssemblyAI STT, gpt-5.5 on the LLM Gateway, AssemblyAI TTS); the S2S voice agent API is now used only when the user asks for it. Codegen evals updated to grade the new default.

## 0.1.9

### Patch Changes

- 57e1807: Remove the studio's per-request LLM model picker — chat always runs on the host-configured default model (gpt-5.5 on the AssemblyAI LLM Gateway)

## 0.1.8

### Patch Changes

- e17fdc4: Remove the text-only dictation starter prompt (text-only agents are no longer a mode; use workflows)

## 0.1.7

### Patch Changes

- cf4b51f: Studio chat can switch models per request: the chat body accepts an optional `model` validated against the host-configured provider's own model list (LLM Gateway list, region-filtered), /studio/status advertises the list, and the studio client renders a model picker in the chat header. Providers and keys remain host-owned.

## 0.1.6

### Patch Changes

- ddd2aa6: Default the studio coding agent to gpt-5.5 on the LLM gateway and show the configured model as a chip in the studio chat header

## 0.1.5

### Patch Changes

- 0f95e0c: Rename the studio's user-facing brand name to AssemblyAI App Builder
- 857c7d3: Studio onboarding: expand the starter prompts to cover the aai-templates agent templates
- 8699bb4: Studio: a hung tool call no longer hangs the chat turn, and the user can cancel one.

  - Every coding-agent tool (studio, web, and MCP) now runs under a per-call deadline (`STUDIO_TOOL_TIMEOUT_MS`, default 120s) — a dead sandbox RPC or silent MCP server resolves to an error tool result instead of leaving the tool row shimmering forever.
  - The studio composer's send button becomes a Stop button while a turn streams; stopping aborts the SSE request, which cancels the server-side LLM stream, in-flight tool calls, and the session sandbox. Tool rows abandoned by a stop no longer shimmer.
  - A failed sandbox provisioning is no longer cached for the rest of the turn — one transient spawn failure used to answer "Sandbox unavailable" to every later `test_agent` call. Provisioning failures are now also logged host-side.

## 0.1.4

### Patch Changes

- 51d0e61: Studio client hardening: sign-out clears the query cache and applies to chat 401s, guided start can no longer create duplicate projects, IME-safe Enter handling, editor conflict warning for concurrent agent edits, live preview only reloads on publish, lazy-loaded code view, non-JSON API responses surface as ApiError, and new component/hook tests (removes the unused @alexkroman1/aai dependency).

## 0.1.3

### Patch Changes

- @alexkroman1/aai@1.9.2

## 0.1.2

### Patch Changes

- Updated dependencies [713025a]
  - @alexkroman1/aai@1.9.1

## 0.1.1

### Patch Changes

- Updated dependencies [0235618]
- Updated dependencies [4758dfc]
- Updated dependencies [0f72bef]
- Updated dependencies [bc62b75]
- Updated dependencies [7e67c24]
- Updated dependencies [8817f3f]
- Updated dependencies [394867e]
- Updated dependencies [8004ff8]
- Updated dependencies [262f1e7]
- Updated dependencies [257a372]
- Updated dependencies [0bdb115]
- Updated dependencies [578a840]
- Updated dependencies [c5a5351]
- Updated dependencies [0235618]
- Updated dependencies [0235618]
- Updated dependencies [a252842]
- Updated dependencies [bbb9d73]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [a413caf]
- Updated dependencies [d718fe9]
- Updated dependencies [2898f21]
- Updated dependencies [882e7d9]
- Updated dependencies [e2ee4fd]
- Updated dependencies [9750db7]
- Updated dependencies [0d024e0]
- Updated dependencies [cb2821c]
- Updated dependencies [9aed108]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [ab38293]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [860bb7d]
- Updated dependencies [82f8253]
- Updated dependencies [d718fe9]
- Updated dependencies [7240ce5]
- Updated dependencies [f22b0f4]
- Updated dependencies [0bb1a20]
- Updated dependencies [7d4a193]
- Updated dependencies [5bf4d41]
- Updated dependencies [ad295be]
- Updated dependencies [d22d9f8]
- Updated dependencies [8f2093b]
- Updated dependencies [296a874]
- Updated dependencies [752af3d]
- Updated dependencies [38f02fa]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [82f8253]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [2fd1078]
- Updated dependencies [711edeb]
- Updated dependencies [fd5a54e]
- Updated dependencies [a413caf]
- Updated dependencies [3db093f]
- Updated dependencies [0c57887]
- Updated dependencies [79e51cb]
- Updated dependencies [d718fe9]
- Updated dependencies [0235618]
- Updated dependencies [cf56703]
- Updated dependencies [115a88e]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
  - @alexkroman1/aai@1.9.0
