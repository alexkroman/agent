# aai-guest

## 0.4.0

### Minor Changes

- ae89dd9: Email login via Supabase Auth, for the studio and the CLI. The studio's browser bearer is now a session token (magic-link sign-in) resolved server-side to the user's stored AssemblyAI key (`user-key:<uid>` in Vault); connecting that key is the mandatory onboarding step after sign-in — every AssemblyAI key on the platform is user-provided, and the browser never holds one. `aai login` drives the same flow from the terminal via Supabase email OTP and saves the fetched key in the CLI config. A dev-token auth implementation keeps local dev Supabase-free. The guest chat surface is gated by a broker-minted per-session token instead of the caller's key. Slug-ownership hashes drop argon2id for plain SHA-256 digests (high-entropy machine keys need no slow hash), removing `@node-rs/argon2` and the verify cache. Raw API-key bearers keep working on every route.

### Patch Changes

- 4de0abe: Add studio template tools: list_templates enumerates the bundled example agents and use_template copies a template's files verbatim into the workspace
- Updated dependencies [a57905b]
- Updated dependencies [030b55f]
- Updated dependencies [966aeed]
- Updated dependencies [6cca475]
- Updated dependencies [e7a6f43]
- Updated dependencies [d303cfb]
- Updated dependencies [41d53ae]
- Updated dependencies [ae89dd9]
- Updated dependencies [cecafd3]
  - @alexkroman1/aai@5.5.0
  - @alexkroman1/aai-ui@5.5.0
  - @alexkroman1/aai-cli@5.5.0

## 0.3.3

### Patch Changes

- Updated dependencies [cb2de62]
- Updated dependencies [08dbc81]
- Updated dependencies [2198e2e]
- Updated dependencies [2198e2e]
- Updated dependencies [1d76583]
- Updated dependencies [5174cb2]
- Updated dependencies [aafe175]
  - @alexkroman1/aai@5.4.0
  - @alexkroman1/aai-ui@5.4.0
  - @alexkroman1/aai-cli@5.4.0

## 0.3.2

### Patch Changes

- Updated dependencies [27c5963]
- Updated dependencies [27c5963]
- Updated dependencies [a9ff1d1]
  - @alexkroman1/aai@5.3.0
  - @alexkroman1/aai-cli@5.3.0
  - @alexkroman1/aai-ui@5.3.0

## 0.3.1

### Patch Changes

- 2cedec1: Post-write type diagnostics in the studio coding agent: every successful write_file/edit_file type-checks the workspace (cold tsgo, coalesced) and appends hint-annotated diagnostics to the tool result; the standalone check_types tool is removed in favor of this plus test_agent.
- Updated dependencies [be1ed53]
  - @alexkroman1/aai-cli@5.2.0
  - @alexkroman1/aai@5.2.0
  - @alexkroman1/aai-ui@5.2.0

## 0.3.0

### Minor Changes

