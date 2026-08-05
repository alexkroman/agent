# aai-studio-server — the studio service (private)

The browser coding agent, workspace builds, and the combined entry. It talks to
its front-end ([aai-studio-client](../aai-studio-client/CLAUDE.md)) purely over
HTTP/SSE and shares the platform core from
[aai-server](../aai-server/CLAUDE.md). Repo-wide commands and conventions live
in the root [CLAUDE.md](../../CLAUDE.md).

- `packages/aai-studio-server/` — the browser studio server side, its own
  package/service (see "Browser studio"):
  `studio-routes.ts` (HTTP surface), `studio-session-broker.ts` (per-project
  coding-agent sandboxes: boot via the shared `spawnWarmHarness` machinery, session
  install, guest RPC handlers, `buildWorkspace` for Publish, idle
  eviction), `studio-session-registry.ts` (the cross-replica row that makes
  a project's sandbox one fleet-wide, not one per replica),
  `studio-session-adopt.ts` (installing a session into a PEER's guest over
  HTTP), `studio-session-fleet.ts` (the broker's view of the REST of the
  fleet), `studio-session-wire.ts` (the guest→host half of the control
  channel + its validation), `studio-session-publish.ts` (one deploy of a
  workspace — Publish and the auto preview deploys share it),
  `studio-llm.ts` (gateway model config; the key is always the
  caller's), `studio-deploy.ts` (guest build → validate config →
  deploy), `studio-workspace.ts` (project file store), `studio-prompt.ts` +
  `studio-preamble.ts` (system prompt: the v0-style preamble plus the
  scaffold CLAUDE.md), `studio-sse.ts` (shared payload builder + stream
  lifecycle behind both project-event routes), `studio-account-routes.ts`
  (browser-session account surface, incl. the `aai login` device link),
  `studio-template.ts` (a new project starts EMPTY — read the file before
  changing that), `studio-static.ts` (serves the built client)
### Browser studio (aai-studio-server)

Loading the platform server root (`GET /`) serves the **studio** — a
browser-based coding agent (TypeScript agent loop on the Vercel AI SDK,
the same `streamText` stack pipeline mode uses) that builds and deploys
voice agents without the CLI:

- **Workspaces** are small server-side file trees stored one row per
  project in Postgres (`aai_platform.studio_workspaces`, over the same
  platform `SqlExec` Vault uses; in-memory store in dev/tests —
  `workspace-store.ts`, same two-implementation pattern as
  `SecretStore`). Blob `Storage` serves only deploy artifacts. Rows carry an
  optimistic `version`: writes go through `createWorkspace` /
  `mutateWorkspace` (`studio-workspace.ts`), which retry a conflicted write
  once — an in-process keyed lock (`createKeyedLock` from
  `aai-server/platform-barrel`, in `studio-workspace.ts`) still serializes
  local writers, so a conflict means another replica. `scope` is
  a *deterministic* SHA-256 (`studioScope`) — stable so a caller can find
  its projects again. Browser sessions scope by the studio USER id
  (`user:<uid>` — stable across AssemblyAI key rotation); a raw-key caller
  whose key some account stored via `PUT /studio/account/key` resolves to
  the SAME `user:<uid>` scope (the `key-user:<sha256(key)>` reverse mapping
  in `resolveBearer` — this is what makes a linked `aai` CLI and the
  browser see one project list); only a raw key NO account has claimed
  (evals, programmatic callers) scopes by the key itself (`requestScope` in
  `studio-routes.ts`).
- **The CLI round-trips workspaces** (`aai list/pull/push/publish/delete` —
  see the aai-cli section): `GET /studio/projects/:project` returns
  `sourceHash` (the stamped files hash) as the pull's fast-forward token,
  and `PUT /studio/projects/:project/source` (`syncWorkspaceSource` in
  `studio-workspace.ts`) replaces the whole file map atomically — upserting
  on first push (reserved-name + create-rate-limit gated), 409ing when
  `baseHash` no longer matches the stored files, no-oping (no version bump,
  no preview churn) when the pushed files are byte-identical. The token is
  deliberately the FILES hash, never the row version: preview/Publish stamp
  metadata (bumping the version) right after every settled edit, so a
  version token would go stale on almost every push while the files were
  untouched. `DELETE /studio/projects/:project` deletes THE PROJECT —
  workspace, chat, and its deployed + preview agents via the shared
  `deleteAgentResources` core, each slug gated by `verifySlugOwner` so a
  workspace naming a foreign slug is never a deletion oracle.
- **Projects are created from the chat, not a dialog.** The client has no
  new-project modal: typing the first message (the home hero's prompt box,
  `home.tsx`) posts it as `prompt` to
  `POST /studio/projects`, and the SERVER mints the name — prompt-derived
  base + random suffix, v0-style (`contact-form-x7k2mq`), via the same
  `aai-server/slug-generate.ts` generator slugless CLI deploys use (those
  seed from the agent's config `name` instead). Each project lives at a
  shareable `/studio/chat/<name>` URL: the studio serves the shell for that
  path and the client syncs selection with pushState/popstate. An explicit
  `name` in the create body remains for programmatic callers (evals, tests).
- **Chat runs IN the project's sandbox, and the browser connects to it
  DIRECTLY** — mirroring the voice path. `POST /studio/projects/:project/
  session` (rate-limited; `studio-session-broker.ts`) boots or reuses a
  guest sandbox through the same `spawnWarmHarness` machinery
  deployed agents use, installs the session over the control channel
  (`studio/session-init`: workspace files, the caller's own key, system
  prompt, model config), and returns the sandbox's public chat URL. The
  browser then streams turns straight to the guest's `POST /studio/chat`
  (SSE, the AI SDK UI message stream `useChat` consumes) — chat turns never
  pass through the platform host. The agentic loop (`streamText`, up to
  `MAX_CHAT_STEPS` = 80 steps, and a wall-clock turn budget —
  `aai-guest/studio-turn-budget.ts`) runs in the guest (`aai-guest/
  studio-chat.ts`) with Claude-Code-style tools over a real filesystem
  workspace (`aai-guest/studio-tools.ts`): list/read (windowed, numbered —
  opencode's read semantics)/write/edit/delete, `glob`, `grep`, `bash`
  (real shell in the container, guest token scrubbed from its env),
  `todo_write`, `test_agent`, the template tools
  (`aai-guest/studio-template-tools.ts`: `list_templates` enumerates the
  worked examples bundled in the toolchain's
  `@alexkroman1/aai-cli/dist/templates`, and `use_template` copies a
  template's files VERBATIM into the workspace — same conflict/byte/count
  caps and post-copy type diagnostics as `write_file`, so the agent never
  retypes template code by hand), and the keyless web builtins. Tool CPU —
  regex, diff, whatever `bash` runs — burns the tenant's own sandbox,
  which is why the host-side scan worker was deleted. Every successful
  `write_file`/`edit_file` type-checks the workspace and appends the
  (hint-annotated, capped) diagnostics to the tool result
  (`aai-guest/studio-write-diagnostics.ts`) — TS7's native tsc checks a
  studio workspace in well under a second, so this is a cold spawn per
  settled write burst (concurrent writes coalesce), NOT a resident LSP
  server: opencode's post-edit-diagnostics loop without a ~200 MB
  language-server process in a memory-capped sandbox. The write is never
  rejected on type errors (mid-refactor states are legitimate — the
  syntax gate in `studio-syntax.ts` owns the unrecoverable class), and a
  slow or missing compiler degrades to the plain write result. This
  replaced the standalone `check_types` tool — evals showed agents
  thrashing on it (sixteen checks, zero builds); `test_agent` is the one
  verification tool. The guest chat
  surface is bearer-gated by a broker-minted per-session `chatToken` (the
  tunnel URL is public; the token rides `studio/session-init` to the guest
  and the broker response to the browser, so no long-lived credential ever
  crosses the public surface) and CORS-open; `GET /studio/tools` on the
  same surface serves the user-friendly tool labels (`STUDIO_TOOL_LABELS`)
  the client renders.
  End of turn, the guest pushes state back over the control channel:
  `studio/sync-workspace` (validated like a client file PUT; only
  workspace source files — never node_modules/dist/.git — sync, under the
  same file caps) and `studio/persist-chat` (the settled conversation →
  `aai_platform.studio_chats`, restored on project open via
  `GET /studio/projects/:project/chat`). `test_agent` builds the live
  workspace IN the guest through the aai CLI's own bundlers
  (`aai-guest/studio-build.ts` — the toolchain node_modules are baked next
  to the harness) and loads/trials the bundle in place; Publish runs the
  literal CLI via the host→guest `workspace/deploy` RPC. Sandboxes are per
  (scope, project) FLEET-WIDE — the in-process map is backed by
  `aai_platform.studio_sessions`, so a broker call landing on another
  replica adopts the live guest instead of spawning a second one (see "One
  studio sandbox per project, fleet-wide") — with a 5-min idle eviction
  (matching the agent guest's
  own idle self-exit); a dead one heals on the next
  broker call, and the client re-brokers on ANY rejection from the chat
  surface — a rejected fetch, a 409, or a **401**. That last one matters
  because the guest's chat surface authenticates ONLY the `chatToken`; it
  never sees an account credential, so a 401 there means "stale session",
  not "bad user". Routing it to the app's re-authenticate path signed the
  user out of the studio outright. **The `chatToken` is minted once per
  SANDBOX**, not per broker call, for the same reason: the guest holds
  exactly one, so re-minting on a re-init revoked the token every earlier
  caller still held — and overlapping brokers (a second tab, another
  device, a reload racing an in-flight one) are exactly what the session
  lock below exists for. A replacement sandbox does mint a fresh one.
  **`ensureSession` is serialized per (scope, project), and entries are
  disposed by identity, not by key.** Overlapping brokers for one project are
  routine (a double-click, a StrictMode double effect, a refresh landing on
  an in-flight one); unserialized, both take the cold path and the loser's
  sandbox is ORPHANED — absent from `sessions`, so neither the idle sweeper
  nor `dispose()` can ever reach it. It burns its orphan timeout plus Modal's
  idle window billed, and its `wire()` handlers stay live, so its end-of-turn
  `studio/sync-workspace` keeps writing the project behind the tracked
  sandbox's back. The identity check matters for the same reason
  `createOwnedMap` exists on the agent side: every cleanup runs after an
  await (a rejected re-init, a publish whose sandbox died mid-request), by
  which point the key may hold a replacement that must not be evicted.
- **No MCP.** The studio's coding agent has no MCP integration (the docs
  MCP server it once connected to was removed). The system prompt embeds a
  *snapshot* of the scaffold guide; anything outside it — a voice, a newly
  added gateway model, a provider option — the prompt tells the agent to
  look up with `visit_webpage` (the AssemblyAI docs included) rather than
  guess.
- **Ground truth on disk: the baked toolchain, reachable only with `bash`.**
  The guest's `/opt/aai/node_modules` holds `@alexkroman1/aai` (SDK `.d.ts`),
  `@alexkroman1/aai-ui` (`dist/index.d.ts` plus per-component
  `dist/components/*.d.ts` — the API for `client.tsx`; no `.tsx` source
  ships), and `@alexkroman1/aai-cli`, whose `dist/templates/` carries the
  full template set — five of which have a real `client.tsx`. All of it sits
  ABOVE the session workspace (`<harness>/.workspaces/session-<pid>`), so
  `read_file` (jailed by `resolveInside`), `glob`, and `grep` (which skip
  `node_modules`) cannot see any of it — only `bash` can. Before this, the
  embedded guide pointed the agent at `packages/aai-templates/templates/` —
  a monorepo path that exists in no sandbox, and in no user project either.

  **The GUEST names those paths, not the preamble** (`toolchainPromptSection`
  in `aai-guest/studio-chat.ts`, appended to the host-composed prompt at
  `initStudioSession`). The host cannot: the harness sits at a different
  depth per layout — `/opt/aai/harness.mjs` beside `/opt/aai/node_modules` in
  the baked image, but `packages/aai-guest/dist/harness.mjs` under the
  subprocess backend, whose `node_modules` is a level higher again. A
  relative `../../node_modules` is therefore correct in production and wrong
  in local dev, and unit tests load the module from *source*, a third layout
  where it is accidentally right again — so that bug reads as correct from
  every angle a test can take. `toolchainRoot()` searches upward for
  `node_modules/@alexkroman1/aai` instead of assuming an offset, emits
  absolute paths (the only form that survives a `bash` call with an
  unexpected cwd), and returns `""` rather than naming paths it could not
  resolve. `studio-build.test.ts` asserts every path the section emits
  exists.
- **The workspace manifest declares what the agent may import.**
  `ensureProjectShape` writes a `package.json` whose `dependencies` mirror
  the scaffold's runtime set (`@alexkroman1/aai`, `aai-ui`, `react`,
  `react-dom`, `tailwindcss`, `zod` — drift-guarded against the scaffold in
  `studio-project-shape.test.ts`). It used to declare none, on the reasoning
  that they resolve from the toolchain anyway — true for the *build*, and
  exactly backwards for the *reader*: package.json is the first place a
  coding agent looks to learn what it can import, and an empty one asserted
  the opposite of the truth. Versions are pinned **exact**, read from the
  installed toolchain (`resolveWorkspaceDependencies`), because
  `add_dependency` runs `npm install <spec>` and npm reifies the whole
  manifest — a range would let the workspace materialize a different SDK
  build than the harness resolved, into a workspace-local `node_modules`
  that *shadows* the baked one. Pinned, the local copy is byte-identical and
  the shadowing is merely redundant. Toolchain-only packages (vite,
  typescript, the `@types/*`) stay undeclared: the agent never imports them,
  and every entry is one more package that install has to reify.
- **Guest tools carry their own deadlines** (`aai-guest/studio-tools.ts`):
  every tool is wrapped in a 120s timeout resolving to an error tool
  result, and `bash` has its own wall-clock kill (60s default, 300s max)
  with capped, tail-kept output. The client side of a hung turn is the
  composer's **Stop button** (`chat.tsx`): `useChat().stop()` aborts the
  SSE fetch to the sandbox, whose request-close handler aborts
  `streamText` and in-flight tools in the guest.
- **Web access**: the SDK's keyless `visit_webpage`, `get_page_design`,
  and `web_search` builtins (DuckDuckGo-backed — no key anywhere), mapped
  into the guest tool set (`createGuestWebTools` in `aai-guest/
  studio-chat.ts`). They run in the guest with open egress like all tenant
  code; `safeFetch` still screens the model-controlled URLs, and the tool
  context carries an empty env.
- **The Preview pane shows an auto-deployed PREVIEW agent; Publish is
  production.** Every settled edit — the guest's TURN-COMPLETE
  `studio/sync-workspace` (flagged `done: true`, the analog of opencode's
  `session.idle` / codex's `agent-turn-complete`; mid-turn checkpoints
  share the RPC but never carry the flag, so a half-finished tree is never
  deployed) and editor file PUT/DELETEs — schedules a deploy of the
  workspace to the project's preview slug (`<project>-preview`) through
  the same in-guest `aai deploy` path Publish uses (`studio-preview.ts`:
  fire-and-forget, coalesced per project, no-op when the preview already
  matches). Success stamps `previewSlug`/`previewHash` on the workspace;
  failure stamps `previewError` for the pane's banner (an auto-deploy has
  no chat turn to carry CLI output). `GET /studio/projects/:project`
  returns `previewSlug`/`previewVersion`/`previewStale`/`previewError`,
  and `GET /studio/projects/:project/events` streams the same payload as
  SSE (`project` frames), pushed on every workspace-row change (Supabase
  Realtime `postgres_changes` server-side — see `platform-events.ts`; the
  events are signals and the route re-reads the row per push), plus `chat`
  frames carrying the settled conversation whenever a turn persists, so
  other tabs/devices stay current. `GET /studio/events` streams the
  caller's project LIST the same way (scope-level workspace changes), so
  the home sidebar updates across devices. The client subscribes on
  project open / while signed in — there is NO polling loop — and keys the
  iframe by `previewVersion`, so a fresh preview reloads the frame exactly
  once; a dropped stream resubscribes with a fixed backoff, and the first
  event is always the current state so nothing is missed between GET and
  subscribe. `hasUnpublishedChanges` (`studio-workspace.ts`)
  still compares `filesHash` against `deployedHash` — the PRODUCTION
  staleness — returned as `unpublished` for the pane's Publish nudge. A
  hash rather than a timestamp for two reasons: deploys themselves write
  the workspace (which bumps `updatedAt`), and editing a file then undoing
  it should not leave the project permanently "stale". The Secrets panel
  mirrors writes to the preview slug best-effort so previews run with the
  same third-party keys. **Landing on a project wakes its preview**
  (`wakeProjectPreview` in studio-preview.ts, hung off the once-per-open
  session broker call): a STALE preview reschedules its auto-deploy — the deploys
  are fire-and-forget with in-process coalescing, so a replica restart can
  drop one and leave the pane on "Updating preview…" until the next edit —
  skipping empty workspaces (the first agent turn owns the first preview)
  and stamped build failures (deterministic; the banner carries the output),
  and the embedded agent's sandbox is warmed through the platform's public
  client-config broker (`warmPreviewSandbox`) so a preview idle-evicted
  since the last visit is booting before the pane's iframe asks for it.
  The warm-up doubles as an existence check: a 404 from the broker means
  the agent behind the workspace's preview stamp is GONE (expired, swept,
  or deleted out from under it), so the wake clears `previewHash` and
  regenerates the preview — the stamp says "current" and would otherwise
  never redeploy. Only 404 triggers this; a 503 is a sandbox mid-boot and
  stays retry-only.

  **The pane probes before it frames** (`useAgentPageReady` in
  `preview.tsx`): a stamped `previewSlug` is not proof the platform serves
  `/:slug/`. The stamp outlives the deploy behind it (the swept-agent case
  above, which the wake path regenerates) and a first or repeat deploy takes
  seconds to land, and `GET /:slug/` answers a slug with no agents row with
  a bare `{"error":"HTML not found"}` — which rendered as the ENTIRE pane,
  reading as a broken studio rather than a preview on its way. So the pane
  asks the unauthenticated agent health route (existence only — a booting
  sandbox is the framed page's own business, its client re-brokers) and
  keeps its own "Starting your preview" screen up until the page is really
  there, re-probing every few seconds. Readiness is LATCHED per slug:
  nothing re-probes a page that answered once, because dropping back to the
  placeholder would unmount the iframe and kill any voice session inside it
  — a new deploy still reaches the frame through the `previewVersion` key.
  The first probe renders as an empty pane rather than the screen, so an
  already-deployed preview doesn't flash "starting" on every open.
- **The coding agent cannot publish.** There is deliberately no deploy
  tool: going to production is the user's call, made with the Publish
  button (`POST /studio/projects/:project/deploy`) — the only path that
  touches `deployedSlug`. The prompt states this outright so the agent
  doesn't claim to have deployed or invent a production URL (the preview
  auto-deploy is platform-triggered, not an agent capability). Keep it
  that way — an agent that ships to a public URL on its own read of "make
  it live" is a surprise nobody asked for.
