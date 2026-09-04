# packages/aai-studio-server — studio guide

The studio service (private package): the browser-based coding agent,
workspaces, previews, and Publish. Its front-end is in
`packages/aai-studio-client/CLAUDE.md`; the guest it runs in is in
`packages/aai-guest/CLAUDE.md`.

## Key files

The browser studio's server side (documented below):

  `studio-routes.ts` (HTTP surface: the broker, auth/scope middleware, and
  the routes that are not the project document itself),
  `studio-project-routes.ts` (project CRUD, the two file routes, and `aai
  push`'s `PUT …/source`), `studio-session-broker.ts` (per-project
  coding-agent sandboxes: the collaborators, the per-project lock, and the
  public surface), `studio-session-ensure.ts` (the reuse -> adopt -> spawn
  ladder and what a session install IS — everything in it runs under that
  lock), `studio-session-idle.ts` (teardown + idle eviction),
  `studio-session-publish.ts` (`buildWorkspace` for Publish),
  `studio-session-registry.ts` (the cross-replica row that makes
  a project's sandbox one fleet-wide, not one per replica),
  `studio-session-adopt.ts` (installing a session into a PEER's guest over
  HTTP), `studio-llm.ts` (gateway model config; the key is always the
  caller's), `studio-deploy.ts` (guest build → validate config →
  deploy), `studio-workspace.ts` (project file store), `studio-prompt.ts`
  (system prompt from the scaffold CLAUDE.md, one per project kind),
  `studio-project-kind.ts` (voice agent vs static workflow app — the
  new-project switcher's choice), `studio-preamble-mode.ts` (the five preamble
  fragments that differ between them), `studio-static.ts` (serves
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
  once — the in-process keyed lock (`workspaceLock` in
  `studio-workspace.ts`) still
  serializes local writers, so a conflict means another replica.

  **A file's PATH is normalized where it is stored, not merely validated.**
  `SafePathSchema` computes a `posix.normalize`d path and `stampWorkspace`
  used to throw away that value and key the map on whatever the writer sent —
  so `agent.ts` and `./agent.ts` were two entries denoting one file: both in
  the editor, either one built depending on what the bundler resolved, and a
  write to one leaving the other stale. Every writer goes through
  `stampWorkspace`, so normalizing there covers the editor PUT, the guest's
  end-of-turn sync and `aai push` alike (the push additionally normalizes
  before its byte-identical check, or a `./`-spelled push would read as a
  change on every run). `DELETE …/file` normalizes its `?path=` for the same
  reason — it addresses the stored key.

  **METADATA STAMPS do not go through that read-modify-write** — they use
  `stampWorkspaceMeta` over `WorkspaceStore.patch`, a single
  `doc = (doc - remove) || set` statement. Stamps dominate a project's writes
  (every settled edit is followed by a preview deploy stamping
  `previewSlug`/`previewHash`; Publish stamps the deploy pair) and none of
  them touches the file map, so
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
- **A project has a KIND, chosen once at create time, and it selects the coding
  agent's SYSTEM PROMPT** (`studio-project-kind.ts`; the hero's Agent/Workflow
  switcher sends it, `POST /studio/projects` stamps it on the workspace).
  `agent` is a voice session; `workflow` is a static workflow app —
  `workflowApp()`, a form, durable runs, no microphone — and its prompt's
  default is the `transcription-workflow` template rather than an `agent()`.
  - **It lives on the WORKSPACE, not on a request.** The prompt is installed
    per session (`studio/session-init` → `sessionParams` in
    studio-session-ensure.ts), which happens again on every project open, page
    reload, CLI push refresh and cross-replica adopt — so a per-request flag
    would leave the second tab building the other product. That is also why
    `sessionParams` takes the whole `StudioWorkspace` rather than its file map:
    a signature carrying only the files cannot carry the kind.
  - **Absent reads as `agent`** (`resolveProjectKind`, which narrows an
    `unknown` because the value comes out of a stored JSON document). Every
    workspace written before the switcher existed lacks the field and was built
    as a voice agent, so that is the only default that is not a guess — and
    it is what a caller naming no kind (the CLI's first push, evals) gets.
  - **The prompt is ONE preamble with five fragments swapped**
    (`studio-preamble-mode.ts`, which names them and says why those five): the
    overview line, the product-shape section, the spoken-replies rule, the
    client.tsx section, and the alignment examples. Everything else — the
    tools, the write-then-typecheck inner loop, "you cannot publish", the
    refusals, and the scaffold reference below it — is shared, because two
    copies of ~400 lines drift inside a release. The reference is shared
    deliberately too: it documents `agent()` AND `workflowApp()`, and a project
    that changes shape mid-conversation must not lose half of it.
  - **The kind is a default, not a cage.** Both prompts tell the agent to
    switch shapes when the user asks for the other one outright ("actually I
    want to call it on the phone"), because re-creating the project would throw
    away the work. Nothing rewrites the stamp when that happens: it decides
    which prompt the project runs under, not what the files may contain.
- **Chat runs IN the project's sandbox, and the browser connects to it
  DIRECTLY** — mirroring the voice path. `POST /studio/projects/:project/
  session` (rate-limited; `studio-session-broker.ts`) boots or reuses a
  guest sandbox through the same `spawnWarmHarness` machinery
  deployed agents use, installs the session over the control channel
  (`studio/session-init`: workspace files, the caller's own key, system
  prompt, model config), and returns the sandbox's public chat URL. The
  browser then streams turns straight to the guest's `POST /studio/chat`
  (SSE, the AI SDK UI message stream `useChat` consumes) — chat turns never
  pass through the platform host. **The coding agent is an ordinary
  `agent()`** — `text: true`, run by the SDK's own `createTextAgent`
  (`aai-guest/studio-agent.ts`; see "The coding agent is an ordinary
  `agent()`" in `packages/aai-guest/CLAUDE.md` for what that replaced) — up to
  `MAX_CHAT_STEPS` = 80 steps, plus a wall-clock turn budget
  (`aai-guest/studio-turn-budget.ts`) passed as an extra stop condition. It
  runs in the guest (`aai-guest/studio-chat.ts`) with Claude-Code-style tools
  over a real filesystem workspace (`aai-guest/studio-tools.ts`): list/read
  (windowed, numbered — opencode's read semantics)/write/edit/delete, `glob`,
  `grep`, `bash`
  (real shell in the container, guest token scrubbed from its env),
  `todo_write`, `test_agent`, `read_logs` (what the project's DEPLOYED preview
  or production agent printed — see "The coding agent can read its agent's
  logs" below), the template tools
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
  and `web_search` builtins (DuckDuckGo-backed — no key anywhere), NAMED on
  the agent definition's `builtinTools` rather than adapted into the tool set
  by hand. They run in the guest with open egress like all tenant code;
  `safeFetch` still screens the model-controlled URLs, and the tool context
  carries an empty env (`createTextAgent`'s `env` is `{}` while the caller's
  key rides in as `providerEnv`, so the coding agent's tools never read a
  credential).
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

  **The no-op still CLEARS a stale `previewError`, and that is the one write
  it makes.** A failed deploy stamps the banner while `previewHash` keeps
  naming the last GOOD deploy; undo the bad edit and the files hash back to
  that stamp, so the deploy has nothing to do — and while the early return
  fired before stamping anything, the pane showed a build error for code no
  longer in the workspace, forever, with every later edit that hashed back
  here re-confirming it. Only a SUCCESSFUL deploy deletes the stamp, and this
  is the one case where success needs no deploy.

  **Every "force the preview to redeploy" goes through `forcePreviewRedeploy`**
  (studio-preview.ts): clear `previewHash`, then schedule. It was written out
  three times — the database switch (since removed), a secret mutation, and
  the wake — with two different omissions between them, and one of those
  omissions WAS the bug above: the wake's settled-failure retry scheduled
  without clearing, so the state it exists to rescue was the one it could not.
  The remaining divergence is deliberate and lives at the call site: the secret
  switch skips the whole thing when the project has no `previewSlug` yet.
  **The preview slug is `<project>-preview` SHORTENED BY DIGEST, not by
  truncation** (`previewSlugFor`, beside `projectSlugFor` in
  studio-project-slugs.ts — the two answer "what are this project's agents
  called" from its two sides). Project names run to the slug grammar's full 64
  characters and the suffix costs 8, so plain truncation mapped every name
  agreeing in its first 56 onto ONE preview slug: both deploys succeed (same
  account, no ownership 409), both stamp their own `previewHash`, and one
  agent serves both projects' Preview panes with nothing reporting an error.
  The old comment argued that names are suffix-randomized server-side — true
  of GENERATED names, and `aai push` and the create body both take an explicit
  one. The last nine characters of a shortened slug are a digest of the whole
  name instead. Only NEW previews are affected; a deployed one is read from
  the workspace's `previewSlug` stamp.

  **A queue row NEVER carries a credential**: it names the studio `userId`,
  and the drain resolves the key from Vault (`user-key:<uid>`), so a job
  redelivered to another replica can still deploy. A raw-key caller's job
  (CLI, evals) has no `userId`, so it runs only on the replica that enqueued
  it and is archived if redelivered elsewhere.

  **`userId` is therefore load-bearing for a browser session, and ONE builder
  supplies it** — `previewOrigin` in `studio-settled-edit.ts`, used by the
  settled edits, the project-open wake, AND the session
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
  staleness — returned as `unpublished` on the workspace payload. No pane
  renders it today (the preview pane's Publish nudge that used to read it is
  gone — see `packages/aai-studio-client/CLAUDE.md`); it stays on the wire
  because it is the only report of production drift. A
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

  **And the project holds its OWN copy, so a secret can be saved before
  anything is deployed.** Writing only to the slugs that exist made the panel
  need a Publish first, which forces the one order that cannot work — an
  agent needs its provider key to RUN, so "deploy it broken, attach the key,
  deploy again" was the shortest path to a working agent. It is also not
  production that needs the key first: the preview agent is auto-deployed by
  the first edit and is the one the user is about to talk to. So the shape is
  the removed database switch's: a record of INTENT (`studio-project-env:<scope>:
  <project>` in the same Vault that holds every `agent-env:<slug>`, since
  these are values and the workspace doc is streamed wholesale to every open
  tab), written FIRST in both directions so a deploy racing the write cannot
  miss an update or undo a delete, and `reconcileProjectSecrets` applying it
  to each slug as a deploy claims it — the one surviving hook into
  the broker's one `afterDeploy` (`studio-deploy-hooks.ts`).

  **The project's EXISTENCE is resolved ahead of that write** — a different
  ordering question, and it used to be the wrong way round: the record went in
  unconditionally and the 404 came from the per-slug fan-out three statements
  later, so a PUT or DELETE naming a project that does not exist answered 404
  having already written a Vault record under that name. Nothing cascades it
  (the delete cascade only runs for a project that exists), so a later project
  taking the name inherited a stranger's values on its first deploy. The
  mutation now resolves the workspace and its owned slugs ONCE, up front, and
  threads them — which also removed two of the three workspace reads and one
  of the two ownership fan-outs a single panel save used to cost.

  Three properties. The record is a **FLOOR, never an override**: a name the
  slug already carries is left alone, or every deploy would silently
  reinstate the studio's value over one set with `aai secret put`. A mutation
  **redeploys the preview** (clear `previewHash`, schedule), because a stored
  secret only reaches an
  agent's env when its sandbox is BUILT; production waits for a Publish. And
  the project DELETE cascade drops the record — a project name can be taken
  again, and a survivor would hand the next project a dead one's provider
  keys.

  **Two things wake a project's preview, and it needs both**
  (`wakeProjectPreview` in studio-preview-wake.ts — split from
  studio-preview.ts, which owns the deploy LOOP; nothing in the wake deploys
  anything itself). Landing on the project — the
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
  The route is **rate-limited** (`PREVIEW_WAKE_RATE_LIMIT`, scope + IP, like
  every other route that can spawn a sandbox) and additionally throttled per
  project (`PREVIEW_WAKE_THROTTLE_MS`) because a wake costs a workspace read
  plus a broker call that can spawn a sandbox. The throttle used to be the
  whole answer and could not be: it is a fixed-size `TtlCache`, i.e. an LRU, so
  a caller cycling more than its 1,000 distinct project names evicts entries
  faster than they expire and every request lands as a first one;
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

- **The coding agent can read its agent's logs** (`read_logs`, guest side in
  `aai-guest/studio-logs-tool.ts`; host side `studio-agent-logs.ts`, reached
  over the control channel's `studio/agent-logs` RPC). The pane has shown this
  output to the USER since the ring existed; the agent's only route to it was
  asking them to read it out, while `test_agent` — which loads the bundle in the
  coding agent's own sandbox — structurally cannot see anything a real call
  produced. Four properties:
  - **The guest names an ENVIRONMENT, never a slug.** The host resolves it with
    `projectSlugFor` against the workspace of the (scope, project) the sandbox
    is pinned to. A guest that could pass a slug could read any agent whose slug
    it guessed, and the bearer is the account's own key, so the far end's
    ownership check would not stop it.
  - **It reuses the session's PREVIEW TARGET** for the origin and that key —
    which is also what scopes it: no target means this sandbox is no longer the
    project's, or was brokered without a `serverUrl`, and neither may read.
  - **It goes over HTTP to our own public origin**, like `warmPreviewSandbox`,
    rather than calling `readAgentLogs` in-process: that would thread the slot
    cache and the fleet-wide sandbox directory through this app, its routes and
    the broker, and `GET /:slug/logs` already owns the lookup, the peer
    fallback, and the ownership check.
  - **It returns the TAIL.** The ring is cursor-indexed and hands back its
    OLDEST lines first, which is exactly backwards for "why did it just break",
    so the host drains forward (bounded at five pages against a 2,000-line ring)
    and keeps the last N. Eviction is reported, and the three empty states —
    never deployed, not running, running and silent — are distinguished, because
    they call for different next moves from the agent.
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
  the guest via `studio/session-init`, where it becomes the agent
  definition's `llm` descriptor and the `providerEnv` `createTextAgent`
  resolves it against; the platform holds no studio LLM credential. The
  *model* (never the key) stays host config: default `gpt-5.5`,
  `STUDIO_LLM_MODEL` overrides,
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
  trial-run its tools (a tool that persists brings its own client, and has no
  credential for one here): no
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
    which renders it **in the Publish menu that started it**. It used to be
    injected into the chat as a user message so the coding agent could fix a
    failed deploy; no studio action writes into the transcript any more (see
    "No studio action writes into the transcript" in
    `packages/aai-studio-client/CLAUDE.md`), so the preamble tells the agent it
    will not see a publish and to ask the user what the menu said.
    Missing credentials only ever WARN, which is what a first publish needs:
    the Secrets pane has nowhere to attach a secret until a slug is deployed,
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

- **One studio path serves the shell to callers with NO session**:
  `GET /studio/api/<slug>`, the public API page for one deployed agent
  (`studio-app.ts`, rendered by `aai-studio-client/src/public-api.tsx`). It is
  registered above `app.route("/studio", …)` deliberately, so it never passes
  under the auth middleware that router hangs on its own subtrees — a link to
  it has to work for somebody with no studio account, which is the whole
  feature. It carries no ownership check for the same reason it needs no auth:
  the response is the app SHELL, and the reading is done by the browser against
  the agent's own already-public routes (`client-config`, `GET /workflows`).
  The path is under `/studio` so `RESERVED_SLUGS` and `isStudioPath` already
  cover it — no new reservation, no dispatcher change — and its param carries
  `SLUG_PATTERN_SOURCE`, so a path that could never name an agent 404s rather
  than serving a shell that would document nothing.
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

### Studio auth

Moved here from `packages/aai-server/CLAUDE.md` when that guide hit its size
cap: the code is the shared core's (`supabase-auth.ts`, `middleware.ts`,
`api-key-verify.ts`), the SUBJECT is this surface. The rules that are not
studio-specific — a raw bearer is verified against AssemblyAI before it means
anything, the two bearer forms and their one resolution point, and the
key↔account mapping — stay in that guide's "Auth" block.

- **Browser sessions are Supabase Auth** (`supabase-auth.ts`), and **which
  sign-in methods exist is asked of GoTrue, never declared here**
  (`GET /auth/v1/settings`, read by the client's `auth-methods.ts`): GitHub OAuth
  wherever the project enables it, email+password wherever it enables that — the
  local stack has the email provider on with `mailer_autoconfirm`, which is what
  makes a local dev server usable with no OAuth app registered. A hand-kept list
  on this side would be a button GoTrue answers `provider is not enabled` to,
  after a round trip through somebody else's site; an unreadable answer falls
  back to GitHub-only rather than to nothing.

  **A platform database refuses the no-auth dev tokens outright**
  (`createStudioAuthFromEnv`, no `AAI_LOCAL_DEV=1` escape) — dev auth lets any
  caller claim any user id, and `user-key:<uid>` is where every account's
  AssemblyAI key lives. See "Two questions, two sentinels" in
  `packages/aai-server/CLAUDE.md`.

  The server verifies access tokens **two ways, and which one a route gets is
  a security decision**:
  - `verifyAccessToken` — the request path. `getClaims` (`@supabase/auth-js`),
    which on a project using ASYMMETRIC JWT signing keys verifies the
    signature locally against a process-cached JWKS and touches the network
    not at all. Supabase's own guidance is to "prefer `getClaims` over
    `getUser`, which always sends a request to the Auth server for each JWT",
    and `GET /auth/v1/user` per token is what this replaced.
  - `verifyAccessTokenFresh` — `GET /auth/v1/user`, uncached, used ONLY by
    `requireStudioUser` (the three account routes). A signature check is
    authoritative about who issued a token and when it expires and blind to
    REVOCATION: a signed-out session stays cryptographically valid until
    `exp`. Those routes read and rotate the account's AssemblyAI key and grant
    a CLI one exchange for it, so they pay a round trip to see a sign-out at
    once.

  Two properties worth keeping. `getClaims` is safe on either kind of project
  — on a symmetric (HS256) one it falls back to a server call by itself — and
  that is also why the request path KEEPS its short TTL cache: on such a
  project the cache is what stops a per-request round trip. **That cache entry
  is capped at the token's own `exp`**, because `getClaims` validates expiry
  only on a MISS — a flat TTL kept serving a token that expired 59 seconds
  ago, making the bound the SUM of the two rather than the minimum. A
  rejection keeps the flat TTL; there is no `exp` to read from a token that
  did not verify. And a rejected
  token and an unreachable Supabase are opposite answers, so only
  `isAuthRetryableFetchError` throws (a 5xx to the caller); everything else
  caches as a rejection. `storageKey` is set explicitly because auth-js caches
  the JWKS in a PROCESS-GLOBAL map keyed by it rather than by URL — two
  clients pointed at different projects would otherwise verify one project's
  tokens against the other's keys.

  Configured by
  `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`. Local dev (same `isLocalDev`
  policy as the in-memory stores — production can never resolve it) falls
  back to `createDevAuth`: the login screen mints self-describing
  `dev.<base64url({id,email})>.dev` tokens, so `pnpm dev:aai-server`
  needs no Supabase project while exercising the same middleware. The
  studio's account surface (`GET /studio/auth`, `GET /studio/account`,
  `PUT /studio/account/key`) authenticates the session WITHOUT requiring
  a stored key — it is how the key gets set, as the mandatory onboarding
  screen after sign-in.
- **`aai login` never signs in and can never create an account** — it
  LINKS an account that is already signed in to the browser studio
  (device-link flow): the CLI mints an unguessable one-shot code, opens
  `<server>/?cli-link=<code>`, and polls
  `POST /studio/cli-link/exchange`; the signed-in (and key-onboarded)
  browser session approves via `POST /studio/cli-link/approve`, which
  grants that code ONE exchange for the account's stored API key. Grants
  live in the SecretStore under the code's hash
  (`cliLinkSecretName`), expire in 10 minutes, and are deleted on first
  read. There is no `GET /studio/account/key` route anymore — the exchange
  is the only way a raw key leaves the platform, and only to the terminal
  that minted the code.

### Sync to GitHub

`studio-github-*.ts` plus the client's `github-card.tsx`: a signed-in account
connects a **GitHub App installation**, picks a repository, and pushes a
project's workspace to a branch as ONE commit.

- **A GitHub App, not the GitHub OAuth the studio already signs in with.**
  Supabase Auth stays the identity layer; this is authorization to write
  somebody's source, and reusing the sign-in would mean adding `repo` to
  `signInWithOAuth` — full read/write over every repository the user can
  reach, demanded at the login screen, of every user, including the ones who
  never sync. Two further reasons it could not have been the session anyway:
  Supabase hands `session.provider_token` over ONCE and never refreshes it, so
  syncing would demand a re-login at unpredictable moments; and uninstalling
  an App is a revocation the user controls, where a leaked OAuth token is not.
  Installation tokens are minted server-side per request from the App key and
  the recorded installation id (`@octokit/auth-app` — nothing here mints a
  token or signs a JWT by hand).
- **Absent configuration DISABLES the feature rather than failing a boot.**
  `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_SLUG`, all three or
  none; `GET /studio/github` then answers `configured: false` and the card
  renders nothing at all. That is what keeps a self-hosted platform's Settings
  pane exactly as it was. The PEM is normalized for the three shapes it
  survives an environment variable in (intact, `\n`-escaped, base64) and
  trimmed to one value in each — it is also the HMAC key below, so a key
  differing by a trailing newline between two replicas is a fleet whose halves
  reject each other's states.
- **Connect goes through `/login/oauth/authorize`, NOT the App's install
  page.** `github.com/apps/<slug>/installations/new` redirects back to the App
  only on a FIRST install; visited once the App is installed it shows the
  installation's "update permissions" screen and fires no redirect at all —
  GitHub's documented behaviour, not an edge case. So the callback never ran,
  no link was written, and the card kept offering **Connect GitHub** with the
  App plainly installed on GitHub's side. It caught anyone who had installed
  the App once: an interrupted first attempt, a second studio account, or
  simply installing it from GitHub first. The authorize endpoint always ends
  at the App's callback URL with a `code`, installed or not, and offers to
  install when it is not — so the round trip completes either way. A popup
  fixes none of this; it would be a window parked on a GitHub settings page
  with nothing to report back. **The App's Callback URL must therefore be
  `<origin>/studio/github/callback`** — GitHub sends authorization to the
  first registered callback URL whatever `redirect_uri` says, so we send none.
- **The callback is the one studio route that cannot authenticate its
  caller.** `GET /studio/github/callback` is a top-level navigation performed
  by github.com — no bearer, nothing `authMw` could resolve — and what it
  decides is which account an installation belongs to. Two things stand in,
  and BOTH are needed: the `state` is HMAC-signed with a key derived from the
  App's private key (without it, `?state=` is an attacker-supplied user id and
  the route attaches THEIR installation to somebody else's account), and the
  `installation_id` is resolved against GitHub as the App before anything is
  stored (the signature proves who is asking, never what they are attaching).
- **WHICH installation is read from the user token, not from the redirect.**
  GitHub sends `installation_id` only when the App was installed during this
  round trip, so through the authorize endpoint most callbacks carry a `code`
  and nothing else. `GET /user/installations` — already fetched for the
  entitlement check, and already scoped to this App — answers both questions:
  a redirect that NAMES an id must have it in that list (unchanged, and the
  refusal that closes the cross-tenant escalation), and one that names none
  takes the list's newest entry. One link per account is the model, so some
  choice has to be made; it is never silent, since the card names the account
  it connected and links to GitHub's own picker. A user who authorized without
  installing anything has an empty list, and that is a REDIRECT to the install
  page rather than an error — the flow continuing, with a fresh state so the
  return trip lands back here.
  The state carries a 10-minute `exp`, is compared in constant time, and is
  minted at CLICK time by `POST /studio/github/connect` rather than handed out
  with the status — a settings pane left open would otherwise hold a link that
  fails after the user has picked their repositories. Every exit is a REDIRECT
  carrying `?github=`, never a JSON body: the caller is a navigating browser.
- **The link is keyed by studio USER** (`github-install:<uid>` in the same
  SecretStore as `user-key:<uid>`, schema-validated on read like the
  `cli-link:` grants). So a raw-key caller no account has claimed is refused
  outright — deliberately not widened to the workspace scope, or a key nobody
  claimed would inherit a browser session's repository write access.
- **The push is the Git Data API, and the tree is written WHOLE.** Blobs →
  tree → commit → ref, no clone and no working tree. `base_tree` is
  deliberately absent: a workspace IS the project (the same complete map `aai
  push` replaces atomically), so a sync REPLACES the branch's tree and a file
  deleted in the studio is deleted there. The cost — a file added on the
  branch is removed by the next sync — is the honest reading of one-way sync.
  The ref PATCH is **not forced**: a non-fast-forward means somebody pushed
  while the blobs were uploading, and discarding their commit silently is the
  one outcome a sync must never produce. An empty repository is the COMMON
  case (a user makes one for this), so a 404/409 on the ref read takes the
  `POST /git/refs` path with a parentless commit.
- **On a repository with NO COMMITS the Git Data API is CLOSED, and the
  Contents API is the way in.** The parentless-commit path above was
  unreachable for the users it was written for: GitHub refuses
  `POST /git/blobs` with 409 `Git Repository is empty.`, and a blob is the
  FIRST write the push makes — so the whole reward for creating a repository
  to sync into was that message and a link to the create-a-blob reference
  page. `initializeRepo` meets that refusal by writing ONE file through
  `PUT /repos/{owner}/{repo}/contents/{path}`, the only endpoint that works
  there, and the sync then writes its tree onto the commit that leaves behind.
  Four properties. It is REACTIVE, not predicted, because the ref read cannot
  tell an empty repository from a branch that does not exist yet (404 answers
  both) while the refusal says exactly which one it met — and re-uploading the
  blobs afterwards costs nothing twice, a blob being content-addressed. It
  writes a REAL workspace file (the first, sorted, so a retried sync writes the
  same initial commit) rather than a placeholder, so nothing has to be deleted
  and the tree replacement a moment later covers it anyway. It names NO branch,
  because an empty repository accepts a commit only to the default branch and
  naming the branch GitHub is about to create is how that call gets refused —
  which also means a sync targeting some other branch merely ends up with a
  non-empty repository and the unchanged create-the-ref path. And it gets ONE
  attempt: a 409 still standing after it is not an empty repository, and a loop
  around a refusal is the shape this module already removed once.
- **The picker lists the installation NEWEST-FIRST** (`pickerOrder` in
  `github-card.tsx`). GitHub answers `GET /installation/repositories`
  oldest-first, so the repository a user just made in order to sync into it —
  the one entry they are certain of, and the one the bootstrap above exists for
  — sat at the bottom of a list that runs to a thousand. Reversed rather than
  sorted on a key: the summary carries none worth sorting on, `fullName` buries
  the same repository just as thoroughly, and a timestamp would be a field on
  the wire that one line reads.
- **A head that moved is REBUILT onto, and only a spent retry budget may say
  "try again".** Unforced means the ref update can lose, so the sync re-reads
  the head and rebuilds the same tree onto the winner's commit
  (`REF_CONFLICT_RETRIES`) — the blobs and the tree are written once, being
  content-addressed. The create path is the same race seen from the other
  side (`POST /git/refs` answers 422 "Reference already exists"), and it
  switches to updating; a create refused while the ref STILL does not exist
  raced nobody, so GitHub's own words are surfaced instead of a second
  identical request. This is what fixed a user pressing Sync against
  **"That branch moved while the sync was running — try again"** forever:
  that sentence answered EVERY 409 and 422 in the push, so a tree GitHub
  would never accept and a ref name it would never create both read as a
  transient race, and the advice was a loop with no exit. It is now produced
  only by `GithubRefConflictError`, which the sync raises about itself — so
  wherever the sentence appears it is true, and the retry it asks for is one
  the sync has already tried.
- **Idempotent on the same `filesHash` everything else uses.**
  `githubRepo`/`githubBranch`/`githubHash`/`githubCommit` are `WorkspaceStamp`
  fields, so the sync records where it landed through `stampWorkspaceMeta` —
  a patch carrying no files, which cannot revert an edit that landed while the
  blobs were uploading. The no-op is checked AFTER reading the branch head,
  because a stamp claiming the branch is current is only believable while the
  branch still exists (a repository recreated under the same name is real),
  and only against the SAME target — the hash describes the files, never where
  they went.
- **Repository CREATION is organizations only, and that is GitHub's
  boundary.** `POST /user/repos` is unavailable to an installation token at
  all, so a personal account's repository cannot be created by an App acting
  as an installation whatever permissions it holds; reaching it would mean
  carrying user-to-server OAuth tokens and their refresh cycle, a second
  per-user credential expiring on its own schedule, for one button. The route
  answers a personal account with the INSTRUCTION (create it on GitHub, then
  add it to the installation) rather than passing GitHub's 403 through, which
  would read as a bug in the studio. The picker is the primary path either
  way, and it lists the INSTALLATION's repositories — the truthful answer to
  "where can this sync write", where the user's own list would offer
  destinations every sync would 404 on.
- **The branch is the repository's OWN default, never a request field.** It is
  read at push time (`readRepoDefaultBranch`), because the picker's copy can be
  a rename out of date — and a client-named branch would be a validated but
  unreachable input surface, which is how a security-relevant grammar rots.
  Re-adding it means adding the control and the grammar together.
- **Metered like every route that costs a third party** (`GITHUB_SYNC_RATE_LIMIT`,
  scope + IP): one sync is a blob upload per file against a service that
  meters us as one App across every tenant, so the window protects the App's
  standing with GitHub as much as this service. **Every studio window now comes
  from ONE factory** (`createPgStudioRateLimiters`), the shape the agent surface
  already uses: the composition root hand-listed them, and a window it forgot
  fell through to the in-memory arm and silently enforced `MAX_CONTAINERS` times
  what it says — the exact bug this guide documents for the workflow limiters,
  invisible because every route spec injects a limiter. `studio-rate-limit.test.ts`
  holds the factory to the windows this module declares.
- **Tested through the wire, not through a mock of our own wrappers.**
  `_studio-github-test-utils.ts` is a fake GitHub behind Octokit's own `fetch`
  seam, with a real RSA key so App JWT minting and the installation-token
  exchange really run. That is what lets the three invisible properties be
  asserted at all — no `base_tree`, an unforced PATCH, the empty-repository
  path — none of which a mocked `syncWorkspaceToGithub` could see. An
  unrecognized path answers **501 naming it**, so "the code called a route
  nobody wrote" cannot pass.

## Rate limits

Moved here from `packages/aai-server/CLAUDE.md` when that guide hit its size cap,
on the same audience split that brought "Studio auth" the other way: the
MECHANISM is the shared core's (`rate-limit.ts`, `createPgRateLimiter`), and every
window the platform actually runs is this surface's. The limiter itself lived in
THIS package while the studio was its only caller, which is why `POST /deploy`
had none — aai-server cannot import from here.

The windows (`studio-rate-limit.ts`): every window the platform runs is a row
in `aai_platform.studio_rate_limits`
(`createPgRateLimiter`, one atomic upsert per check), so a limit holds
platform-wide instead of multiplying by the replica count — which for an
ABUSE limit is the whole point, since `MAX_CONTAINERS` (3, in
`aai-server/modal_deploy.py`) makes a
per-replica cap a cap of three times the number written down. Fail-closed: a
database error propagates rather than silently unmetering the route.
Expired rows are swept by pg_cron (`pg-cron.ts`), not in-process. The
`studio_` table name is now a misnomer; `name` namespaces each limiter's
rows, which is what lets a second consumer share it without a migration.

**The AGENT surface's three come from one factory, and that is a fix.** This
file is the composition root, so choosing the durable arm is its call — and for
months it made that call for `deployRateLimiter` alone, wired by the audit that
added it. The two workflow limiters
(`WORKFLOW_IP_RATE_LIMIT`, `WORKFLOW_START_IP_RATE_LIMIT`) landed later with
their own orchestrator options, their own middleware and their own specs, and
nothing here ever passed them: `createWorkflowRateLimitMw` fell through to
`?? createRateLimiter(…)`, so the whole `/:slug/workflows/*` surface was metered
PER REPLICA — a 600/IP window enforcing 1,800, and the tighter start limit,
which bounds the only route whose cost outlives its request, enforcing 180
rather than 60. Nothing was red, because the middleware's own specs inject
limiters and never see the default, and this entry has no spec at all.
`createPgAgentRateLimiters(sql)` answers all three as one object the entry
spreads whole; `rate-limit.test.ts` reads `orchestrator.ts` for a `RateLimiter`
option the factory does not answer, so the NEXT one cannot be forgotten either,
and `agent-rate-limits.scenario.test.ts` asserts the property a single-instance
spec structurally cannot — two limiters over one database sharing a budget where
two in memory do not.

**With no `X-Forwarded-For` the key is the literal `unknown`** (`client-ip.ts`),
so every such caller shares one bucket — and making these limiters durable makes
that bucket fleet-wide rather than per-replica. Stricter, and the documented
trade (a shared bucket over-limits rather than opening), but it also means one
header-less caller can spend every other one's budget. Production never lands
there: Modal's proxy always appends a hop. A deployment fronted by a proxy that
STRIPS the header would, and the workflow surface has no better key to fall back
to — it is credential-free by design (a static page carries no bearer), and the
slug is the resource rather than the caller.

**Every limited route is keyed TWICE — by scope and by client IP.** The
scope key is derived from the caller's bearer, so for a raw-key caller it
was a value they chose: one character's difference minted a fresh window,
which made both studio limits decorative against exactly the traffic they
exist to stop. Key verification above is what makes a scope cost an
account; the IP key is what bounds the damage before one is spent.

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
- **EVERY rung of the ladder refreshes the lease, the reuse included.** The
  cold path claims and `fleet.adopt` touches; `reuseSession` moved `lastUsed`
  and called nothing on the fleet, so a user reloading every few minutes
  without completing a turn kept the sandbox locally fresh while `expires_at`
  ran out under it. The next broker call landing on a PEER then read
  `sessions` miss → `adopt` → `registry.get` null → cold path → `spawnNamed` →
  Modal refuses the duplicate name → null → **404 "Project not found" for a
  project that plainly exists**, healed only by the client re-brokering onto
  the owning replica. `studio-session-broker.test.ts` asserts it as EXPIRY
  (two reloads spanning a lease, then a peer adopting), because a `touch` call
  count would pass for a touch that reached the wrong row.
- **Nor is a sandbox with WORK INSIDE IT idle** (`SessionEntry.inFlight`,
  held by `LiveSession.hold` for the length of a `workspace/deploy`).
  `WORKSPACE_DEPLOY_TIMEOUT_MS` is 330s against this 300s window and the
  deploy touches only when it RETURNS, so a 200s cold build starting partway
  into an idle window was swept mid-`aai deploy`: the sandbox terminated under
  the CLI, the whole build re-ran, and the browser's chat URL was dead. The
  count is re-read after the `heldByUs` round trip too — a Publish can begin
  inside it.
- **`chatToken` is minted once per SANDBOX and stored in the row**, so every
  replica hands back the same one. Re-minting per broker call would revoke
  the token every other tab is holding.

The studio registry carries a `replicaId` (`ServiceConfig.replicaId`, a
per-process UUID) and falls back to independent per-replica behaviour when
there is no platform database — dev and tests are a single process with no
peers. The agent path needs no such identity: a NAME answers "does this
exist", never "who made it".

## Long-lived responses (SSE)

The studio's two event streams — `GET /studio/events` and
`GET /studio/projects/:project/events` — are the ONLY long-lived responses the
combined deployment serves, so everything a long-lived response needs is here
even though the mechanism (`live-streams.ts`, `serve-lifecycle.ts`,
`modal_deploy.py`'s `FUNCTION_TIMEOUT_SECS`) lives in `aai-server`. That guide
keeps the two rules an author editing it must not lose — shutdown ends
registered streams before the sandbox teardown, and any new long-lived response
owes registration; what follows is why, and what the log looks like when it
works.

- **Shutdown ENDS long-lived responses; it must never let the process exit
  destroy them** (`live-streams.ts`, wired into `serve-lifecycle.ts`). SSE
  streams never end on their own, so `server.close()` waited out
  `SHUTDOWN_CLOSE_FALLBACK_MS` and `process.exit(0)` then destroyed the
  sockets — cutting each chunked body before its terminating `0\r\n\r\n`.
  That is a protocol error to whatever is reading, and in production the
  reader is Modal's in-container ASGI proxy, which surfaced it as a recurring
  unretrieved-task `ClientPayloadError: Response payload is not completed:
  <TransferEncodingError: 400, 'Not enough data to satisfy transfer length
  header.'>` on `GET /studio/projects/<x>/events`, with nothing tying it to a
  replica scale-in. The studio's SSE pusher (`studio-sse.ts`) registers; with
  both surfaces in one process that is the only place a stream is owned. (The
  split deployment additionally relayed proxied streams through one it owned —
  `gracefulEventStream`, `text/event-stream` only so assets and JSON stayed
  zero-copy — because the browser's connection terminated at the agent replica;
  reviving the split owes that back.) Ending them is also what lets
  `server.close()` complete, so shutdown stops hitting the fallback timer at
  all. The client sees a clean stream end and resubscribes on its existing
  backoff (`useEventStream`). Any future long-lived response owes the same
  registration — the wire-level guard is `live-streams.test.ts`, which reads
  raw socket bytes because a handler-level assertion passes with the bug
  present.

  Three properties of the ending itself, each of which was a hole that put the
  truncation back while the registry looked correct:
  - **It runs FIRST, before the service teardown.** Ending a stream is
    synchronous and depends on nothing, while `onShutdown` sleeps
    `SHUTDOWN_GRACE_MS` and then awaits one drain request per resident guest —
    seconds at best, and up to `SHUTDOWN_TEARDOWN_TIMEOUT_MS` when a guest is
    unreachable or still booting (it was genuinely unbounded before that
    deadline existed). Modal SIGKILLs the container when its stop grace lapses,
    so ending them *after* the teardown made the graceful end contingent on
    sandbox teardown finishing in time — which is a bound now, but still not a
    dependency worth having.
  - **The registry LATCHES closed.** Nothing drains it twice, so a stream
    registered after shutdown began would be held open until the exit destroyed
    it; `registerLiveStream` therefore ends a late arrival on the spot instead.
    That is not the rare case — the client's first reconnect backoff is 3s and
    shutdown deliberately keeps serving for `SHUTDOWN_GRACE_MS`, so a
    resubscribe landing mid-shutdown is the MODAL case. (`resetLiveStreams` is
    a test-only seam for the latch.)
  - **The crash path ends them too** (`installProcessSafetyNets` in
    `service-config.ts`): `uncaughtException` → `process.exit(1)` destroys
    sockets exactly as a scale-in does.
- **A caller's concurrent streams are CAPPED per scope**
  (`MAX_LIVE_STREAMS_PER_SCOPE`, enforced by `reserveLiveStream` in
  `aai-server/live-streams.ts`; both routes answer **429** when a scope is at
  it). These are the only unbounded resource a single caller could hold on this
  surface: they were capped by nothing — `liveStreamCount()` was computed and
  gated on nowhere — and metered by nothing, since the studio's limiters cover
  chat, project-create and preview-wake only.

  **A cap, not a rate limit, and the distinction is why the limiters were the
  wrong tool.** A stream is a concurrent resource, so what matters is how many
  are held at once; a fixed-window limiter meters ARRIVALS and would punish
  exactly the honest client this protects, because every tab reconnects at once
  after a deploy or a scale-in (`endLiveStreams`) — a window sized for steady
  state refuses the reconnect storm the system itself caused.

  50 is far above legitimate use (a tab holds two: the scope list plus one
  project) and far below where streams cost a replica anything — measured, one
  replica held **2,000** concurrent streams at ~100 KB each with CPU at ~0% and
  a fresh request's p50 unchanged, and those streams consumed **zero** database
  connections, being fed by Realtime rather than by polling.

  Two properties, both load-bearing. The reservation is taken BEFORE
  `streamSSE` — like the project route's 404, since once the response is a
  stream there is no status left to send — and released in a **`finally`**
  around the whole callback, not in `sse.wait`'s cleanup: everything between
  the pusher and `wait` can throw (a reader, a watcher subscribe), and a slot
  leaked that way is not a slow leak but one scope permanently answered 429
  until the replica restarts. And the key is the SCOPE, never the project: a
  per-project key would let a caller cycling project names hold unlimited
  streams, the same evasion that made the scope-keyed rate limits decorative
  before they were paired with an IP key.
- **A long-lived connection is ONE Modal input, so the function `timeout`
  bounds CALL DURATION** — not request latency. The app therefore sets it
  explicitly (`FUNCTION_TIMEOUT_SECS` = 4h, matching
  `DEFAULT_SANDBOX_TIMEOUT_MS`). Left unset, Modal's default is **300s**, and it
  severed every in-process session (the old `?host=1` host mode, since
  removed) at exactly five minutes, mid-word — the client saw a bare "not
  connected" and the server logged nothing, because nothing in our code did
  it. No session runs in the server process anymore — browser voice sessions
  dial the guest sandbox's tunnel directly, and `/:slug/websocket` upgrades
  are handshake redirects — but the studio's SSE streams sit under the same
  cap, so it stays pinned rather than inherited. The sandbox layer hit the same
  trap first and documents it in `modal-sandbox-env.ts`.

  **The 4h ceiling is load-bearing for the studio's event streams, which is a
  trap for anyone re-splitting the deployment.** The removed studio app set 30
  min, reasoned as headroom for a cold-sandbox Publish on the premise that
  "nothing here is long-lived by design" — true of WebSockets (chat streams
  browser→guest directly) and false of `GET /studio/events` and
  `GET /studio/projects/:project/events`, which a browser holds open for as long
  as a project is on screen and which did not exist when that value was set. It
  never bit, because combined mode serves those routes under the 4h. A revived
  studio service would start reaping them at 30 minutes.

  **Most `TransferEncodingError`s in the log are NOT truncation we caused.**
  Measured over 6h of production `aai-server-web` logs (2026-08-05): 38 SSE
  stream completions, 40 of these errors, pairing 1:1 by timestamp — at every
  duration from 25s to 1375s, and continuing across a redeploy that shipped the
  registry above. Modal's `_proxy_http_request.send_response()` is still
  iterating the upstream body when the client goes away, and Modal never awaits
  that task ("Task exception was never retrieved"), so ONE lands in the log per
  abandoned stream. The browser is already gone when it fires. Two corollaries
  before treating a spike as a regression: **join it to Modal's request log
  first** — the `duration` on the completion line at the same second is the
  stream's whole lifetime, which is what separates a client abort (any
  duration, all of them multiples of `SSE_HEARTBEAT_MS`, because nothing in the
  chain notices a departed client until data flows) from a real deadline (a
  tight cluster at one value); and a rise in the count usually means a client is
  churning subscriptions, not that a stream was cut.

  **So the container COLLAPSES each one to a single line**
  (`install_proxy_noise_filter` in `scripts/modal_image.py`, installed at the
  top of `server()` in `modal_deploy.py`). Left whole they are the log's
  dominant content and they crowd out the thing you opened it for: across one
  60-minute production window they were ~600 of ~3,200 lines while the service
  served **zero 5xx** — and the window in question also held 13 failed
  container starts and a `crash-looping` line that took a targeted grep to
  find. The twenty-odd frames are Modal and aiohttp internals, identical every
  time and actionable never.

  **Collapsed, NOT dropped**, because the count and the timing are the entire
  diagnostic — the rule above is to join a RISE to the request log, and a
  deleted record makes that impossible. It stays a record on the `asyncio`
  logger, at the same level, carrying its exception type; only the traceback
  goes. It is also matched on TWO discriminators (the exception name **and**
  `_proxy_http_request` in the record), so it can never decay into swallowing
  asyncio errors: one of our own tasks dying the same way, or Modal's proxy
  task dying of anything else, still prints in full. `modal-image-inputs.test.ts`
  pins all three properties, which is worth the ceremony because every way this
  rots is silent and in the same direction — toward eating a traceback you
  needed, in a log nobody reads until an incident.

  **Capping the streams' own lifetime was considered and rejected.** It cannot
  reduce the above — a tab close still aborts whatever stream is open — while
  `projectPayload` carries `files: workspace.files`, so every forced recycle
  re-sends the whole workspace file map to every open tab. If a split studio
  service ever ships, raise its function timeout rather than adding a cap under
  it.

## Studio starter evals

The LLM-judge codegen suite (`studio-eval.test.ts`, vitest-evals) was
removed in favour of a harness that drives the studio's REAL surface —
create project, broker a sandbox session, stream a chat turn to the guest —
rather than calling the codegen path directly. It is a case of the repo's
**eval tier** now (`packages/aai-evals/src/starter.eval.test.ts`), which owns the
runner, the repeats and the report:

```sh
pnpm dev:aai-server                                 # in another shell
pnpm test:eval                                      # every starter
AAI_EVAL_ONLY=pizza AAI_EVAL_REPEAT=3 pnpm test:eval
```

Its own second runner — `run.mjs`/`report.mjs`/`regrade.mjs`, 745 lines of case
loop, verdict and reporter — is deleted, and so is the rest of
`scripts/starter-eval/`. What survived is the GRADING, which is a different job
from a case loop: it is
`packages/aai-evals/src/starter-expectations.ts` today. See
`packages/aai-evals/CLAUDE.md` for the runner and why the tier does not gate.

It spends real tokens on the caller's own key, so it is not in CI. Three
things it measures that the judge suite did not:

- **Shippable, not just green.** The agent writes its own tests, so "the
  tests passed" is a measure it can satisfy by weakening an assertion. The
  primary verdict is instead whether the built agent covers the capabilities
  the PROMPT enumerated (`packages/aai-evals/src/starter-expectations.ts`), checked
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
edits produce. Use `AAI_EVAL_REPEAT=3` and compare arms — the runner names the
assertions that were not unanimous, and one in that list cannot adjudicate
anything yet. Expect a plausible
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

## Serving a current studio client in dev

**`predev` also rebuilds the studio front-end**: aai-studio-server's
`predev` ends with `pnpm --filter aai-studio-client build`, so
`pnpm dev:aai-server` always serves a current client. `studio-static.ts`
serves whatever is in that package's `dist/` — nothing checks its age —
so without this a stale (or absent) bundle is served silently and the
studio looks unchanged no matter what you edit. Unconditional rather than
staleness-gated like the harness above: the build is sub-second, which is
cheaper than the check would be worth.

## One deployment, two packages (aai-studio-server / aai-server)

Two packages, one surface each, composed into a single process.

`aai-server` is the agent surface plus the shared platform core (stores,
locks, epochs, sandbox machinery); `platform-barrel.ts` is the sanctioned path
to its `_`-internal utilities. **It ships no entry point** — it is a library,
consumed through its `exports` map, and has no `build` (its subpaths resolve to
`.ts` source, which its consumer bundles).

`aai-studio-server` is the studio surface AND the composition root: its entry
is the only one any deployment runs, dispatching studio paths (`isStudioPath`,
`aai-server/studio-paths.ts`) to the studio app and everything else — including
`/health` and the WebSocket upgrades — to the agent orchestrator. Both apps
share one `ServiceConfig`, so they share the slot cache and stores. That entry
is what `pnpm dev:aai-server` runs too, so local dev and production are the
same composition.

There is ONE Modal app: `aai-server-web`, from `packages/aai-server/
modal_deploy.py`. Note the asymmetry — the deploy script lives in the package
that does NOT provide the entry; it is the platform's deploy policy, and it
launches `packages/aai-studio-server/dist/index.mjs`.

**A SPLIT deployment used to live here** — a second Modal app
(`aai-studio-web`) with the agent app reverse-proxying to a
`STUDIO_UPSTREAM_URL`. Removed rather than left dormant: the upstream was never
wired, so the combined branch was the only one that ever ran while the split
half still constrained the design.
`packages/aai-server/modal_deploy.py`'s own "One app, both
surfaces" block carries the motivation and what reviving it would cost; two
constraints survive any revival — **one public origin** (agent pages set
`X-Frame-Options: SAMEORIGIN`, so a studio on a second hostname breaks the
preview iframe), and the studio service would need the event streams' timeout
raised (see "A long-lived connection is ONE Modal input").

**aai-server is COMPILED IN to that entry, and the bundler pattern must match
its SUBPATHS.** `aai-studio-server/tsdown.config.ts` lists it under
`deps.alwaysBundle`; `alwaysBundle` matches the SPECIFIER, not the package, and
every import here is a subpath (`aai-server/orchestrator`, …), so the
`/^aai-server$/` this replaced matched nothing and the whole package stayed
external. Nothing said so — the build succeeds and the entry runs; `dist/
index.mjs` is merely 150 KB of import statements rather than a 3.7 MB bundle.
The cost is paid at every container COLD START, because this package's exports
resolve to `.ts` SOURCE (it has no build): an externalized entry made every
boot resolve, read, type-strip and compile ~72 TypeScript modules before
serving a request, and left the image's compile cache (below) keyed on 72 files
instead of one. `bundled-deps.test.ts` holds the pattern to the specifiers the
entry really imports — the built file cannot be the guard, since `test` depends
on `^build`, not on this package's own build.

One consequence to keep in mind when adding code to aai-server: **the module's
own location is no longer where its source lives.** `createRequire(import.meta
.url)` resolves from `packages/aai-studio-server/dist/`, whose pnpm
`node_modules` has no `aai-guest` above it — which is why `guestPackageDir`
(modal-harness-image.ts) falls back to deriving that package root from the
harness path. Anything else that resolves a workspace sibling by module
location owes the same fallback.

**The shared core is the `exports` map, and nothing else.** It is an
explicit list of 31 subpaths, grouped by role (stores, coordination, sandbox
machinery, schemas, app composition, the routes the studio reuses), and
`platform-surface.test.ts` holds it to the imports that actually exist in
both directions — an entry nobody imports fails, and so does an import with
no entry. It was `"./*": "./*.ts"` for a long time, which meant every one of
the package's ~70 modules was published to the sibling: the prose above
described a "shared core" that no code distinguished from the agent
service's own internals, so `aai-studio-server` reached into 31 of them and
none of those reaches could be called a violation. Widening the surface is
now an edit to package.json rather than a side effect of typing an import
path. When a coupling goes away, delete the entry — this list only ratchets
down, like the file-length allowlist.

- **One public origin**, now structurally rather than by proxying: both
  surfaces are served by one process on one hostname. This is what keeps the
  preview iframe working — agent pages are served `X-Frame-Options:
  SAMEORIGIN`, so the studio must share their origin. Shared base middleware
  lives in `app-middleware.ts` so the two apps can't drift on CORS/framing
  policy.
- **Never derive the public scheme from the request URL** — use
  `resolvePublicOrigin` (`aai-server/public-origin.ts`). Modal terminates TLS
  at its edge and forwards plain HTTP to the container (its ASGI proxy adds
  only `X-Forwarded-For`, never `X-Forwarded-Proto`), so `new URL(c.req.url)`
  is **always** `http:` in a handler, whatever the browser used. Resolution
  order: `AAI_PUBLIC_ORIGIN` → `x-forwarded-host`/`-proto` (a real proxy in
  front) → infer, loopback being the only `http`.

  Both places that had rolled their own cost real outages. Studio **Publish
  died on `401 Missing Authorization header` from its own platform**: the
  guest was handed `http://<public host>`, its `aai deploy` POST was
  308-redirected to `https://`, and `fetch` strips `Authorization` across a
  scheme change (different origin per the Fetch spec). The request arrived
  unauthenticated, so the CLI reported an invalid API key it had in fact sent
  correctly. (The since-removed studio proxy propagated the same wrong answer a
  second way, forwarding its own `x-forwarded-proto: http`.) The bare-slug
  redirect
  (`/:slug` → `/:slug/`) separately echoed the cleartext URL back as an
  absolute `Location`, bouncing https browsers through `http://`; it is now
  relative, which no scheme can taint.

  **A resolved origin may be used WITHIN the request that asked for it and
  never stored for a later one.** `Host` and `x-forwarded-*` are the caller's
  to write, so a use inside the request is self-directed (a caller who lies
  gets its own lie back) while one that outlives it is an injection — see
  "Durable workflows" below for the shipped instance.
- **Cross-origin callers come from `AAI_ALLOWED_ORIGINS`, and unset means
  none.** Comma-separated, or `*`; read in `app-middleware.ts` so both surfaces
  get one answer, an explicit `allowedOrigins` argument still winning.
  Rejecting is right here — both surfaces are same-origin by construction. It
  was settable by no composition at all for a long time, while the option's doc
  claimed a default of "any origin": fail-closed, so never a hole, but the only
  documentation there gave the wrong answer to "is CORS open?".
- **Cross-service invalidation is the agents row's CHANGE STREAM**
  (`agent-store.ts` for the row; `platform-events.ts` /
  `realtime-events.ts` for the stream; `watchAgentInvalidation` in
  `sandbox-resolve.ts` for the handler). Mutation handlers ONLY write the
  row — deploy upserts it (bumping `version`), delete removes it — and
  every replica, the writer included, reacts to the resulting Supabase
  Realtime `postgres_changes` event: the handler drops the bundle-store
  row caches, re-reads the version fresh (events are signals, never
  payloads), and retires a resident at a different version (terminates on
  a deleted row — a deleted agent must stop answering, not drain). This is
  how a studio-service Publish reaches the agent service's resident
  sandboxes within seconds. There is no separate signal to send — the row
  write IS the notification, so no bump can be missed — and no duplicate
  detection paths: the per-broker lazy version check and the idle sweep's
  `SupersededCheck` were both removed when the change stream replaced
  them, so `resolveSandbox` serves any LIVE resident as-is and the idle
  sweep is purely about idleness. (Worker/client blob caches are
  hash-keyed and immutable — a stale row is a consistent OLD deploy, never
  a torn mix, and a wrong blob is structurally impossible.) The handler's
  version comparison under the slug lock is what makes duplicated or
  reordered events harmless; an unreadable version logs and leaves the
  resident alone rather than killing a healthy sandbox.

  **The stream's REJOIN is itself a signal, and on THIS stream it has to be.**
  `subscribe()` only sends the join — the binding is not live until the ack,
  and realtime-js rejoins after any socket drop — so changes in either window
  reach nobody, ever. The pooled channels always fired their watchers on the
  ack; the AGENTS channel did not, and it is where the gap is unrecoverable,
  being the single mover of residents with no later check behind it (see the
  deleted duplicate paths above). A deploy during a drop left the replica
  serving superseded code and a delete left it answering for a deleted agent,
  until the guest happened to self-exit on idle — for a busy agent, never,
  since traffic is what keeps it non-idle. The deploy reported success.

  So `watchAgents` takes a second, slug-less `onResync`, which
  `watchAgentInvalidation` answers by re-running the same per-slug reconcile
  over every resident. Three properties: it is a **separate callback, not a
  nullable slug**, so a consumer that ignores resync says so by omission
  rather than mishandling a sentinel silently; **the residents are the query,
  not the agents table** — one version read per sandbox actually served
  (single-flighted, 1s-cached) and none at all on a replica holding none,
  because every reconnect fires this and the common case must stay a cheap
  re-read; and **registration precedes `ensureAgentsChannel()`**, so a join
  cannot fire ahead of the watcher that triggered it.

  The subscription MONITOR (`createSubscriptionMonitor`, via `/health`) is the
  complement, not the same thing: it makes a channel that never joins visible,
  and cannot repair one that dropped and recovered on its own — the common
  case, and the silent one.

  **Deploy, delete, and provisioning a database move sandboxes; a SECRET
  change does not** — it writes Vault and bumps nothing, taking effect on the
  agent's next deploy (or whenever its sandbox is next rebuilt). That trade
  deleted the whole secret-invalidation mechanism (the old
  `aai_platform.slug_epochs` table); the documented way to apply a secret is
  still to redeploy. (A per-app DATABASE was the exception, because a guest
  cannot re-read a connection string; there are none now.)

  **Supabase setup this depends on lives in `supabase/migrations`**, applied
  with `supabase db push` BEFORE the code that queries it: the `aai_platform`
  schema and its tables, the watched tables' membership in the
  `supabase_realtime` publication, the
  `service_role` SELECT grants, the workspace-child foreign keys, the
  orphan-sweep's `studio_workspaces.preview_slug` generated column + index,
  and the
  `pg_cron`/`pgmq`/`pg_net` extensions. Realtime validates channel filter
  columns (and gates row visibility) against what the subscriber's claimed
  role can SELECT, and the app-created `aai_platform` schema gets none of
  Supabase's default `public` grants, so without those grants every filtered
  subscribe fails with `invalid column for filter <col>`. Only the pg_cron
  SCHEDULING stays at boot (`schedulePlatformSweeps` via
  `bootstrapPlatformDb`), because the sweep bodies are defined in TypeScript
  and change with the code that owns them.
  The env carries `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for the
  Realtime socket, required in production alongside `SUPABASE_DB_URL`.
- **A superseded sandbox is RETIRED, not terminated** (`sandbox-retire.ts`).
  A mutation replaces the code a slug runs; it says nothing about the calls
  already in flight on the old sandbox, and closing their sockets inline —
  which every mutation path used to do — meant shipping during the day
  dropped live conversations. `retireSlot` splits the two things
  "terminate" conflated: it detaches the sandbox from the slot
  **synchronously, with no await in between** — the broker is the only
  routing point, so from that instant no NEW session can reach it and the
  slug is free to rebuild — then FIRE-AND-FORGETS one deadline-carrying
  `POST /manage/drain` to the guest. The GUEST owns the drain from there
  (`harness-agent-mode.ts`): it refuses new direct-dial sessions, exits the
  instant its last session ends, and exits at the deadline
  (`SANDBOX_RETIRE_DRAIN_MS`, 10 min, env overridable; 0 terminates
  immediately) regardless — a retired sandbox is a billed guest running
  superseded code. The host keeps NO drain state and runs no poll loop; an
  unreachable guest (the drain request rejects) is terminated on the spot.
  - **Retirement is for superseded, not gone.** A failed VM, an exited
    guest, and a deleted agent stay on `terminateSlot`: there is nothing to
    drain, and a deleted agent must stop answering rather than keep taking
    calls for ten more minutes.
  - **Process teardown deliberately does NOT chase retired guests** — they
    are off the slot map and self-governing; their drain deadline is
    minutes past the container grace period, and Modal's sandbox `timeoutMs`
    is the backstop behind everything.
- **The studio service holds an always-empty slot cache** — the shared
  mutation cores' local sandbox teardowns are deliberate no-ops there,
  while the deploy's row-version bump does the real work. It shares
  everything else through Supabase and spawns its own Modal sandboxes for
  `test_agent` and Publish.
- **The web service autoscales** (constants block in `modal_deploy.py`),
  bounded by `MIN_CONTAINERS`/`MAX_CONTAINERS`. Scale-in is FREE for voice
  sessions: a replica going down RETIRES its agent guests instead of
  waiting on or terminating them (`teardownSandboxes` — one awaited,
  deadline-carrying drain per guest, then exit).

  **Shutdown has to stop BOOTING sandboxes before it stops serving.**
  Flipping `draining` only makes `/health` fail; the proxy stops routing here
  when it notices, up to a health-check interval later. A request landing in
  that window used to take the cold broker path, find an emptied slot, and
  spawn a guest seconds before the process exited — ORPHANED, since no slot
  referenced it and nothing held it, billing until Modal's idle timeout. Two
  guards, in order of importance: `brokerSessionUrl` refuses to boot a new
  sandbox when `isDraining` (503, so the client re-brokers onto a live
  replica) while still serving a LIVE resident, which orphans nothing; and
  `teardownSandboxes` waits `SHUTDOWN_GRACE_MS` (3s, env-overridable) before
  emptying the slots, so requests that would have been served still are. The
  wait is deliberately short — it spends the same SIGTERM allowance the
  drains need, and an undelivered drain is the worse failure. The studio-only
  service passes 0: its slot cache is always empty, so it has no such window.
  Sessions dial the sandbox
  tunnel directly and the guest has no dependency on the replica, so live
  calls finish in the guests on their own clock after the replica is gone;
  the next replica's broker spawns fresh sandboxes on demand. The old
  count-guest-sessions-and-wait shutdown drain (`liveGuestSessions`,
  `drainActiveSessions`, `SHUTDOWN_DRAIN_MS`) was deleted — it could only
  ever delay the exit, and past its 120s budget it cut the very calls it
  existed to protect. Studio guests DO go down with the replica (the
  broker's `dispose()`): their coding-agent sessions live on the host's
  control channel, so a dead host makes them useless.

  **Shutdown is BOUNDED at two levels**, because `createShutdownHandler` arms
  its `SHUTDOWN_CLOSE_FALLBACK_MS` timer only AFTER `onShutdown()` settles — so
  the sole deadline used to cover the fast half (waiting for connections to
  close) and leave the slow half unbounded, and the slow half is the one that
  hangs. `SANDBOX_TEARDOWN_READY_MS` caps the readiness wait `Sandbox.drain` /
  `shutdown` inherit from the spawn (the 120s BOOT budget, spent on guests with
  nothing to drain); `SHUTDOWN_TEARDOWN_TIMEOUT_MS` is the general net over it,
  since the Modal calls underneath carry no timeout at all. Both constants
  carry the budget arithmetic and the why-giving-up-is-safe argument in
  `constants.ts`; read them before changing `SHUTDOWN_GRACE_MS`, which they are
  sized against. Pinned by tests that FAIL FAST rather than hang — "this
  settles within a budget" times out to the suite limit once the budget is
  gone, so the teardown promises are never awaited; settlement is recorded on
  a `vi.fn()`.
- **Shutdown ENDS long-lived responses; it must never let the process exit
  destroy them** (`live-streams.ts`, wired into `serve-lifecycle.ts`). SSE
  streams never end on their own, so `server.close()` waited out
  `SHUTDOWN_CLOSE_FALLBACK_MS` and `process.exit(0)` destroyed the sockets,
  cutting each chunked body before its terminating `0\r\n\r\n` — a protocol
  error to whatever is reading. Three properties of the ending are each a hole
  that put the truncation back while the registry looked correct: it runs FIRST
  (before the sandbox teardown, which sleeps and then awaits a drain per
  guest), the registry LATCHES closed (so a stream registered mid-shutdown is
  ended on the spot rather than held until the exit), and the crash path ends
  them too (`installProcessSafetyNets`). **Any future long-lived response owes
  the same registration**; the guard is `live-streams.test.ts`, which reads raw
  socket bytes because a handler-level assertion passes with the bug present.
- **A long-lived connection is ONE Modal input, so the function `timeout`
  bounds CALL DURATION** — not request latency, which is why the app pins
  `FUNCTION_TIMEOUT_SECS` (4h, matching `DEFAULT_SANDBOX_TIMEOUT_MS`) rather
  than inheriting Modal's 300s default. Nothing long-lived runs in this process
  today — voice sessions dial the guest tunnel directly and `/:slug/websocket`
  upgrades are handshake redirects — so the only responses under that cap are
  the STUDIO's two event streams. Their whole story, including why 4h is
  load-bearing for a revived split deployment, what the recurring
  `TransferEncodingError`s in the log are (mostly not truncation we caused),
  the log filter that collapses them, and why capping a stream's own lifetime
  was rejected, is in "Long-lived responses (SSE)" above.
