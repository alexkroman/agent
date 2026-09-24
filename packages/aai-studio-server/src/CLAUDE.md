---
summary: >-
  The studio service's feature rules: workspaces, the CLI round-trip, projects,
  coding-agent sessions and the fleet-wide sandbox, previews and their event
  streams, project secrets, agent logs, Publish, LLM selection, auth, and rate
  limits.
read_when: >-
  editing any `studio-*.ts` module or route in `src/`.
---

# `src/` — the studio service

Every studio module sits directly in `src/`, so this guide covers all of them.
Elsewhere:

- Prompt text and the project kind: [`prompts/CLAUDE.md`](prompts/CLAUDE.md).
- Sync to GitHub (`studio-github-*.ts`):
  [`../GITHUB-SYNC-CLAUDE.md`](../GITHUB-SYNC-CLAUDE.md) — read it before
  editing those files.
- The two event streams' lifecycle, caps and shutdown:
  [`../SSE-CLAUDE.md`](../SSE-CLAUDE.md).
- The guest side of the coding agent (tools, turn loop, workspace FS):
  `packages/aai-guest-studio/`, documented in "The coding agent is an ordinary
  `agent()`" in `packages/aai-guest-studio/CLAUDE.md`.

## Workspaces

- One row per project in `aai_platform.studio_workspaces` (platform `SqlExec`;
  in-memory in dev/tests, `workspace-store.ts` — the `SecretStore` pattern).
  Blob `Storage` holds only deploy artifacts.
- Writes go through `createWorkspace` / `mutateWorkspace`
  (`studio-workspace.ts`): optimistic `version`, one retry on conflict. The
  in-process `workspaceLock` serializes local writers, so a conflict means
  another replica.
- **A path is normalized where it is stored, not merely validated.**
  `stampWorkspace` keys the file map on `SafePathSchema`'s `posix.normalize`d
  path, so `agent.ts` and `./agent.ts` are one entry. Every writer goes through
  it (editor PUT, guest sync, `aai push`); the push also normalizes before its
  byte-identical check, and `DELETE …/file` normalizes `?path=`.