- **LLM selection** (`studio-llm.ts`): every studio turn runs on the
  AssemblyAI LLM Gateway **with the caller's own API key** — delivered to
  the guest via `studio/session-init` and resolved there (`resolveLlm` +
  the SDK's `assemblyAILlm` factory); the platform holds no studio LLM
  credential. The *model* (never the key) stays host config: default
  `gpt-5.5`, `STUDIO_LLM_MODEL` overrides,
  `STUDIO_LLM_REGION=eu` region-filters. The guest chat surface's bearer
  is the broker-minted per-session `chatToken` — the key stays an LLM
  credential only and never crosses the public surface.
- **Gateway regions.** `STUDIO_LLM_REGION=eu` selects the EU endpoint,
  which serves only Claude and most Gemini models. The gateway model list
  is therefore region-filtered (`GATEWAY_US_ONLY_MODELS`) and the EU
  default falls to `claude-sonnet-4-6`. Ordering the one
  `ASSEMBLYAI_GATEWAY_MODELS` array is what sets both defaults: the first
  entry surviving the region filter wins.
- **No per-request model switching.** `POST /studio/chat` accepts no
  `model` field (a stray one is stripped by the body schema, never
  honored): every turn runs on the host-configured default —
  `gpt-5.5` on the gateway. **A client can never name a provider or a
  model** — the only request-side credential is the caller's own bearer,
  which selects nothing: keep any future request-side choice validated
  host-side.
- **The coding agent itself runs on production infra**: each project gets
  one sandbox (`studio-session-broker.ts`) through the same
  `spawnWarmHarness` shape deployed agents' spawns use (a remote Modal
  Sandbox). The whole agentic loop lives in that guest — LLM calls dial
  the gateway from the guest on the caller's key, tools run on the guest
  filesystem, and `test_agent` loads the built bundle in place and can
  trial-run its tools (no db — ctx.db reports storage-not-enabled): no
  tenant data and no platform secrets in the guest.
