# aai-studio-server

## 0.5.6

### Patch Changes

- 6b4a6d8: Run the platform on Node 26: the Modal service image, the guest sandbox base image, the repo's pinned toolchain, and CI all move from 24 to 26, matching the `@types/node` major the workspace already type-checks against. Published SDK packages keep `engines.node: >=24` so consumers on the previous LTS are unaffected.
- Updated dependencies [b125465]
- Updated dependencies [1731876]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [fb7b545]
- Updated dependencies [b125465]
- Updated dependencies [c7617df]
- Updated dependencies [b125465]
- Updated dependencies [520900f]
- Updated dependencies [b125465]
- Updated dependencies [c524b76]
- Updated dependencies [b125465]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [6b4a6d8]
- Updated dependencies [ae9fd19]
- Updated dependencies [b125465]
- Updated dependencies [6ca79e0]
- Updated dependencies [b125465]
- Updated dependencies [fee8ece]
- Updated dependencies [ae9fd19]
- Updated dependencies [d8e34d8]
- Updated dependencies [a90296e]
- Updated dependencies [b125465]
- Updated dependencies [a82e54d]
- Updated dependencies [4b6e064]
- Updated dependencies [1c5056f]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [ae9fd19]
  - @alexkroman1/aai@5.10.0
  - aai-server@3.4.6
  - aai-studio-client@0.4.6
  - @alexkroman1/aai-ui@5.10.0

## 0.5.5

### Patch Changes

- aai-server@3.4.5
- @alexkroman1/aai@5.9.0
- @alexkroman1/aai-ui@5.9.0
- aai-studio-client@0.4.5

## 0.5.4

### Patch Changes

- ba1aacd: Read preview-queue jobs back when the driver returns jsonb as a string, instead of archiving every job as unreadable
  - aai-server@3.4.4
  - @alexkroman1/aai@5.8.1
  - @alexkroman1/aai-ui@5.8.1
  - aai-studio-client@0.4.4

## 0.5.3

### Patch Changes

- d140e9b: Make auto preview deploys durable with a pgmq-backed queue instead of in-process state
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
  - aai-server@3.4.3
  - @alexkroman1/aai@5.8.0
  - @alexkroman1/aai-ui@5.8.0
  - aai-studio-client@0.4.3

## 0.5.2

### Patch Changes

- Updated dependencies [56efab9]
- Updated dependencies [842d229]
- Updated dependencies [1c034af]
- Updated dependencies [1908738]
  - @alexkroman1/aai@5.7.0
  - aai-studio-client@0.4.2
  - aai-server@3.4.2
  - @alexkroman1/aai-ui@5.7.0

## 0.5.1

### Patch Changes

- d0475b5: Regenerate a project's preview when opening it finds the preview agent gone: the wake-up's sandbox warm-up now doubles as an existence check, and a 404 from the client-config broker clears the stale previewHash stamp and schedules a redeploy instead of leaving the pane pointing at a deleted agent forever.
- Updated dependencies [fb288d2]
- Updated dependencies [9da9f65]
  - aai-server@3.4.1
  - aai-studio-client@0.4.1

## 0.5.0

### Minor Changes

- 5cd6d50: Replace Supabase magic-link email sign-in with GitHub OAuth, and rework `aai login` as a device-link flow: the CLI no longer signs in (or creates accounts) itself — it opens the studio with a one-shot link code that a signed-in browser session approves, then exchanges the code for the account's stored API key. The `GET /studio/account/key` route is removed in favor of the one-shot exchange.
- 29fa487: Studio scope unification and workspace source sync: raw API keys stored via the account route reverse-map to the owning studio user (`key-user:<sha256(key)>`), so a linked CLI shares the browser's project scope; new `PUT /studio/projects/:project/source` replaces a workspace's file map atomically with a files-hash fast-forward token (`sourceHash` now returned by project GET/SSE payloads); deleting a studio project cascades to its deployed and preview agents through the shared `deleteAgentResources` core, ownership-gated per slug.

### Patch Changes