- **Metadata stamps never rewrite files**: use `stampWorkspaceMeta`
  (`WorkspaceStore.patch`, a single `doc = (doc - remove) || set`).
  `WorkspaceStamp` omits `files` and `hash` by type, so a stamp cannot revert a
  mid-deploy edit. It still bumps `version` (which drives the change stream and
  so the SSE push) and still takes the workspace lock (so it cannot spend a
  local write's single conflict retry).
- **Scope** is a deterministic SHA-256 (`studioScope`; `requestScope` in
  `studio-routes.ts`), so a caller can find its projects again. Browser
  session → `user:<uid>` (stable across key rotation). A raw key an account
  owns → the same `user:<uid>`, via the `key-user:<sha256(key)>` mapping in
  `resolveBearer` (written by `PUT /studio/account/key`, backfilled by
  `POST /studio/cli-link/approve`; why the backfill matters is in
  `packages/aai-server/CLAUDE.md`). Only a raw key no account has claimed
  (evals, programmatic callers) scopes by the key itself.
- `hasUnpublishedChanges` compares `filesHash` with `deployedHash` →
  `unpublished` on the payload. No pane renders it; it stays because it is the
  only report of production drift. A hash, not a timestamp: deploys bump
  `updatedAt`, and edit-then-undo must not read as stale.

## The CLI round-trip

`aai list/pull/push/publish/delete` (CLI side: `packages/aai-cli/CLAUDE.md`).

- `GET /studio/projects/:project` returns `sourceHash` (the stamped FILES hash)
  as the pull's fast-forward token. **Never the row version** — preview and
  Publish stamps bump it after nearly every edit.
- `PUT /studio/projects/:project/source` (`syncWorkspaceSource`) replaces the
  file map atomically: upserts on first push (reserved-name and
  create-rate-limit gated), 409s on a stale `baseHash`, and no-ops (no version
  bump, no preview) when byte-identical.
- A push that changed something schedules a preview deploy **and** calls
  `refreshSession` on the broker: a guest materializes its workspace once, at
  install, so a pre-push session would sync its stale tree back OVER the push.
  The refresh reuses the local sandbox or adopts a peer's (`fleet.adopt`) and
  **never spawns** — no live sandbox means nothing stale, and a CLI push must
  not boot a coding agent.
- `DELETE /studio/projects/:project` deletes the project: workspace, chat,
  deployed + preview agents (via `deleteAgentResources`, each slug gated by
  `verifySlugOwner` so a workspace naming a foreign slug is no deletion
  oracle), and the project's secret record.

## Projects and slugs

- Projects are created from the chat: the first message is posted as `prompt`
  to `POST /studio/projects` and the SERVER mints the name (a prompt-derived
  base plus a random suffix, via `aai-server/slug-generate.ts`). An explicit
  `name` stays for programmatic callers. Each project lives at `/studio/chat/<name>`.
- A project's kind selects its system prompt — "A project has a KIND" in
  [`prompts/CLAUDE.md`](prompts/CLAUDE.md).
- **Reserved slugs** (`RESERVED_SLUGS` in `schemas.ts`): `studio` and
  `studio-assets` would shadow the studio routes. Enforced in `validateSlug`,
  `DeployBodySchema`, and the deploy core.
- `projectSlugFor` / `previewSlugFor` (`studio-project-slugs.ts`) name a
  project's two agents. **The preview slug is `<project>-preview` shortened by
  DIGEST, never truncation** (the last nine characters digest the whole name):
  names run to 64 characters, and truncation silently mapped distinct projects
  onto one preview agent. A deployed preview is read from the `previewSlug`
  stamp, so only new previews are affected by the scheme.

## Coding-agent sessions

- `POST /studio/projects/:project/session` (rate-limited;
  `studio-session-broker.ts`) boots or reuses a guest via `spawnWarmHarness`,
  installs the session over the control channel (`studio/session-init`: files,
  the caller's key, system prompt, model config), and returns the sandbox's
  public chat URL. The browser streams turns **directly** to the guest's
  `POST /studio/chat` — chat never passes through the host. The guest also
  serves `GET /studio/tools` (`STUDIO_TOOL_LABELS`).
- `studio-session-ensure.ts` holds the reuse → adopt → spawn ladder and what an
  install is; everything in it runs under the per-project lock.
  `studio-session-idle.ts` is teardown and idle eviction.
- **The chat surface is gated by a broker-minted `chatToken`** (the tunnel URL
  is public; the token rides session-init to the guest and the broker response
  to the browser; CORS-open). **Minted once per SANDBOX** and stored in the
  registry row — the guest holds exactly one, so re-minting revokes every other
  tab's token. A replacement sandbox mints a fresh one.
- **The client re-brokers on ANY chat-surface rejection** — failed fetch, 409,
  or 401. The guest authenticates only the `chatToken`, so its 401 means stale
  session, never "sign the user out".
- **One turn at a time per guest PROCESS** (`createTurnGate` in
  `aai-guest-studio/src/turn-stream.ts`): a concurrent turn gets **423 +
  `code: "turn_in_flight"`**, never a server-side queue (a waiting request's
  conversation snapshot clobbers the turn it waited for; the tab's own queue
  re-reads at dispatch). Per process, because session-init runs on every page
  open; released on response CLOSE as well as settle, or a client that stops
  reading locks the project. 423 is distinct because `resilient-fetch.ts` reads
  401/409 as "re-broker", and a busy guest is healthy. Known gap: a live tab
  does not catch up with another tab's turn (`ProjectChat` reads
  `initialMessages` once).
- The same file holds the guest's other two delivery rules: a broken model
  stream ends in an `error` frame (`withStreamErrorChunk` — never
  `void result.pipe…`), and persisted assistant messages get
  `generateMessageId`.
- **`ensureSession` is serialized per (scope, project), and entries are
  disposed by IDENTITY, not key.** Overlapping brokers are routine
  (double-click, StrictMode, a racing reload); unserialized, the loser's
  sandbox is orphaned — unreachable by the sweeper and `dispose()`, still
  billed, its `wire()` handlers still syncing. Every cleanup runs after an
  await, when the key may already hold a replacement (the `createOwnedMap`
  reason).
- End of turn the guest calls `studio/sync-workspace` (validated like a client
  PUT; source files only — never node_modules/dist/.git — under the file caps)
  and `studio/persist-chat` (→ `aai_platform.studio_chats`, served by
  `GET …/chat`). Only the turn-complete sync carries `done: true`.
- The composer's Stop button aborts the SSE fetch; the guest's request-close
  handler aborts `streamText` and in-flight tools.
- The guest holds no tenant data and no platform secrets: LLM calls dial the
  gateway on the caller's key, tools run on the guest filesystem.
- Idle eviction at 5 min (`STUDIO_SESSION_IDLE_MS`); a dead sandbox heals on
  the next broker call. Studio guests go down with their replica (`dispose()`):
  their sessions live on the host's control channel.

## One studio sandbox per project, fleet-wide

A studio guest is stateful to the host (installed workspace, key, prompt), and
two live guests for one project would race `studio/sync-workspace` on one row.

- `studio-session-registry.ts` (`aai_platform.studio_sessions`) holds the chat
  URL + `chatToken` a browser gets and the guest origin + per-sandbox token a
  peer needs. Ladder: local hit → reuse; registry row → **adopt**
  (`studio-session-adopt.ts`); neither → named cold spawn
  (`studioSandboxName(scope, project)`) + claim.
- **The lease stays, although agent sandboxes dropped theirs**: the owner's
  sweeper must know whether ANY replica used the project recently, and a
  peer's chat traffic goes browser→guest where the owner cannot see it. The
  Modal name adds what the lease cannot guarantee — two replicas racing the
  cold path cannot both spawn.
- **Adoption is HTTP, never the control socket** — a harness accepts one
  socket (409 on a second). The guest's `POST /studio/session-init` twin is
  gated by the per-sandbox HOST token. Ownership never moves.
- **The install is the liveness probe**: anything but a clean 2xx drops the row
  and falls through to a cold spawn.
- **The guest pins its identity**: `initStudioSession` refuses (409) an install
  naming a different (scope, project) than its first, or a mis-keyed row would
  put one tenant's workspace in another tenant's guest.
- **Lease and local idle window are ONE number** (`STUDIO_SESSION_IDLE_MS`). The
  sweeper consults the row before evicting; guest RPC activity touches it too.
- **Every rung refreshes the lease, reuse included** — else a peer landing on
  an expired row cold-spawns into Modal's duplicate-name refusal and answers
  404 for a live project. `studio-session-broker.test.ts` asserts it as expiry,
  not as a touch count.
- **A sandbox with work inside it is not idle** (`SessionEntry.inFlight`, held
  by `LiveSession.hold` for a `workspace/deploy`; `WORKSPACE_DEPLOY_TIMEOUT_MS`
  is 330s against the 300s window). Re-read the count after the `heldByUs`
  round trip — a Publish can begin inside it.
- The registry carries `replicaId` (`ServiceConfig.replicaId`) and degrades to
  per-replica behaviour with no platform database (dev and tests).

## Previews

The Preview pane shows an auto-deployed PREVIEW agent; Publish is production.

- Triggers: the guest's turn-complete sync (`done: true`; mid-turn checkpoints
  never deploy) and editor file PUT/DELETE. The deploy is the same in-guest
  `aai deploy` path Publish uses (`studio-preview.ts`).