- **Builds AND publishes run IN the guest sandbox, through the aai CLI —
  one path.** There is no host-side, out-of-process, or Modal-Function
  build backend anymore (`studio-build-runner/-entry/-protocol/-cache`,
  `studio-bundle.ts`'s import allowlist, and `studio-client-build.ts` are
  all deleted). Two guest entry points:
  - `test_agent` builds the live session workspace via
    `aai-guest/studio-build.ts`, which dynamic-imports
    `@alexkroman1/aai-cli/worker-bundler` from the **toolchain
    `node_modules` baked next to the harness** (see "Modal sandbox notes");
    workspaces materialize under that root (`workspacesRoot()`) so bare
    imports (`@alexkroman1/aai`, `zod`, `react`, `@alexkroman1/aai-ui`)
    resolve by the normal walk-up, exactly as in a user project. Diagnostics
    are scrubbed guest-side (`formatBuildFailure`) and arrive as
    `buildError` prose the coding agent can act on. The build runs
    **in-process in the harness**: a one-shot child-process variant (#845,
    motivated by Rolldown's native memory staying resident in the
    long-lived harness — ~1.5 GB per build, reclaimed only on process
    exit) was reverted after it didn't work in practice; see that PR for
    the measurements if revisiting.
  - **Publish is the LITERAL `aai deploy` CLI**, spawned in the project's
    sandbox (`aai-guest/studio-publish.ts`, the host→guest
    `workspace/deploy` RPC on the session broker — live sandbox reused,
    else an ephemeral spawn torn down after). The guest completes the
    workspace into a REAL project (`ensureProjectShape` in
    `aai-guest/studio-project-shape.ts`: package.json, tsconfig.json,
    global.d.ts, and vite.config.ts filled in from scaffold-mirroring
    copies when absent — drift-guarded against the scaffold by
    `studio-project-shape.test.ts`; a dir-local `AAI_CONFIG_DIR` carries
    the caller's key; `.aai/project.json` pins the slug) and runs
    `aai deploy --server <origin> --json --allow-missing-secrets`. Build,
    upload, config extraction (`describeBundle` on the platform's standard
    `POST /deploy` route), ownership, reserved slugs, the
    ASSEMBLYAI_API_KEY env floor,
    and the credential preflight are therefore byte-for-byte the laptop
    path. The CLI's output — success, build diagnostics, deploy errors,
    preflight warnings — returns to the client, which **posts it into the
    chat** so the coding agent sees and can fix failures.
    `--allow-missing-secrets` (new CLI flag → `credentialPolicy: "warn"`
    in the deploy body) exists because the Secrets panel needs a deployed
    slug to attach secrets to — a hard preflight failure would deadlock
    first publishes. The public origin comes from `requestPublicOrigin`
    (studio-routes.ts) → `resolvePublicOrigin` (aai-server/public-origin.ts).
  A hostile or pathological workspace burns the tenant's own sandbox CPU —
  never the web container's. Covered end-to-end by
  `aai-server/workspace-build-integration.test.ts` (a real harness process
  publishing through the real CLI to a real listening orchestrator).
- **Secrets have their own panel; storage has none.** Deployed-agent
  secrets are managed in the studio client's Secrets panel
  (`secrets.tsx`), which talks to the platform's own `/:slug/secret`
  routes — the exact ones `aai secret` uses — and posts a note into the
  chat on every change (key names only, values withheld) so the coding
  agent knows which keys exist. Storage (`ctx.db`) is CLI-only
  (`aai storage enable <slug>`): the studio's storage routes and toggle
  were removed, and the prompt tells the agent to direct users to the CLI.
- **The Settings panel is also where the CLI round-trip is discoverable**
  (`cli-commands.tsx`, the "Work locally" section): the install / `aai login`
  / `aai pull <project>` / `aai dev` sequence with the project name filled
  in and one copy button each. It renders whether or not the project has
  ever been published — pulling a workspace needs no deployed slug. The
  commands carry `--server <studio origin>` unconditionally, because the CLI
  otherwise targets its own shipped default AND because passing `--server`
  is what APPROVES an origin for credentialed requests (`resolveServerUrl`
  in `aai-cli/_agent.ts`); the client can't compare against the CLI's
  default without importing from aai-cli, which would widen the package
  boundary.
- **Vite must not be allowed to mutate `process.env`.** Vite's `build()`
  sets `NODE_ENV=production` when it is unset — a permanent, global side
  effect on the calling process. Both CLI bundlers therefore wrap the
  build in `withPreservedNodeEnv` (`aai-cli/_vite-env.ts`), which
  snapshots and restores it. Without that, `aai dev`, which rebuilds on
  every file change, flips itself to "production" on the first rebuild.
  Keep any new Vite invocation inside that wrapper.
- **Builds and deploys are TYPE-CHECKED.** `aai build` and `aai deploy`
  run the project's own `tsc --noEmit` (`aai-cli/typecheck.ts`, gated on a
  `tsconfig.json`, `--skipTypecheck` opts out), and the guest's
  `test_agent` build does the same before bundling — the bundlers strip
  types unchecked, which is exactly how the `send`/`state`
  runtime-working-but-wrong bugs shipped. Type errors reach the studio's
  coding agent as build/deploy output it can act on. The dev watch loop
  deliberately does NOT typecheck (editor/CI feedback is faster there).
