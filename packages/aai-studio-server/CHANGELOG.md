# aai-studio-server

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
