# packages/aai-studio-server — studio guide

The studio service (private package): the browser-based coding agent,
workspaces, previews, and Publish. Its front-end is in
`packages/aai-studio-client/CLAUDE.md`; the guest it runs in is in
`packages/aai-guest/CLAUDE.md`.

## Key files

The browser studio's server side (documented below):

  `studio-routes.ts` (HTTP surface), `studio-session-broker.ts` (per-project
  coding-agent sandboxes: the collaborators, the per-project lock, and the
  public surface), `studio-session-ensure.ts` (the reuse -> adopt -> spawn
  ladder and what a session install IS — everything in it runs under that
  lock), `studio-session-idle.ts` (teardown + idle eviction),
  `studio-session-publish.ts` (`buildWorkspace` for Publish),
  `studio-session-registry.ts` (the cross-replica row that makes
  a project's sandbox one fleet-wide, not one per replica),
  `studio-session-adopt.ts` (installing a session into a PEER's guest over
  HTTP), `studio-llm.ts` (gateway model config; the key is always the
  caller's), `studio-workspace-dir.ts` (materializes a workspace to a
  scratch dir — eval-suite only now), `studio-errors.ts`
  (`StudioBuildError`), `studio-deploy.ts` (guest build → validate config →
  deploy), `studio-database.ts` + `studio-database-routes.ts` (the project
  database switch across both environments, and the post-deploy hook that
  provisions a newly claimed slug), `studio-workspace.ts` (project file
  store), `studio-prompt.ts`
  (system prompt from the scaffold CLAUDE.md), `studio-static.ts` (serves
  the built client)

## Browser studio

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
  once — the in-process keyed lock (`studio-workspace-lock.ts`) still
  serializes local writers, so a conflict means another replica.

  **METADATA STAMPS do not go through that read-modify-write** — they use
  `stampWorkspaceMeta` over `WorkspaceStore.patch`, a single
  `doc = (doc - remove) || set` statement. Stamps dominate a project's writes
  (every settled edit is followed by a preview deploy stamping
  `previewSlug`/`previewHash`; Publish stamps the deploy pair; the database
  switch stamps `databaseEnabled`) and none of them touches the file map, so
  recording a 64-character hash was reading and rewriting every file in the
  project. It is also the STRONGER primitive for the job, not just the cheaper
  one: a versioned RMW could only avoid reverting a mid-deploy edit by
  DETECTING the race and retrying, while a patch carries no files and so
  cannot clobber them — the call sites used to spell that hazard out one by
  one, and `WorkspaceStamp` (which omits `files` and `hash` by construction)
  now says it in the type. The version bump stays, because it is what drives
  the change stream and so the SSE push; the workspace lock stays too, so an
  unlocked stamp can't spend a local file write's single conflict retry.

  `scope` is
  a *deterministic* SHA-256 (`studioScope`) — stable so a caller can find
  its projects again. Browser sessions scope by the studio USER id
  (`user:<uid>` — stable across AssemblyAI key rotation); a raw-key caller
  whose key an account owns resolves to the SAME `user:<uid>` scope (the
  `key-user:<sha256(key)>` reverse mapping in `resolveBearer`, written by
  `PUT /studio/account/key` and backfilled by
  `POST /studio/cli-link/approve` — this is what makes a linked `aai` CLI and
  the browser see one project list, and see `packages/aai-server/CLAUDE.md`
  for why the backfill is what makes a login trustworthy); only a raw key NO
  account has claimed
  (evals, programmatic callers) scopes by the key itself (`requestScope` in
  `studio-routes.ts`).
- **The CLI round-trips workspaces** (`aai list/pull/push/publish/delete` —
  see `packages/aai-cli/CLAUDE.md`): `GET /studio/projects/:project` returns
  `sourceHash` (the stamped files hash) as the pull's fast-forward token,
  and `PUT /studio/projects/:project/source` (`syncWorkspaceSource` in
  `studio-workspace.ts`) replaces the whole file map atomically — upserting
  on first push (reserved-name + create-rate-limit gated), 409ing when
  `baseHash` no longer matches the stored files, no-oping (no version bump,
  no preview churn) when the pushed files are byte-identical. A push that
  DID change something schedules a preview deploy **and refreshes the
  project's live coding-agent sandbox** (`refreshSession` on the broker): a
  guest materializes its workspace once, at install, so a session brokered
  before the push keeps serving the pre-push tree — and its next end-of-turn
  `studio/sync-workspace` writes that stale tree back OVER the push. The
  refresh reuses the local sandbox, or installs into a peer's over HTTP
  (`fleet.adopt`), and deliberately never SPAWNS: with no live sandbox there
  is no stale tree to fix, and a CLI push must not boot a coding agent.
  The token is
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
  `react-dom`, `tailwindcss`, `zod` — read from the scaffold's own
  manifest). It used to declare none, on the reasoning
  that they resolve from the toolchain anyway — true for the *build*, and
  exactly backwards for the *reader*: package.json is the first place a
  coding agent looks to learn what it can import, and an empty one asserted
  the opposite of the truth. Versions are pinned **exact**, read from the
  installed toolchain (`resolveWorkspaceDependencies`), because
  `add_dependency` runs `npm install <spec>` and npm reifies the whole
  manifest — a range would let the workspace materialize a different SDK
  build than the harness resolved, into a workspace-local `node_modules`
  that *shadows* the baked one. Pinned, the local copy is byte-identical and
  the shadowing is merely redundant — **but only while the pins still match
  the toolchain**, which they stop doing the moment the platform ships a new
  SDK. So an EXISTING manifest is the one exception to "existing files win":
  `reconcileWorkspacePins` rewrites the declared toolchain pins to the
  installed versions on every `ensureProjectShape`, leaving agent-added
  dependencies, scripts, and everything else exactly as found. Absent
  entries are NOT added back (npm reifies only what is declared, so an
  absent entry is no shadowing hazard, and re-adding one would override a
  deliberate removal), and an unparseable manifest is left alone for
  `npm install` to report. Toolchain-only packages (vite,
  typescript, the `@types/*`) stay undeclared: the agent never imports them,
  and every entry is one more package that install has to reify. That holds
  only IN the guest, where the toolchain is baked next to the harness — the
  CLI's `aai pull` merges them back in for the local project (see
  `packages/aai-cli/CLAUDE.md`).

  **The same reasoning is what `update_dependencies` refuses**
  (`TOOLCHAIN_MANAGED` in `aai-guest/studio-project-tools.ts`): the tool
  bumps declared packages to the registry's latest via
  `npm install <name>@latest`, but never the six toolchain-owned ones. A
  bump there is futile — the next `ensureProjectShape` reconcile rewrites
  the pin back — and harmful until it happens, because the newer SDK,
  React, or Tailwind it materializes locally shadows the baked copy the
  harness resolved and the build was tested against. Skipped names are
  REPORTED in the tool result (with why), not silently dropped: a coding
  agent told "nothing happened" retries, and one told nothing at all
  claims it upgraded the SDK.