- **`buildClient` runs with no `client.tsx` → `{}`** → the agent gets the
  default UI.
- **`buildClient` dedupes React** (`resolve.dedupe`), because `aai-ui`
  declares it as a *peer* dependency while the bundler resolves the bare
  `react/jsx-runtime` inside `aai-ui/dist/**` from *that file's* real path.
  Locally aai-ui's own devDependency satisfies it; a pruned production
  install can leave the build root's walk-up copy as the only React —
  reachable from the workspace root but not from `packages/aai-ui/dist`.
  Publishing died with *"Rolldown failed to resolve import
  react/jsx-runtime"* while every local build passed.
  `aai-cli/client-bundler.test.ts` guards this (every non-optional aai-ui
  peer is deduped). The Modal image installs the full workspace (dev deps
  included), so the old pruned-image packaging tests are gone with the
  Dockerfile.
- **Deployed-agent credentials.** The studio has no secrets UI, so a
  published agent would otherwise start with an empty env — its S2S
  connect sends an empty bearer token (`runtime-transport.ts`:
  `env[ASSEMBLYAI_API_KEY_ENV] ?? ""`) and AssemblyAI answers
  `unauthorized`. The bearer token a studio caller authenticates with *is*
  their AssemblyAI key (see `aai-cli/_config.ts`), so it is seeded as the
  agent's `ASSEMBLYAI_API_KEY`. That seeding is the **CLI's** job
  (`aai-cli/deploy.ts`: `env: { ASSEMBLYAI_API_KEY: apiKey, ...env }`), and
  studio Publish runs that same CLI in-guest — so it is an env **floor**, not
  an override: a key the user declared in `.env` targets a different account
  and wins. The server-side `DeployParams.defaultEnv` that used to do this
  was removed once Publish stopped calling the deploy core; `deployLocked`
  now merges only `{...storedEnv, ...env}`. This stays inside the
  credential-separation rule — it forwards *the caller's own* key, never a
  platform-owned one.