- a96e9f8: Studio preview mode: edits auto-deploy to a per-project preview agent; Publish is production-only.

  - Every settled edit (the coding agent's turn-complete workspace sync — now flagged `done: true`, the analog of opencode's `session.idle` / codex's `agent-turn-complete` — and editor file writes/deletes) schedules a coalesced, fire-and-forget deploy of the workspace to `<project>-preview` through the same in-guest `aai deploy` path Publish uses. Mid-turn checkpoints never trigger deploys, so half-finished trees are never previewed.
  - The Live tab is renamed Preview and frames the preview agent, keyed by a `previewVersion` token so a fresh preview reloads the iframe exactly once; the client polls while a preview deploy is in flight, and failed preview builds surface their CLI output in the pane banner.
  - The production URL in the top bar stays a plain link that opens the deployed agent in a new tab, and the Secrets panel mirrors writes to the preview slug so previews run with the same third-party keys.

### Patch Changes

- b1bf017: Consolidate aai-guest internals: one shared child-process runner (runCapped) replaces five hand-rolled spawn helpers, one bearer-auth module serves both authenticated surfaces, and the per-tool 120s deadline now wraps the merged studio tool set (web, project, and design tools included). Parallelize workspace snapshot/materialize/sync I/O and make grep read only glob-matching files.
- c745865: Serialize the studio build child's worker and client bundles: two concurrent Rolldown passes peak at roughly the sum of their native allocations in the one process a sandbox memory cap would OOM-kill, and the sandbox's single CPU means serializing costs no meaningful wall clock.
- 8b8249e: Revert the one-shot child-process workspace build (#845): test_agent builds run in-process in the harness again.
- Updated dependencies [ded8b64]
- Updated dependencies [e47a187]
- Updated dependencies [b829155]
- Updated dependencies [ab577dc]
  - @alexkroman1/aai-cli@5.1.1
  - @alexkroman1/aai-ui@5.1.1
  - @alexkroman1/aai@5.1.1

## 0.2.2

### Patch Changes

- d1fc1c0: Run the studio's test_agent workspace build in a one-shot child process. Rolldown allocates outside V8 and never returns that memory to the OS, so an in-process build left ~1.5 GB permanently resident in the long-lived guest harness — measured 258 MB to 1.7 GB on one build, climbing with each later one. Publish already spawned the CLI; both build paths now exit to reclaim.
- Updated dependencies [8fb0a0d]
- Updated dependencies [ac21a90]
- Updated dependencies [3bc83bb]
  - @alexkroman1/aai@5.1.0
  - @alexkroman1/aai-ui@5.1.0
  - @alexkroman1/aai-cli@5.1.0

## 0.2.1

### Patch Changes

- Updated dependencies [fb4c14c]
  - @alexkroman1/aai-ui@5.0.1
  - @alexkroman1/aai-cli@5.0.1
  - @alexkroman1/aai@5.0.1

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
- cc71fab: Workers ship their own SDK runtime, and all studio builds run in the guest sandbox through the aai CLI's bundlers.

  - `buildWorker`'s wrapper entry now bundles the user's installed SDK runtime behind an `__aaiCreateRuntime` export; the guest harness builds sessions through that factory and embeds no runtime of its own, so platform SDK drift can no longer break deployed agents. Bundles without the factory are rejected at `bundle/load`.
  - The studio's out-of-process build subsystem (build runner/entry/protocol/cache, the import-allowlist worker build, the host client build, and the `studio_build` Modal Function) is deleted. `test_agent` builds the live workspace in the guest; Publish builds via the new host→guest `workspace/build` RPC, which also returns the bundle's config self-description — no throwaway inspection sandbox on the studio path.
  - The guest snapshot image now bakes the build toolchain (`@alexkroman1/aai-cli` + workspace-facing packages) next to the harness; versions derive from aai-guest's own dependencies.
  - `MAX_WORKER_SIZE` rises to 30 MB; `evalWorkerBundle` imports workers via a temp `file:` URL (the bundled runtime's CJS interop rejects `data:` URLs); the dev server opts out of runtime inlining to keep watch rebuilds fast.
  - Studio Publish now runs the literal `aai deploy` CLI inside the project's sandbox (`workspace/deploy`), and the CLI's output is posted into the chat so the coding agent sees deploy errors. `aai deploy` gains `--allow-missing-secrets` (server-side `credentialPolicy: "warn"` in the deploy body), and deploy responses now carry preflight `warnings`.
  - The studio's storage toggle and routes are removed — storage is CLI-only (`aai storage enable`). Deployed-agent secrets move to their own Secrets panel backed by the platform's `/:slug/secret` routes; every change posts a note into the chat (key names only).
  - `aai build` and `aai deploy` now type-check the project (`tsc --noEmit` with its own tsconfig and compiler; `--skipTypecheck` opts out), as does the studio's `test_agent`. Studio workspaces are completed into real projects in the guest (package.json, tsconfig.json, global.d.ts, vite.config.ts — scaffold-mirroring, existing files win).

### Patch Changes

- Updated dependencies [c36ad60]
- Updated dependencies [9b95fc9]
- Updated dependencies [5a599b2]
- Updated dependencies [e8fef4b]
- Updated dependencies [0c2bdbd]
- Updated dependencies [25938b2]
- Updated dependencies [0c2bdbd]
- Updated dependencies [0c2bdbd]
- Updated dependencies [6fb3bc3]
- Updated dependencies [55e045b]
- Updated dependencies [0c2bdbd]
- Updated dependencies [293da11]
- Updated dependencies [0c2bdbd]
- Updated dependencies [0c2bdbd]
- Updated dependencies [30914c9]
- Updated dependencies [0c2bdbd]
- Updated dependencies [0c2bdbd]
- Updated dependencies [5a599b2]
- Updated dependencies [01cecc1]
- Updated dependencies [9867aa3]
- Updated dependencies [d4c2a10]
- Updated dependencies [0c2bdbd]
- Updated dependencies [e8fef4b]
- Updated dependencies [293da11]
- Updated dependencies [e8fef4b]
- Updated dependencies [30914c9]
- Updated dependencies [fdd64ef]
- Updated dependencies [0c2bdbd]
- Updated dependencies [cc71fab]
  - @alexkroman1/aai@5.0.0
  - @alexkroman1/aai-ui@5.0.0
  - @alexkroman1/aai-cli@5.0.0