- **Scheduling is durable** (`studio-preview-queue.ts`: `pgmq` in production,
  in-memory in dev): at-least-once, a claimed job hidden for a visibility
  timeout; archived past `PREVIEW_JOB_MAX_ATTEMPTS`; pg_cron prunes the
  archive. There is no coalescing logic: the deploy re-reads and no-ops when
  `previewHash` matches, under a per-project drain lock.
- **The no-op still clears a stale `previewError`** — undoing a bad edit
  hashes back to the last good stamp, and the banner must not outlive the code.
- **Force a redeploy only via `forcePreviewRedeploy`** (clear `previewHash`,
  then schedule). The secret switch skips it when there is no `previewSlug`
  yet, deliberately, at the call site.
- **A queue row never carries a credential**: it names `userId`, and the drain
  reads `user-key:<uid>` from Vault. A raw-key job has no `userId`, runs only on
  its enqueuing replica, and is archived if redelivered.
- **`userId` comes from ONE builder, `previewOrigin`** (`studio-settled-edit.ts`)
  — settled edits, the project-open wake and the broker (`ensureSession` takes
  a `PreviewOrigin`, so the guest's own sync inherits it). Omitting it is silent
  until a redelivery. `PreviewOrigin` is `Omit<PreviewTarget, "apiKey">`, so a
  new target field is a compile error at every builder.
- Success stamps `previewSlug`/`previewHash`; failure stamps `previewError`
  (no chat turn carries auto-deploy output). `GET /studio/projects/:project`
  returns `previewSlug`/`previewVersion`/`previewStale`/`previewError`.

### Waking a preview (`studio-preview-wake.ts`)

The wake never deploys anything itself; `studio-preview.ts` owns the loop. Two
triggers, both needed:

1. The once-per-open broker call warms the preview's sandbox through the public
   client-config broker (`warmPreviewSandbox`).
2. The pane reporting the page missing (`POST /projects/:project/preview/wake`)
   — the only trigger an already-open tab has. **A trigger, never evidence**:
   the broker's answer decides, so a client cannot talk the platform into a
   deploy. Rate-limited (`PREVIEW_WAKE_RATE_LIMIT`, scope + IP) and throttled
   per project (`PREVIEW_WAKE_THROTTLE_MS`, an LRU `TtlCache` — not a limit on
   its own).

Then:

- Broker **404** → the preview agent is gone: clear `previewHash` and
  regenerate. **503** is a sandbox mid-boot: retry-only.
- A stale preview is NOT rescheduled — the queue owns delivery.
- **A stamped `previewError` is retried on open** — a settled failure is the one
  state with no queued job behind it. Do not classify deterministic vs.
  transient failures (that means sniffing CLI prose); being wrong costs one
  deploy. The stamp stays until a success. A project with no slug yet still
  schedules.

## Project event streams

`GET /studio/projects/:project/events` streams `project` frames (the GET's
payload) on every workspace-row change plus `chat` frames when a turn
persists; `GET /studio/events` streams the scope's project list. Signals are
Supabase Realtime `postgres_changes` (`platform/events.ts`); the route re-reads
the row per push. No polling; the client keys the iframe by `previewVersion`.

- **Streams watching one row share reads** (`createSharedReads` in
  `studio-sse.ts`), refcounted and dropped on last release. Two reads per
  change is correct (`createCoalescingRunner` cannot let a pre-trigger run vouch
  for that trigger); the count must not grow with tabs.
- **Subscribe before reading, and send the initial frame THROUGH `sse.push`**
  (`studio-events-routes.ts`) — read-then-subscribe loses changes during the
  Realtime join, and one serialized chain keeps frames ordered. The pre-stream
  read is only the 404 existence check.
- **A successful (re)join fires the channel's watchers** (`createChannelPool`,
  `realtime-events.ts`), covering the join round trip and every reconnect.
  Watchers register before `subscribe()` (a synchronous ack is legal); dispatch
  iterates a snapshot so a watcher may unwatch itself. `watchAgents` uses a
  separate `onResync` instead (see the root guide).