- **Client**: `packages/aai-studio-client` is a Vite-built React app;
  `studio-static.ts` resolves its `dist/` via `require.resolve` and serves
  it at `/` with hashed assets under `/studio-assets/`. When it hasn't
  been built, `GET /` serves a fallback page with build instructions
  (unit tests don't require it).
- **Every cross-origin the studio page dials must be in its `connect-src`**
  (`studioCsp` in `studio-static.ts`). There are exactly two, and both were
  omitted at some point with the SAME symptom: the browser refuses the
  request before sending it, so the client shows a bare **"Failed to
  fetch"** and the server logs NOTHING, because no request was ever made.
  (1) the project's guest sandbox — chat + tool labels, keyed by sandbox
  backend so a production policy never trusts loopback; (2) the Supabase
  project, which supabase-js dials for GitHub OAuth sign-in (the session
  restore and the code/token exchange after the redirect — GitHub itself is
  reached by top-level navigation, which connect-src does not govern). Both
  are derived
  from what the server really hands the client (`chatUrlForGuest`'s shape,
  the auth binding's own `clientConfig`) rather than hand-copied literals,
  and both are exact — `https://*.supabase.co` would trust every Supabase
  project on the internet. The sign-in case is the one that hides best:
  the page loads and `GET /studio/auth` succeeds (both `'self'`), so
  everything looks healthy until the button is clicked.
- **Reserved slugs** (`RESERVED_SLUGS` in `schemas.ts`): `studio` and
  `studio-assets` can never be claimed as agent slugs — they would shadow
  the studio routes. Enforced in `validateSlug`, `DeployBodySchema`, and
  the deploy core.

### One studio sandbox per project, fleet-wide

The same problem hit the studio harder, and the fix is shaped differently
because a studio guest is STATEFUL to the host: it holds an installed
session (materialized workspace, caller's key, system prompt) that a broker
call must be able to refresh, or the coding agent edits a stale tree. Two
live guests for one project also meant two `studio/sync-workspace` writers
racing on the same workspace row.

`aai-studio-server/studio-session-registry.ts` (`aai_platform.studio_sessions`)
records the chat URL + chat token the browser gets, plus the guest origin +
per-sandbox token a PEER needs to reinstall the session. `ensureSession` is
now a three-step ladder: local map hit → reuse; registry row → **adopt**
(`studio-session-adopt.ts`); neither → cold spawn + claim.

- **Adoption cannot use the control socket** — a harness accepts exactly
  ONE (`/ws` answers 409 to a second authenticated dial), and the owner has
  it. So the guest serves an HTTP twin, `POST /studio/session-init`
  (`aai-guest/studio-session-init.ts`), gated by the per-sandbox HOST token
  rather than the `chatToken` it mints. The SOCKET stays the owner's,
  carrying lifecycle and the guest→host RPCs; HTTP lets any replica install
  a session. Ownership never moves, so there is no second socket and no
  cross-replica termination.
- **The install IS the liveness probe.** Anything but a clean 2xx drops the
  row and falls through to a cold spawn, so a stale row costs one failed
  HTTP round trip rather than a dead URL in a browser.
- **The guest pins its own identity.** `initStudioSession` records the
  (scope, project) of its first successful install and refuses any later
  one naming a different pair (409). Now that any replica can install over
  HTTP, a mis-keyed row would otherwise materialize one tenant's workspace
  inside another tenant's guest — the same reasoning as agent mode
  hash-verifying its bundle instead of trusting the spawner.
- **The lease and the local idle window are ONE number**
  (`STUDIO_SESSION_IDLE_MS`). They have to be: a peer's broker call is
  activity the owner cannot see, and all it leaves behind is a touched
  lease, so the owner's sweeper consults the row before evicting. Guest RPC
  activity touches the lease too — an agent turn longer than the window
  would otherwise let the row expire and invite a peer to cold-spawn
  mid-turn.
- **`chatToken` is minted once per SANDBOX and stored in the row**, so every
  replica hands back the same one. Re-minting per broker call would revoke
  the token every other tab is holding.

Both registries carry a `replicaId` (`ServiceConfig.replicaId`, a per-process
UUID) and both fall back to independent per-replica behaviour when there is
no platform database — dev and tests are a single process with no peers.