- 77b0a80: Evict idle studio coding-agent sandboxes after 5 minutes instead of 15, matching the agent guest's own idle self-exit.
- 93e7694: Landing on a studio project now wakes its preview: the once-per-open session broker call reschedules a stale preview deploy (one dropped by a replica restart no longer leaves the pane on "Updating preview…" until the next edit) and warms the preview agent's sandbox through the platform's client-config broker, so an idle-evicted preview is booting before the Preview pane's iframe asks for it.
- 77b0a80: Fix four sandbox-lifecycle defects found by stress testing: a stale studio chat token signing the user out, a silent TTS drain timeout, an unhandled publish-sandbox failure, and an unreachable guest idle-exit override.
- 1673d91: Allow the Supabase auth origin in the studio page's connect-src, so magic-link sign-in is not blocked by CSP (it failed as a bare "Failed to fetch" with nothing on the server)
- c3f3c9a: Pin `SANDBOX_POOL_SIZE=0` in both Modal apps' image env: the warm sandbox pool stays disabled in production (no pre-warmed guest sandboxes). The `aai-server` Secret must not set `SANDBOX_POOL_SIZE`, since Secret values override image env and would silently re-enable the pool.
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [e2a473a]
- Updated dependencies [753665a]
- Updated dependencies [77b0a80]
- Updated dependencies [5cd6d50]
- Updated dependencies [77b0a80]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [8b622e8]
- Updated dependencies [29fa487]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [8b622e8]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [c3f3c9a]
  - @alexkroman1/aai@5.6.0
  - aai-studio-client@0.4.0
  - aai-server@3.4.0
  - @alexkroman1/aai-ui@5.6.0

## 0.4.1

### Patch Changes

- Updated dependencies [ea63c42]
- Updated dependencies [1a6f800]
  - aai-studio-client@0.3.4
  - @alexkroman1/aai@5.5.1
  - aai-server@3.3.1
  - @alexkroman1/aai-ui@5.5.1

## 0.4.0

### Minor Changes

- 6cca475: Storage redesign: each agent is one Postgres row (aai_platform.agents) — slug, credential hashes, config, content hashes, deploy version — committing content-addressed immutable blobs (blobs/<sha256>) in Storage. The row upsert is the deploy's atomic publish point; manifest.json/config.json and the slug_epochs table are gone (the deploy version is the cross-replica invalidation signal). Secret and storage changes no longer restart sandboxes: they take effect on the next deploy or sandbox rebuild.
- ae89dd9: Email login via Supabase Auth, for the studio and the CLI. The studio's browser bearer is now a session token (magic-link sign-in) resolved server-side to the user's stored AssemblyAI key (`user-key:<uid>` in Vault); connecting that key is the mandatory onboarding step after sign-in — every AssemblyAI key on the platform is user-provided, and the browser never holds one. `aai login` drives the same flow from the terminal via Supabase email OTP and saves the fetched key in the CLI config. A dev-token auth implementation keeps local dev Supabase-free. The guest chat surface is gated by a broker-minted per-session token instead of the caller's key. Slug-ownership hashes drop argon2id for plain SHA-256 digests (high-entropy machine keys need no slow hash), removing `@node-rs/argon2` and the verify cache. Raw API-key bearers keep working on every route.

### Patch Changes

- b425548: Simplify platform server internals: shared memoized-async helper, one broker dependency set, workspace lock moved inside mutateWorkspace, studio project middleware, cached user-key resolution, and dead-code removal
- Updated dependencies [a57905b]
- Updated dependencies [030b55f]
- Updated dependencies [966aeed]
- Updated dependencies [6cca475]
- Updated dependencies [afe0b6d]
- Updated dependencies [dcb1f99]
- Updated dependencies [c567faa]
- Updated dependencies [d303cfb]
- Updated dependencies [41d53ae]
- Updated dependencies [6cca475]
- Updated dependencies [ae89dd9]
- Updated dependencies [b425548]
  - @alexkroman1/aai@5.5.0
  - @alexkroman1/aai-ui@5.5.0
  - aai-server@3.3.0
  - aai-studio-client@0.3.3

## 0.3.4

### Patch Changes