## Project secrets

`studio-secrets.ts` + `studio-secret-routes.ts`:
`GET/PUT/DELETE /studio/projects/:project/secret` is a PROJECT switch that
writes both agents. Per-slug `/:slug/secret` is the platform primitive beneath
it and the only surface for an agent in no project. Never fan out in the
client — `aai secret put` and `aai publish` would then reach production only.

- **The project holds its own record** (`studio-project-env:<scope>:<project>`
  in Vault — values stay out of the workspace doc, which streams to every tab),
  so a secret can be saved before anything is deployed. Written FIRST in both
  directions so a racing deploy cannot miss an update or undo a delete;
  `reconcileProjectSecrets` applies it as each deploy claims a slug (the
  broker's `afterDeploy`, `studio-deploy-hooks.ts`).
- **Resolve the project and its owned slugs BEFORE writing** — a 404 must not
  leave a Vault record under a name a later project could take.
- The record is a **floor, never an override** (a name already on the slug
  wins, so `aai secret put` is not reverted). A mutation redeploys the preview
  (a secret reaches env only when the sandbox is built); production waits for
  Publish. Project DELETE drops the record.

## Agent logs for the coding agent

`read_logs` (guest: `aai-guest-studio/src/logs-tool.ts`; host:
`studio-agent-logs.ts`, over the `studio/agent-logs` RPC):

- **The guest names an ENVIRONMENT, never a slug**; the host resolves it with
  `projectSlugFor` against the sandbox's pinned (scope, project). A slug
  parameter would read any guessable agent under the account's own key.
- It reuses the session's preview target (origin + key); no target, no read.
- It calls our public `GET /:slug/logs` over HTTP (which owns lookup, peer
  fallback and ownership) rather than `readAgentLogs` in-process.
- It returns the TAIL (drains forward, at most five pages of a 2,000-line
  ring), reports eviction, and distinguishes never-deployed / not running /
  running and silent.

## Publish

- **The coding agent cannot publish.** No deploy tool; only the Publish button
  (`POST /studio/projects/:project/deploy`) touches `deployedSlug`. Keep it that
  way.
- **Builds and publishes run in the guest, through the aai CLI** — there is no
  host-side build backend. `test_agent` builds in-process in the harness via
  `@alexkroman1/aai-cli/worker-bundler` from the baked toolchain
  (`aai-guest-studio/src/build.ts`); a one-shot child-process variant (#845)
  was reverted — read that PR before trying again. Publish spawns the literal
  `aai deploy --server <origin> --json` in the project's sandbox
  (`workspace/deploy` RPC; live sandbox reused, else an ephemeral spawn) after
  `ensureProjectShape` completes the workspace into a real project (scaffold
  files copied from the baked toolchain; `AAI_CONFIG_DIR` and
  `.aai/project.json` written by `@alexkroman1/aai-cli/project-config`). Build,
  upload, credential preflight, ownership, reserved slugs and the key floor are
  therefore the laptop path. End-to-end: `aai-server/workspace-build-integration.test.ts`.
- CLI output goes to the Publish menu, never the transcript ("No studio action
  writes into the transcript" in `packages/aai-studio-client/CLAUDE.md`).
- Missing credentials only WARN — a hard failure would deadlock a first publish
  that needs a third-party key.
- The origin is `requestPublicOrigin` (`studio-context.ts`, so route modules
  need not import `studio-routes.ts`) → `resolvePublicOrigin`.
- **Deployed-agent credentials**: the CLI seeds the caller's own key as
  `ASSEMBLYAI_API_KEY`, an env **floor** (`aai-cli/deploy.ts`) — a key declared
  in `.env` wins. Never a platform-owned key; `deployLocked` merges
  `{...storedEnv, ...env}`.
- A hostile workspace burns its own sandbox's CPU, never the web container's.

## LLM selection (`studio-llm.ts`)

- Every turn runs on the AssemblyAI LLM Gateway **with the caller's own key**,
  delivered via session-init as the agent's `llm` descriptor + `providerEnv`.
  The platform holds no studio LLM credential.
- The MODEL is host config: default `gpt-5.5`; `STUDIO_LLM_MODEL` overrides;
  `STUDIO_LLM_REGION=eu` selects the EU endpoint (Claude and most Gemini only),
  region-filtered by `GATEWAY_US_ONLY_MODELS`. The first
  `ASSEMBLYAI_GATEWAY_MODELS` entry surviving the filter is the default (EU:
  `claude-sonnet-4-6`).
- **A client can never name a provider or model**: `POST /studio/chat`'s schema
  strips `model`. Validate any future request-side choice host-side.

## Static and public pages

- **`GET /studio/api/<slug>`** (`studio-app.ts`) serves the shell with NO
  session: registered above `app.route("/studio", …)` so it never passes the
  auth middleware, and no ownership check because it returns only the shell —
  the browser reads the agent's already-public routes. Its param carries
  `SLUG_PATTERN_SOURCE`; `/studio` is already reserved.
- **The shell is `no-store`; hashed assets are `immutable`** (`studio-static.ts`)
  — a cached shell pins a browser to assets a rolling deploy deletes (a white
  page). Client half: `stale-build.ts` in `packages/aai-studio-client/CLAUDE.md`.

## Studio auth

The mechanism is the shared core's (`supabase-auth.ts`, `middleware.ts`,
`api-key-verify.ts`); the non-studio rules (raw bearers verified against
AssemblyAI, the two bearer forms, key↔account mapping) are "Auth" in
`packages/aai-server/CLAUDE.md`.

- Browser sessions are Supabase Auth. **Available sign-in methods are asked of
  GoTrue** (`GET /auth/v1/settings`, the client's `auth-methods.ts`), never
  listed here; an unreadable answer falls back to GitHub-only.
- **A platform database refuses the no-auth dev tokens** (`createStudioAuthFromEnv`,
  no `AAI_LOCAL_DEV=1` escape) — they let any caller claim any user id. See
  "Two questions, two sentinels" in `packages/aai-server/CLAUDE.md`.
- **Two verifiers; which a route gets is a security decision:**
  - `verifyAccessToken` (request path): `getClaims`, verified locally against a
    cached JWKS on asymmetric projects, a server call on HS256 — which is why its
    short TTL cache stays. **The cache entry is capped at the token's `exp`**
    (`getClaims` checks expiry only on a miss). Rejections cache with the flat
    TTL; only `isAuthRetryableFetchError` throws (a 5xx). `storageKey` is
    explicit because auth-js caches JWKS process-globally by it.
  - `verifyAccessTokenFresh` (`GET /auth/v1/user`, uncached): only
    `requireStudioUser` (the three account routes), which read/rotate the key
    and must see a sign-out immediately.
- Config: `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`. Local dev (`isLocalDev`)
  falls back to `createDevAuth` (`dev.<base64url({id,email})>.dev` tokens). The
  account surface (`GET /studio/auth`, `GET /studio/account`,
  `PUT /studio/account/key`) authenticates WITHOUT requiring a stored key — it is
  the onboarding step that sets one.
- **`aai login` links; it never signs in or creates an account.** The CLI mints
  a one-shot code, opens `<server>/?cli-link=<code>` and polls
  `POST /studio/cli-link/exchange`; the signed-in, key-onboarded browser
  approves via `POST /studio/cli-link/approve`, granting ONE exchange. Grants
  live in the SecretStore under the code's hash (`cliLinkSecretName`), expire in
  10 minutes, and are deleted on first read. There is no
  `GET /studio/account/key`: the exchange is the only way a raw key leaves the
  platform.

## Rate limits

The mechanism is `aai-server`'s (`rate-limit.ts`, `createPgRateLimiter`); every
window the platform runs is declared in `studio-rate-limit.ts`.

- Each window is rows in `aai_platform.studio_rate_limits` (one atomic upsert
  per check), so a limit holds fleet-wide rather than × `MAX_CONTAINERS`.
  **Fail-closed**: a database error propagates. pg_cron sweeps expired rows.
  `name` namespaces each limiter (the `studio_` table name is a misnomer).
- **Studio windows come from `createPgStudioRateLimiters`, the agent surface's
  three from `createPgAgentRateLimiters(sql)`**, each spread whole by the
  entry. A window the composition root forgets falls through to the in-memory
  arm and silently enforces `MAX_CONTAINERS`× its limit (route specs inject
  limiters, so nothing goes red). Held by `studio-rate-limit.test.ts`,
  `rate-limit.test.ts` (reads `orchestrator.ts` for an unanswered `RateLimiter`
  option) and `agent-rate-limits.scenario.test.ts`.
- **Every limited route is keyed TWICE — by scope and by client IP.** A raw-key
  caller chooses its own scope; the IP key bounds it before key verification
  makes a scope cost an account.
- With no `X-Forwarded-For` the IP key is the literal `unknown` (`client-ip.ts`):
  one fleet-wide shared bucket, over-limiting rather than opening. Modal always
  appends a hop; a proxy that strips it would put every caller in that bucket.
- Meter anything that can spawn a sandbox or costs a third party: the session
  broker, preview wake, project create, GitHub sync (`GITHUB_SYNC_RATE_LIMIT`).