- **Guest tools carry their own deadlines** (`aai-guest/studio-tools.ts`):
  every tool is wrapped in a 120s timeout resolving to an error tool
  result, and `bash` has its own wall-clock kill (60s default, 300s max)
  with capped, tail-kept output. The client side of a hung turn is the
  composer's **Stop button** (`chat.tsx`): `useChat().stop()` aborts the
  SSE fetch to the sandbox, whose request-close handler aborts
  `streamText` and in-flight tools in the guest.
- **A turn's delivery has three rules, all in `aai-guest/studio-turn-stream.ts`**,
  each for a failure measured by driving the real studio against a controllable
  model:
  - **A broken model stream must reach the client as an `error` frame.**
    `pipeUIMessageStreamToResponse` rejects on a stream error and its `finally`
    ends the response anyway, so a mid-stream failure closed the body CLEANLY
    after the last delta — no `error`, no `finish`, no `[DONE]`. The browser
    read that as a completed turn: a half-sentence reply, no error shown,
    `useChat` in `ready`, the truncated turn persisted, and the composer's
    queued follow-up fired over it. The only trace was the guest's
    `unhandled rejection: terminated` — the rejection the caller's `void`
    dropped. Nothing can be written after the fact (the response is already
    closed by the time the rejection is observable), so `withStreamErrorChunk`
    reads the UI message stream itself and emits a final `error` chunk on a
    source error. Never go back to `void result.pipe…`.
  - **Assistant messages need `generateMessageId`.**
    `handleUIMessageStreamFinish` falls back to `messageId: ""`, and that blank
    id is what the `onFinish` reconstruction — the object the guest PERSISTS —
    carries. Invisible live (the browser's own copy has a client-side id) and
    cumulative in the store: the client hydrates the blank, sends it back, and
    each turn adds another. Measured: 1 blank id, then 2, 3, 4 over three
    reload-and-send rounds — four messages sharing the React key `""`.
  - **One turn at a time per guest** (`createTurnGate`), refused with **423 +
    `code: "turn_in_flight"`**, not queued. Two tabs on one project streamed
    into the same sandbox at once: overlapping model requests, two agents
    editing one workspace, and racing `studio/persist-chat` writes that left
    the loser's turn absent from the stored conversation. Queueing server-side
    would not help — a waiting request carries a conversation snapshot from
    before the turn it waited for, so it clobbers that turn on settle anyway;
    the queue that works is the tab's, which re-reads messages at dispatch.
    Two details are load-bearing: the gate is **per PROCESS**, because
    `studio/session-init` runs on every page open and a session-scoped gate is
    reset by the very event that creates the race (a second tab opening the
    project mid-turn); and it is released on the response CLOSING as well as on
    the turn settling, because the turn promise only resolves once the body has
    drained — a client that opens a turn and stops reading would otherwise lock
    the project out for the life of the sandbox. Releasing on close is also
    what keeps the composer's queue working: the client dispatches its next
    follow-up strictly after this response closed, so back-to-back queued turns
    are never mistaken for concurrent ones.

  The status is a distinct one because the client's chat-surface failure
  taxonomy (`resilient-fetch.ts`) reads 401/409 as "stale session, re-broker" —
  a BUSY guest is healthy, and re-brokering would reset the session the other
  tab is streaming through. 423 is translated to a human sentence there too,
  since the AI SDK surfaces a non-2xx as `Error(await response.text())` and the
  panel would otherwise render the raw JSON body.

  **Remaining gap, deliberately not closed:** a live tab does not catch up with
  another tab's turn. The pushed `chat` SSE frame updates the query cache, but
  `ProjectChat` reads `initialMessages` once at mount, so the refused tab keeps
  its own view until the project is reopened.

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
  the same in-guest `aai deploy` path Publish uses (`studio-preview.ts`).
  **Scheduling is DURABLE**: the edit enqueues a job in
  `studio-preview-queue.ts` (Supabase's `pgmq` in production, in-memory in
  dev/tests) and a per-replica drain runs it, at-least-once — a claimed job is
  invisible for a visibility timeout rather than deleted, so a replica restart
  or a sandbox death mid-deploy no longer drops the work. Past
  `PREVIEW_JOB_MAX_ATTEMPTS` redeliveries a job is archived (that is a crash
  loop, not a slow deploy); a pg_cron sweep prunes the archive. Coalescing is
  not managed: the deploy re-reads the workspace and no-ops when `previewHash`
  matches, and the drain holds a per-project lock, so N jobs for one project
  cost one deploy plus a read each — replacing an in-process map with a dirty
  bit whose whole purpose was to approximate that without durability.
  **A queue row NEVER carries a credential**: it names the studio `userId`,
  and the drain resolves the key from Vault (`user-key:<uid>`), so a job
  redelivered to another replica can still deploy. A raw-key caller's job
  (CLI, evals) has no `userId`, so it runs only on the replica that enqueued
  it and is archived if redelivered elsewhere.

  **`userId` is therefore load-bearing for a browser session, and ONE builder
  supplies it** — `previewOrigin` in `studio-settled-edit.ts`, used by the
  settled edits, the database switch, the project-open wake, AND the session
  broker (whose `ensureSession` takes a `PreviewOrigin` object rather than a
  bare `serverUrl`, so the guest's own end-of-turn sync inherits it). Omitting
  it is silent: the job still enqueues and still deploys HERE, and only a
  redelivery elsewhere — a restart, a scale-in, a sandbox death mid-deploy —
  turns it into an archived job and a preview that never lands. Two of the
  three schedule paths had drifted into building their own origin and losing
  the field, the agent-turn path (the primary one) structurally unable to
  supply it at all. `PreviewOrigin` is `Omit<PreviewTarget, "apiKey">` so a
  field added to the target is a compile error at every builder rather than
  one the row quietly drops. Success stamps
  `previewSlug`/`previewHash` on the workspace;
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
  once; a dropped stream resubscribes with a fixed backoff.

  **Every stream watching one row SHARES its reads** (`createSharedReads` in
  `studio-sse.ts`). A frame is always produced by re-reading the row (events
  are signals), and a `project` frame's row is the whole workspace document —
  correct per stream, pure duplication per TAB, and tabs are what multiply: a
  laptop and a phone on one project, two windows side by side, a reload racing
  its predecessor's still-open stream. The frames are a pure function of the
  row, so one read serves all of them, serialization included. The count per
  change is **two, not one**, and the second is `createCoalescingRunner`'s
  correctness rule rather than a miss — a run that started before a trigger
  cannot vouch for that trigger's change, and nothing tells the runner that
  these triggers are the one event it is already reading for. What matters is
  that it does not grow with the tab count. Entries are refcounted and dropped
  on the last release: this is a per-process map keyed by project, and a studio
  serves unboundedly many.

  **Both routes SUBSCRIBE BEFORE READING, and send their initial frame
  THROUGH the push chain** (`studio-events-routes.ts`). With no polling loop
  left, a change these streams don't cover is lost for good rather than late,
  and read-then-subscribe leaves exactly that gap. It is not
  microtask-sized in production: it spans a real socket write, plus — on the
  subscribe side — a Supabase Realtime channel JOIN, because `subscribe()`
  only SENDS the join and nothing is delivered until the server acks it.
  Opening a project as its preview deploy stamps the workspace is the
  collision, and it strands the pane on "Updating preview…" with a finished
  preview behind it. Routing the initial frame through `sse.push` is what
  makes the reorder safe: every frame is then a fresh read on one serialized
  chain, so a watcher firing before the initial read cannot deliver newer
  state ahead of older. The route's own pre-stream read is an existence check
  for the 404 only.

  The other half of that gap is closed in `createChannelPool`
  (`realtime-events.ts`): **a successful (re)join fires the channel's
  watchers.** It covers the join round trip and, more importantly, every
  socket reconnect — realtime-js rejoins after a drop, and these are pure
  signal streams with no sequence number to resume from, so changes during
  the outage reach nobody and nothing downstream would ever notice. Firing on
  the ack makes both windows cost a redundant re-read. Watchers are therefore
  registered BEFORE `subscribe()` is called (a synchronous ack is legal, and
  the watcher that triggered the join is the one that most needs the signal),
  and dispatch iterates a snapshot so a watcher may unwatch from inside its
  own callback. `watchAgents` gets no join signal — its handlers are keyed by
  slug and a join names none.

  `hasUnpublishedChanges` (`studio-workspace.ts`)
  still compares `filesHash` against `deployedHash` — the PRODUCTION
  staleness — returned as `unpublished` for the pane's Publish nudge. A
  hash rather than a timestamp for two reasons: deploys themselves write
  the workspace (which bumps `updatedAt`), and editing a file then undoing
  it should not leave the project permanently "stale".

  **Secrets are a PROJECT switch, not a per-slug one**
  (`studio-secrets.ts` + `studio-secret-routes.ts`): a project deploys
  two agents, so `GET/PUT/DELETE /studio/projects/:project/secret` writes
  both, exactly as the database routes do. The fan-out used to live in the
  BROWSER — the panel PUT the production slug then mirrored to the preview
  one — which made "a project is two agents" a property of the studio client,
  so `aai secret put` and `aai publish`'s `.env` sync reached production
  alone and the preview agent failed at its first session. The per-slug
  `/:slug/secret` routes remain the platform primitive underneath, and the
  only surface for an agent belonging to no project.

  **Two things wake a project's preview, and it needs both**
  (`wakeProjectPreview` in studio-preview.ts). Landing on the project — the
  once-per-open session broker call — warms the embedded agent's sandbox
  through the platform's public client-config broker (`warmPreviewSandbox`) so
  a preview idle-evicted since the last visit is booting before the pane's
  iframe asks for it. **And the Preview pane reporting the page missing**
  (`POST /projects/:project/preview/wake`), which is the same condition seen
  from the only place that can see it in a tab that is already open.

  That second trigger exists because the first fires ONCE and then never again
  for the life of the tab, so a preview swept an hour later had nothing to
  correct it: the recovery below was sitting right there, and the only thing
  that could reach it was an action the user had already taken. Measured in
  production — the pane polled `/:slug/health` **1,061 times across 50
  minutes** against a slug nothing was going to redeploy, and recovered only
  when the user happened to do something that brokered a session. **The
  reporter is a TRIGGER, never evidence**: both triggers land in the same
  function and the broker 404 below is what decides, so a client cannot talk
  the platform into a deploy and a probe that failed locally costs a no-op.
  The route is throttled per project (`PREVIEW_WAKE_THROTTLE_MS`) because a
  wake costs a workspace read plus a broker call that can spawn a sandbox;
  the pane itself sends exactly one per missing preview, since the wake
  enqueues a durable job whose queue owns the retries.

  It used to ALSO redeploy a stale preview, because scheduling was
  fire-and-forget in-process state that a replica restart could drop, leaving
  the pane on "Updating preview…" until the next edit; the queue owns delivery
  now, so a stale preview means a job is still queued — re-scheduling here
  would be a second mechanism answering the same question, and the weaker one,
  since it only fires when a human opens the project.
  The warm-up doubles as an existence check: a 404 from the broker means
  the agent behind the workspace's preview stamp is GONE (expired, swept,
  or deleted out from under it), so the wake clears `previewHash` and
  regenerates the preview — the stamp says "current" and would otherwise
  never redeploy. Only 404 triggers this; a 503 is a sandbox mid-boot and
  stays retry-only.

  **A stamped `previewError` is retried on open too**, for the same reason the
  404 case exists: a settled failure is the one state with NO queued job behind
  it (the job ran, failed, and left the queue), so nothing short of another
  edit would ever clear it. This deliberately does not try to tell a
  deterministic failure (broken code, which re-fails into the same banner) from
  a transient one — the only signal available is the deploy CLI's output prose,
  and sniffing it is exactly the check that breaks when a message is reworded.
  The trade is asymmetric: being wrong costs one extra deploy per
  project-open, re-stamping the banner already there, while not retrying
  strands a transient failure permanently. That is not hypothetical — a
  platform-side `deploy failed (HTTP 500)` (the anon-key Storage RLS bug) left
  projects pinned on an error banner with a working workspace behind it. The
  stamp is left in place while the retry runs, because only a SUCCESSFUL deploy
  deletes it; the pane keeps showing the last real error rather than flickering
  to "starting". A project whose first-ever preview failed has no
  `previewSlug`/`deployedSlug` and so nothing to warm — it still schedules
  (an early "no slug, give up" return meant exactly those projects could never
  retry).

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
    `node_modules` baked next to the harness** (see `packages/aai-server/CLAUDE.md`);
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
    global.d.ts, and vite.config.ts COPIED from the real scaffold shipped in
    the baked toolchain (`@alexkroman1/aai-cli/dist/scaffold`) when absent,
    so the guest holds no second copy to drift — only the two deliberate
    deltas are code (`workspaceTsconfig`, the exact dependency pins); a
    dir-local `AAI_CONFIG_DIR` carries the caller's key; `.aai/project.json`
    pins the slug — those last two written by the CLI's own writers
    (`@alexkroman1/aai-cli/project-config`), since the CLI is what parses them
    back and the 0600 atomic rename and the pin's MERGE are invisible in the
    JSON) and runs
    `aai deploy --server <origin> --json`. Build, upload, the credential
    preflight (CLI-side now — see "The platform
    stores no agent config" in `packages/aai-server/CLAUDE.md`), ownership,
    reserved slugs, and the ASSEMBLYAI_API_KEY env floor are therefore
    byte-for-byte the laptop path. The CLI's output — success, build
    diagnostics, deploy errors, preflight warnings — returns to the client,
    which **posts it into the chat** so the coding agent sees and can fix
    failures.
    Missing credentials only ever WARN, which is what a first publish needs:
    the Secrets panel has nowhere to attach a secret until a slug is deployed,
    so a hard preflight failure would deadlock every agent needing a
    third-party key. That used to be an opt-in the guest passed
    (`--allow-missing-secrets`, which asked the SERVER to warn); the server
    stopped preflighting when config extraction moved CLI-side, and the CLI's
    own preflight cannot see secrets already stored against the slug, so
    warning is the only behaviour left and the flag is gone.
    The public origin comes from `requestPublicOrigin`
    (studio-context.ts — beside the context type, not in studio-routes.ts, so
    route modules under it can resolve the origin without importing their own
    parent) → `resolvePublicOrigin` (aai-server/public-origin.ts).
  A hostile or pathological workspace burns the tenant's own sandbox CPU —
  never the web container's. Covered end-to-end by
  `aai-server/workspace-build-integration.test.ts` (a real harness process
  publishing through the real CLI to a real listening orchestrator).

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

- **Reserved slugs** (`RESERVED_SLUGS` in `schemas.ts`): `studio` and
  `studio-assets` can never be claimed as agent slugs — they would shadow
  the studio routes. Enforced in `validateSlug`, `DeployBodySchema`, and
  the deploy core.

- **The app shell is `no-store`; its assets are `immutable`. Those two go
  together** (`studio-static.ts`). `index.html` names content-hashed assets
  that exist only in the container image it was built into, so a cached
  shell pins a browser to a build whose `/studio-assets/*` 404 the moment
  that image stops running — a white page, with the entry script missing and
  no JS left to recover from it. A Modal deploy is exactly that event, and
  it is not instantaneous: the default rolling strategy keeps old containers
  serving beside new ones (up to `scaledown_window`) and load-balances every
  request independently. The shell carried NO cache headers for a long time,
  which is weaker than it sounds — with no `Cache-Control` and no validator,
  a heuristically caching intermediary may reuse it. The client half of the
  same problem (a tab whose lazy chunks were deleted by the rollout) is
  `stale-build.ts` — see `packages/aai-studio-client/CLAUDE.md`.

## One studio sandbox per project, fleet-wide

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

**The studio lease SURVIVES the move to Modal names, and this is not an
oversight.** Agent sandboxes dropped their registry entirely — a name answers
"does this deploy have a live sandbox", which is all the agent broker asks.
The studio asks a second question the owner's idle sweeper depends on: "has
any replica used this project recently?" A name cannot express that, and
nothing else can either — a peer's chat turns go browser→guest DIRECTLY, so
the owner (whose sweeper decides eviction) observes no activity at all, and
without the touched lease it would evict a guest another replica is actively
serving mid-conversation. The studio spawn IS named
(`studioSandboxName(scope, project)`), which adds what the lease could not
guarantee: two replicas racing the cold path cannot both spawn even when the
lease read missed. Closing the rest — deriving `chatToken`/`sandboxToken` from
the sandbox id and reducing the row to pure activity — needs a guest-side
last-used signal over the control socket the owner already holds; that is the
direction, not the current state.

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

The studio registry carries a `replicaId` (`ServiceConfig.replicaId`, a
per-process UUID) and falls back to independent per-replica behaviour when
there is no platform database — dev and tests are a single process with no
peers. The agent path needs no such identity: a NAME answers "does this
exist", never "who made it".

## Studio starter evals (scripts/starter-eval/)

The LLM-judge codegen suite (`studio-eval.test.ts`, vitest-evals) was
removed in favour of a harness that drives the studio's REAL surface —
create project, broker a sandbox session, stream a chat turn to the guest —
rather than calling the codegen path directly:

```sh
node scripts/starter-eval/run.mjs [--only <substring>] [--repeat N] [--out f.json]
node scripts/starter-eval/report.mjs run.json [baseline.json]
```

It spends real tokens on the caller's own key, so it is not in CI. Three
things it measures that the judge suite did not:

- **Shippable, not just green.** The agent writes its own tests, so "the
  tests passed" is a measure it can satisfy by weakening an assertion. The
  primary verdict is instead whether the built agent covers the capabilities
  the PROMPT enumerated (`scripts/starter-eval/expectations.mjs`), checked
  against the loaded config and agent.ts — neither of which the agent can
  edit to make the check pass.
- **Cost**: tool calls, repair rounds (failed `test_agent` runs), wall
  clock. Repair rounds are the number worth optimizing; they were what the
  starter prompts actually burned their step budget on.
- **A failure taxonomy** — never-verified / verified-broken / missing
  capability / step-capped — because "RED" was hiding three problems that
  want three different fixes.

**Run-to-run variance is large, and single runs cannot adjudicate a prompt
change.** Measured on one starter with an identical config: tool calls
varied 9–14 and repairs 1–4, which is the size of the effect most prompt
edits produce. Use `--repeat 3` and compare arms, and expect a plausible
change to show no effect — one A/B of a TypeScript-idioms preamble block
came back flat and the block was removed rather than kept on the strength
of a single flattering run.

What the deleted suite did that this does not: an LLM judge scoring the
workspace against a reference template for persona, state use, and assets
(`TemplateParityJudge`). Capability coverage is checked; resemblance to a
hand-written template is not.

## Randomized interleaving tests

`studio-concurrency-fuzz.test.ts` is a property suite over the studio's two
async pipelines — the durable preview queue and the SSE event streams. Each
run builds a different interleaving of edits, drains, deploy failures,
disconnects, and shutdown drains, then asserts invariants that must hold for
all of them: preview convergence, one deploy per project at a time, no write
into an ended stream, frame order, and no live-stream registry leak. It found
the two races the routes and the Realtime pool now guard against.

**`fc.scheduler` owns the async ordering here**, and it wraps the resumption
INSIDE the deploy body (`s.schedule` in the body) rather than the deploy
function (`s.scheduleFunction` around it). The scheduler runs task bodies one
at a time to completion, so wrapping the whole function serializes deploys and
makes the no-concurrent-deploy invariant unfalsifiable — the harness would
report success by construction.

Two rules if you extend it. **Assert the invariant, not the mechanism**: two
early false positives came from over-strict invariants — a project no edit
selected was never scheduled, and a build failure stamps `previewError` and
counts as SETTLED rather than converged. Both readings would have been "fixed"
by weakening the mechanism instead. And **check that the state you assert about
is reachable at all**: "archive only past the attempt cap" was VACUOUS for as
long as it lived here (zero archives over 200 seeds, and over 100 fast-check
runs) because reaching it needs six alternating clock-advance/drain pairs with
every deploy throwing — a sequence a random 40-op walk effectively never
produces. A coverage floor cannot fix that; the cap boundary has its own
targeted property asserting both directions instead.