- Updated dependencies [cb2de62]
- Updated dependencies [08dbc81]
- Updated dependencies [2198e2e]
- Updated dependencies [2198e2e]
- Updated dependencies [4076382]
- Updated dependencies [1d76583]
- Updated dependencies [5174cb2]
- Updated dependencies [2d7913d]
- Updated dependencies [aafe175]
  - @alexkroman1/aai@5.4.0
  - @alexkroman1/aai-ui@5.4.0
  - aai-studio-client@0.3.2
  - aai-server@3.2.6

## 0.3.3

### Patch Changes

- Updated dependencies [65a1a92]
- Updated dependencies [27c5963]
- Updated dependencies [27c5963]
- Updated dependencies [01d8a5f]
  - aai-studio-client@0.3.1
  - @alexkroman1/aai@5.3.0
  - aai-server@3.2.5
  - @alexkroman1/aai-ui@5.3.0

## 0.3.2

### Patch Changes

- e6e9cbf: Default the studio coding agent's LLM to gpt-5.5 on the AssemblyAI LLM Gateway (gpt-5-mini stays second; the EU default remains claude-sonnet-4-6)
- ffaae91: Give studio-spawned guest sandboxes the same burst-range resources as the agent app — test_agent and Publish builds run on them
- 2cedec1: Post-write type diagnostics in the studio coding agent: every successful write_file/edit_file type-checks the workspace (cold tsgo, coalesced) and appends hint-annotated diagnostics to the tool result; the standalone check_types tool is removed in favor of this plus test_agent.
- 99f3655: Stop cutting live calls on deploy, and make a deploy reach every replica.

  - A deploy/secret/storage mutation now **retires** the superseded sandbox
    instead of terminating it: it is detached from its slot synchronously (so no
    new session can be brokered onto it) and its remaining calls drain in the
    background before it shuts down, bounded by `SANDBOX_RETIRE_DRAIN_MS`.
  - The slot's idle timer now checks the slug epoch as well as the session
    count, so a deploy that landed on another replica is picked up within
    `IDLE_SANDBOX_MS` instead of only at that replica's next session broker.
    Previously a sandbox with continuous traffic was never reclaimed at all.
  - The shutdown drain counts sessions inside the guest sandboxes, not just
    WebSockets to the server process. Sessions dial the sandbox tunnel
    directly, so the old count always read zero and scale-in tore down live
    calls immediately despite a 120s drain budget.

- Updated dependencies [99f3655]
  - aai-server@3.2.4
  - @alexkroman1/aai@5.2.0
  - @alexkroman1/aai-ui@5.2.0

## 0.3.1

### Patch Changes

- Updated dependencies [ee903c5]
  - aai-server@3.2.3

## 0.3.0

### Minor Changes

- a96e9f8: Studio preview mode: edits auto-deploy to a per-project preview agent; Publish is production-only.

  - Every settled edit (the coding agent's turn-complete workspace sync — now flagged `done: true`, the analog of opencode's `session.idle` / codex's `agent-turn-complete` — and editor file writes/deletes) schedules a coalesced, fire-and-forget deploy of the workspace to `<project>-preview` through the same in-guest `aai deploy` path Publish uses. Mid-turn checkpoints never trigger deploys, so half-finished trees are never previewed.
  - The Live tab is renamed Preview and frames the preview agent, keyed by a `previewVersion` token so a fresh preview reloads the iframe exactly once; the client polls while a preview deploy is in flight, and failed preview builds surface their CLI output in the pane banner.
  - The production URL in the top bar stays a plain link that opens the deployed agent in a new tab, and the Secrets panel mirrors writes to the preview slug so previews run with the same third-party keys.

### Patch Changes

- b4cec81: Simplify aai-server internals: shared matchAnyHash/withLock/sleep/answerUpgrade/brokerSessionUrl helpers, epoch-guarded cache helper with in-flight manifest sharing, safeJsonParse adoption, OwnedMap.owns at slot identity checks, and removal of dead options and stale comments
- 31cdbaf: Tag Modal sandboxes with a role (agent, preview, studio, studio-publish, inspect, pool) alongside the slug, and re-tag pooled sandboxes on acquire, so the Modal dashboard distinguishes production agents from previews, studio sessions, and warm-pool spares
- Updated dependencies [e47a187]
- Updated dependencies [b829155]
- Updated dependencies [d78137f]
- Updated dependencies [a96e9f8]
- Updated dependencies [b4cec81]
- Updated dependencies [ab577dc]
- Updated dependencies [31cdbaf]
  - @alexkroman1/aai-ui@5.1.1
  - @alexkroman1/aai@5.1.1
  - aai-studio-client@0.3.0
  - aai-server@3.2.2

## 0.2.4

### Patch Changes

- 38c1b97: Auto-create studio projects from the first chat message with server-generated v0-style names (prompt-derived base + random suffix) at shareable /studio/chat/<name> URLs; slugless CLI deploys now generate slugs from the agent's config name via the same shared generator.
- Updated dependencies [675ac6d]
- Updated dependencies [38c1b97]
- Updated dependencies [0b39214]
  - aai-studio-client@0.2.1
  - aai-server@3.2.1

## 0.2.3

### Patch Changes

- 57c8b03: Forward Modal container stop signals to the node server so guest-sandbox teardown actually runs on scale-in/redeploy — orphaned sandboxes no longer linger as 2-3 MiB sleep-infinity shells for the ~20-minute orphan + idle window on every deploy
- Updated dependencies [8fb0a0d]
- Updated dependencies [fa3f3fd]
- Updated dependencies [ac21a90]
- Updated dependencies [3bc83bb]
- Updated dependencies [57c8b03]
  - @alexkroman1/aai@5.1.0
  - aai-server@3.2.0
  - @alexkroman1/aai-ui@5.1.0

## 0.2.2

### Patch Changes

- fb4c14c: Resolve the public origin through aai-server/public-origin instead of the in-container request URL, so studio Publish deploys over https and keeps its Authorization header, and the bare-slug redirect stops downgrading the scheme. Version bump so both Modal apps redeploy.
- Updated dependencies [fb4c14c]
- Updated dependencies [fb4c14c]
  - aai-server@3.1.2
  - @alexkroman1/aai-ui@5.0.1
  - @alexkroman1/aai@5.0.1

## 0.2.1

### Patch Changes

- 23a3a5d: Fix Modal containers crashing at startup with ModuleNotFoundError: mount scripts/modal_image.py into the container image via add_local_python_source so the deploy script's import resolves when Modal re-imports it inside the container.
- Updated dependencies [23a3a5d]
  - aai-server@3.1.1

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
- fdd64ef: New package: the studio service (browser coding agent, workspace builds) split out of aai-server, with its own Modal app, scaling policy, and changeset-gated CI deploys. Also hosts the combined single-process entry used by local dev.
- 293da11: The studio LLM now runs exclusively on the caller's own AssemblyAI API key
  (the request bearer) via the LLM Gateway — the platform holds no studio LLM
  credential: the `ASSEMBLYAI_API_KEY`/`ANTHROPIC_API_KEY` host fallbacks,
  `STUDIO_LLM_PROVIDER`, and the chat 503-when-unconfigured path are removed
  (`STUDIO_LLM_MODEL`/`STUDIO_LLM_REGION` remain as host model config). With
  `web_search` now keyless, the dev-boot key check (`assertDevKeys`) is
  removed from both services.
- cc71fab: Workers ship their own SDK runtime, and all studio builds run in the guest sandbox through the aai CLI's bundlers.

  - `buildWorker`'s wrapper entry now bundles the user's installed SDK runtime behind an `__aaiCreateRuntime` export; the guest harness builds sessions through that factory and embeds no runtime of its own, so platform SDK drift can no longer break deployed agents. Bundles without the factory are rejected at `bundle/load`.
  - The studio's out-of-process build subsystem (build runner/entry/protocol/cache, the import-allowlist worker build, the host client build, and the `studio_build` Modal Function) is deleted. `test_agent` builds the live workspace in the guest; Publish builds via the new host→guest `workspace/build` RPC, which also returns the bundle's config self-description — no throwaway inspection sandbox on the studio path.
  - The guest snapshot image now bakes the build toolchain (`@alexkroman1/aai-cli` + workspace-facing packages) next to the harness; versions derive from aai-guest's own dependencies.
  - `MAX_WORKER_SIZE` rises to 30 MB; `evalWorkerBundle` imports workers via a temp `file:` URL (the bundled runtime's CJS interop rejects `data:` URLs); the dev server opts out of runtime inlining to keep watch rebuilds fast.
  - Studio Publish now runs the literal `aai deploy` CLI inside the project's sandbox (`workspace/deploy`), and the CLI's output is posted into the chat so the coding agent sees deploy errors. `aai deploy` gains `--allow-missing-secrets` (server-side `credentialPolicy: "warn"` in the deploy body), and deploy responses now carry preflight `warnings`.
  - The studio's storage toggle and routes are removed — storage is CLI-only (`aai storage enable`). Deployed-agent secrets move to their own Secrets panel backed by the platform's `/:slug/secret` routes; every change posts a note into the chat (key names only).
  - `aai build` and `aai deploy` now type-check the project (`tsc --noEmit` with its own tsconfig and compiler; `--skipTypecheck` opts out), as does the studio's `test_agent`. Studio workspaces are completed into real projects in the guest (package.json, tsconfig.json, global.d.ts, vite.config.ts — scaffold-mirroring, existing files win).

### Patch Changes

- 52d60d6: Studio coding agent: edit_file gains replaceAll for cross-file renames, and a todo_write task-list tool (with prompt guidance) tracks multi-step requests
- a2c387a: Move the studio_build Modal Function into the studio app (aai-studio-web) so the build entry's code and its deployment version together — a changeset touching aai-studio-server previously redeployed the studio service but left the agent app's studio_build function running the old entry.
- 293da11: Run the studio coding agent's CPU-bearing tool work off the main thread:
  `grep`'s regex scan and `edit_file`'s fuzzy matching + Myers diff now
  execute on a dedicated scan worker thread with a hard
  `worker.terminate()` deadline (2s). Previously both ran model-controlled
  input through superlinear algorithms on the server's event loop, where a
  catastrophic regex (`(a+)+$`) could pin every session on the process
  indefinitely and a large mostly-different edit stalled it for ~7s — and
  the per-tool pTimeout cannot stop either, since a promise race needs the
  event loop the computation is pinning. Worker failures cross the thread
  boundary as classified wire data and rehydrate to the same
  `StudioGrepError`/`StudioEditError` the sync implementations throw; the
  presentation diff additionally self-elides at 500ms (jsdiff `timeout`) so
  an oversized-but-legit edit still applies. Invalid globs now surface as
  actionable `StudioGrepError`s instead of unclassified throws.
- 78af4d2: Developer mode on macOS now runs guest sandboxes in local Apple containers (via the container CLI) instead of Modal; SANDBOX_BACKEND overrides the selection.
- Updated dependencies [fdd64ef]
- Updated dependencies [c36ad60]
- Updated dependencies [9b95fc9]
- Updated dependencies [5a599b2]
- Updated dependencies [fdd64ef]
- Updated dependencies [fdd64ef]
- Updated dependencies [e8fef4b]
- Updated dependencies [0c2bdbd]
- Updated dependencies [25938b2]
- Updated dependencies [df753ce]
- Updated dependencies [fdd64ef]
- Updated dependencies [0c2bdbd]
- Updated dependencies [fdd64ef]
- Updated dependencies [0c2bdbd]
- Updated dependencies [6fb3bc3]
- Updated dependencies [55e045b]
- Updated dependencies [0c2bdbd]
- Updated dependencies [293da11]
- Updated dependencies [0c2bdbd]
- Updated dependencies [30914c9]
- Updated dependencies [0c2bdbd]
- Updated dependencies [0c2bdbd]
- Updated dependencies [01cecc1]
- Updated dependencies [a2c387a]
- Updated dependencies [d4c2a10]
- Updated dependencies [338a61e]
- Updated dependencies [0c2bdbd]
- Updated dependencies [e8fef4b]
- Updated dependencies [293da11]
- Updated dependencies [e8fef4b]
- Updated dependencies [fdd64ef]
- Updated dependencies [293da11]
- Updated dependencies [30914c9]
- Updated dependencies [fdd64ef]
- Updated dependencies [0c2bdbd]
- Updated dependencies [cc71fab]
- Updated dependencies [78af4d2]
  - aai-server@3.1.0
  - @alexkroman1/aai@5.0.0
  - @alexkroman1/aai-ui@5.0.0
  - aai-studio-client@0.2.0
