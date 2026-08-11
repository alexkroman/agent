# packages/aai-studio-client — studio front-end guide

The studio's React front-end (private package). The server it talks to over
HTTP/SSE is documented in `packages/aai-studio-server/CLAUDE.md`.

## The app

`packages/aai-studio-client` is a Vite-built React app (React 19 +
Tailwind v4 + `useChat` + TanStack Query + CodeMirror), its own private
workspace package built into its `dist/` by
`pnpm --filter aai-studio-client build`. It talks to the server purely
over HTTP/SSE (no code imports in either direction); aai-server serves
the built artifact, resolved via `require.resolve` in
`studio-static.ts` the same way aai-ui's `dist/default-client` is.
Panes: `chat.tsx` (chat + composer), and the three the top bar's
segmented control switches between — `preview.tsx`, `code-view.tsx`,
`settings.tsx`.

## The hero picks a KIND before it creates anything

`home.tsx`'s tablist switches between **Voice agent** and **Workflow**, and the
choice travels WITH the prompt into `onStart(prompt, kind)` →
`api.createProject({ prompt, kind })`. It is one decision made at one instant: the
server stamps `kind` on the workspace at creation and it selects the coding
agent's system prompt for the life of the project (see
`packages/aai-studio-server/CLAUDE.md`), so there is nothing to change later and
no route that would.

Two things the toggle has to get right, and both are about not lying about what
the user is about to get:

- **The starter pools are SEPARATE** (`starters.ts`: `AGENT_STARTERS` /
  `WORKFLOW_STARTERS`, `startersFor(kind)`). Offering a voice agent's examples on
  the Workflow tab would start someone in a project whose coding agent has been
  told not to write voice agents — the pick would fight its own instructions.
  `starters.test.ts` asserts the pools are disjoint and that a workflow sample
  contains no agent starter, whatever the random draw.
- **Both kinds are sampled ONCE per mount**, keyed by kind, so switching tabs and
  switching back shows the same five rather than re-rolling — a re-roll reads as
  the page losing its place.

The heading, blurb and placeholder come from one `KIND_COPY` record rather than
ternaries inside the JSX, so the two modes read as the two products they are and a
third would be a row rather than another branch in five places.

## Panes and behaviour

- **Settings is a PANE, not a dropdown** (`settings.tsx`): the top bar's
  segmented control switches Preview / Code / Settings, all three peers
  rendering full-width beside the chat panel (`StudioTab` in `top-bar.ts`
  is the one union; `app.tsx`'s `tab` state is the only selection). It was
  a floating 384px panel that scrolled itself — three unrelated sections
  (secrets, the CLI round-trip, Delete project) never laid out in that
  width. Nothing on the pane gates on a build or a deploy: Delete project
  has to work before anything has ever been published, so Settings is
  reachable whenever a project is open.
- **The sections are in a FIXED order, and copy points into it**: Work
  locally, Phone number, Database, Secrets, Danger zone — setting up first,
  provider keys after, destruction last. The order is not cosmetic: the Phone
  card sends the reader to "Secrets **below**" twice (its blurb, and the
  per-carrier missing-secret hint), which was pointing the wrong way while
  Secrets sat at the top. `settings.test.tsx` asserts the sequence of card
  titles, so moving one means updating that list — and re-reading any copy
  that names a neighbour's direction.
- **Secrets have their own section; storage has none.** Agent secrets are
  managed in the Settings pane's Secrets card, which talks to the project
  route (`/studio/projects/:project/secret`) and posts a note into the chat on
  every change (key names only, values withheld) so the coding agent knows
  which keys exist.

  **The card is UNGATED — no publish first.** It used to render "Publish the
  project first" until `deployedSlug` existed, which asks for the one order
  that cannot work: an agent needs its provider key to run at all, so the
  sequence was ship it broken, attach the key, ship again. And production is
  not even the environment that needs the key first — the preview agent is
  auto-deployed by the first edit and is the one the user is about to talk
  to. The server holds the project's own copy and reconciles it into each
  slug as a deploy claims one (`aai-studio-server/studio-secrets.ts`), so a
  save before anything is deployed is durable rather than a write reaching
  nobody. A name no deployed agent carries yet is labelled **"on next
  deploy"** from the response's `pending` list — a bare list would report a
  saved-but-undelivered key as live everywhere.
  **`ASSEMBLYAI_API_KEY` is platform-managed and the pane neither lists,
  deletes, nor sets it** (`PLATFORM_MANAGED_SECRETS` in `settings.tsx`): it
  is seeded at publish from the caller's own account key, so it is not a
  third-party key the user attached, and deleting it takes the agent off the
  air (an empty bearer → `unauthorized` from AssemblyAI) with nothing in the
  pane to put it back. Filtering it out of the list is also what withholds
  its Delete button — there is no row to hang one on. Setting it is refused
  by name rather than accepted: a save that then vanished from the list
  reads as a failed write. Overriding it with another account's key stays a
  CLI action (`aai secret`, or `.env` + `aai publish`), where it is
  deliberate.
- **The Database card switches `ctx.db` on per PROJECT, across both
  environments** (`database-card.tsx` → `GET/POST/DELETE
  /studio/projects/:project/database` → `aai-studio-server/
  studio-database.ts`). The platform primitive is per SLUG (`aai storage
  enable <slug>`, `/:slug/storage`) and a project is two deployed agents, so
  a per-slug toggle here would have made that the user's bookkeeping — and
  "enable the database" that only reached the preview would be a broken
  promise either way. Each environment gets its OWN schema: the preview is
  where half-finished tool code runs, and a shared one would let a preview
  turn drop the production table.
  - **Intent is stamped on the workspace (`databaseEnabled`); provisioning
    follows the SLUG.** The switch is reachable before either agent exists
    (the usual state — a project has a preview long before a publish), and
    provisioning an unclaimed slug would create a schema no cleanup path can
    see (the orphan-preview sweep and `deleteAgentResources` both key off an
    agents row) and that another tenant could inherit by claiming the name
    first. So the flag records the want, the switch provisions the slugs that
    exist, and `reconcileProjectDatabase` provisions the rest as their deploys
    claim them — hung off the ONE hook (`afterDeploy` on the session broker's
    single publisher) that both Publish and the auto preview pass through.
    The invariant: an app database exists only for a deployed, owned slug.
  - **It reaches an agent on that agent's next DEPLOY** — `DATABASE_URL` is
    read from the `app-db:` secret when a sandbox is BUILT, and deploy/delete
    are the only mutations that move sandboxes (the same trade secret changes
    make). So the switch force-redeploys the PREVIEW (clear `previewHash`,
    schedule — the `wakeProjectPreview` pattern), because that is the
    environment the user is looking at, while production waits for a Publish,
    which the card says out loud.
  - **An already-provisioned slug is never re-provisioned**: `provision`
    rotates the role's password on every call, so re-running it would
    invalidate the `DATABASE_URL` a live sandbox is holding.
  - **Each row reports what its schema HOLDS** — tables, rows, bytes, read
    live per environment (`appDatabaseUsage` → `storageUsage` → the state's
    `usage`). "Ready" answers whether the switch took effect and is not the
    question anyone has: the one worth answering is whether a tool is really
    saving anything, which is invisible until you can see a row count move.
    Hence the **Refresh counts** button — the numbers are as old as the
    card's last fetch, which is stale exactly when it matters. Three
    distinctions the copy holds: an enabled schema with no tables reads
    "no tables yet" rather than "Ready"; a measurement that FAILED leaves
    `usage` absent and falls back to "Ready", because reporting 0 rows for a
    schema nobody could read is the precise lie this exists to catch; and the
    counts are exact `count(*)`, never `reltuples` (the planner's estimate is
    `-1` before the first ANALYZE and stale after every write, so it reads
    zero for the row you just wrote).
  - Ownership of each slug is checked against the agents row's credential
    hashes (`verifySlugOwner`), exactly as the project-delete cascade does —
    a workspace naming a foreign slug must not become a lever on, or an
    oracle for, someone else's agent.
- **The Phone number card hands out the carrier webhook URLs**
  (`phone-card.tsx`) — one per carrier, each with a copy button, pointing at
  the platform's `/:slug/phone` route (see "Telephony" in
  `packages/aai-server/CLAUDE.md`). Pasting one into a phone number's voice
  webhook is the whole integration on the user's side, and the URL is not
  derivable by hand: it needs the platform origin, the project's PUBLISHED
  slug rather than its name, and the `?carrier=` value.
  - **`?carrier=` is spelled out even for Twilio**, which the platform already
    defaults to. This string is pasted into a carrier console once and never
    looked at again, so it has to keep meaning the same thing — the default is
    a decision the platform is free to revisit, and the copies already sitting
    in people's phone-number settings are not.
  - **It GATES on `deployedSlug`, unlike every other card on this pane.** The
    others record an intent a later deploy picks up, which is why they are
    ungated; a webhook URL is not an intent. Pointed at an unpublished slug it
    resolves to nothing and the caller hears the agent-not-found message and
    is hung up on — a dead URL is a worse answer than "publish first".
  - **Each carrier names its signing secret and says whether it is LIVE**,
    read off the Secrets card's own two lists (`secretState`). The three-way
    split is the point: a `pending` secret is visible in the list above but
    has not reached the published agent, so verification is not running, and
    reporting it as set would tell someone their webhook is protected while it
    still accepts anything. The missing case names where to find the value
    (Twilio Console → Auth Token; Telnyx Portal → Public Key) rather than just
    the variable, because a variable name alone is not an instruction.
  - The origin comes from `window.location.origin` rather than the server: the
    studio and the agent surface are one origin by construction (see "One
    public origin" in `packages/aai-server/CLAUDE.md`).
  - Clipboard handling is shared with the CLI commands (`use-copy.ts`) — the
    flash is keyed by the copied TEXT so one row's "Copied" does not light up
    every button, and there is one live timer so a second click cannot have
    its flash cleared early by the first click's timeout.

- **The Settings pane is also where the CLI round-trip is discoverable**
  (`cli-commands.tsx`, the "Work locally" section): the install / `aai login`
  / `aai pull <project>` / `aai dev` sequence with the project name filled
  in and one copy button each. It renders whether or not the project has
  ever been published — pulling a workspace needs no deployed slug. The
  commands carry **no `--server`**: the CLI targets its own shipped default
  origin (`DEFAULT_SERVER` in `aai-cli/_agent.ts`), which is the platform
  the commands were copied from. A studio served from anywhere else (local
  dev, a preview deploy) needs the flag added by hand — passing it is also
  what APPROVES a non-default origin for credentialed requests
  (`resolveServerUrl`), and the client cannot compare its own origin
  against the CLI's default without importing from aai-cli, which would
  widen the package boundary.
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

- **A gate screen never sits on an unexplained wait** (`gate-card.tsx`, the
  pre-app cards in `main.tsx` and the `unavailable` phase in `auth.tsx`). A
  gate has no app behind it to degrade into — it either resolves or it IS the
  page — so "Loading…" must always end somewhere the user can act. Two
  mechanisms, and both are needed:
  - **The two reads that gate the app carry per-attempt deadlines**
    (`ACCOUNT_ATTEMPT_TIMEOUT_MS`, `AUTH_CONFIG_ATTEMPT_TIMEOUT_MS` — the same
    hazard `CHAT_SESSION_ATTEMPT_TIMEOUT_MS` covers for the broker). A request
    issued while the server is restarting or saturated can HANG rather than
    fail, and a browser fetch has no timeout of its own, so the studio sat on
    "Loading…" (or, for the auth config, a BLANK page) indefinitely. The
    deadline is also what makes a retry button possible rather than merely
    faster: TanStack Query folds a `refetch` into the in-flight promise, so
    while the fetch never settles there is nothing a button can start.
  - **The card appears after ONE failed attempt, not when the query gives
    up** (`gateProblem`). A failure mid-retry lives in `failureReason` and
    leaves `error` NULL, so a gate reading `error` alone shows the same
    "Loading…" through the whole backoff. The automatic retries keep running
    behind the card, so whichever lands first — a retry or the user's click —
    opens the app; while one is in flight the button says "Retrying…" and is
    disabled, because a press then would fold into it and appear to do
    nothing.

  Wording splits on `isTransientError` (`loadFailureText`): a 5xx, a rejected
  fetch, or a timed-out attempt says nothing about this user, so it reads as
  "AssemblyAI Build is busy right now" with the server's own answer quoted
  only when it gave one (a timeout's "signal timed out" reads as a bug in the
  page). Anything else will refuse again, so it is quoted verbatim — that text
  is what distinguishes a rejected key from a missing account. A failure with
  no retry at all is deliberate in exactly one case: a server that answers
  "sign-in is not configured here" will answer that again.

- **The pane probes before it frames** (`useAgentPageReady` in
  `preview.tsx`): a stamped `previewSlug` is not proof the platform serves
  `/:slug/`. The stamp outlives the deploy behind it (the swept-agent case the
  wake path regenerates — see `packages/aai-studio-server/CLAUDE.md`) and a
  first or repeat deploy takes
  seconds to land, and `GET /:slug/` answers a slug with no agents row with
  a bare `{"error":"HTML not found"}` — which rendered as the ENTIRE pane,
  reading as a broken studio rather than a preview on its way. So the pane
  asks the unauthenticated agent health route (existence only — a booting
  sandbox is the framed page's own business, its client re-brokers) and
  keeps its own "Starting your preview" screen up until the page is really
  there, re-probing every few seconds. **The probe carries its own deadline**
  (`AGENT_PAGE_PROBE_TIMEOUT_MS`), for the same reason the gate reads do and
  with a failure mode they don't have: the loop re-arms its timer from the
  *settled* promise, so a request that hangs rather than fails doesn't miss
  one tick — it ends the polling for good, and the pane sits on "Starting
  your preview" forever even after the preview deployed. It is short (5s)
  because nobody waits on a liveness probe: a timeout already means "not
  ready yet", which is the path that re-arms. Readiness is LATCHED per slug:
  nothing re-probes a page that answered once, because dropping back to the
  placeholder would unmount the iframe and kill any voice session inside it
  — a new deploy still reaches the frame through the `previewVersion` key.
  The first probe renders as an empty pane rather than the screen, so an
  already-deployed preview doesn't flash "starting" on every open.

  **A BUILD IN FLIGHT takes the whole pane, first build and rebuild alike**
  (`building` in `preview.tsx` — `previewStale && hasAgent && !previewError`).
  A rebuild used to leave the previous preview framed under a one-line
  "Updating preview…" banner, which is a page that does not match the code
  with a banner over it saying so; that row is gone and the "Starting your
  preview" screen answers both cases. It costs nothing to unmount the frame:
  the landing deploy remounts it through the `previewVersion` key anyway, so
  no voice session survives a rebuild either way. Two conditions carry the
  distinctions the flag alone would get wrong. `hasAgent` (the workspace has
  an `agent.ts`) is needed because "no preview yet" IS stale server-side, so
  an untouched project would otherwise claim a build was on its way instead
  of "Nothing to preview yet". And `previewError` EXCLUDES a failed build:
  `previewStale` stays true after one — the files still differ from the last
  good deploy — so treating it as in-flight parks the pane on "Starting your
  preview" permanently, and that case keeps the last good preview framed
  under the error banner, which is what the banner's own copy promises.

  **The failed build is the ONLY banner left** (`PaneBanner`). It also carried
  a publish nudge — "This preview updates automatically as you edit. Hit
  Publish…" with its own Publish button — shown whenever `unpublished` was
  true, which is nearly every project nearly all of the time. Permanent
  furniture that restates the pane's own name, above a Publish control already
  in the top bar two inches away, and it cost a strip of the preview on every
  render. The workspace payload still reports `unpublished`; nothing in the
  client reads it. A failed build stays because it is the one state the pane
  cannot show by itself — the frame below it is a page that does NOT match the
  code, and the banner is what says so.

  **Polling is not a recovery, and treating it as one stranded the pane for
  fifty minutes.** The server's fix for a swept preview (`wakeProjectPreview`)
  is hung off OPENING the project, which a tab that is already open never does
  again — so the loop ran against a slug nothing was going to redeploy until
  the user happened to broker a session: **1,061 probes across 50 minutes**,
  in production, all of them 404, with the recovery sitting right there and
  nothing able to reach it. The pane can see the condition the server would
  have to go looking for, so it reports it (`api.wakePreview` →
  `POST /studio/projects/:project/preview/wake`; the server still re-checks
  before scheduling anything, so the pane is a trigger and not evidence).
  It reports after `PROBE_FAILURES_BEFORE_WAKE` failures and then **once**,
  because the wake enqueues a durable job whose queue owns the retries — but
  it latches on DELIVERY rather than on the attempt, so a single dropped
  request cannot re-strand the pane the same way. The cadence is two-speed
  (`PROBE_SLOW_AFTER`, `PROBE_SLOW_RETRY_MS`): 3s exists for a deploy landing
  in the next few seconds and only has to outlast that, after which the pane
  is waiting on the wake rather than on a deploy and 20 requests a minute
  buys nothing. Two speeds and NOT exponential backoff — exponential reaches
  a sane ceiling by way of delays worse than 3s exactly where promptness
  matters (a preview landing at 25s noticed at 45s), trading the common case
  for the pathological one.

- **The transcript does not wait on the sandbox** (`chat.tsx` — the three
  states of `ChatPanel`, and `PendingChat` in particular). Opening a project
  fires two requests together, and they are not remotely the same request: the
  history is a row read, while the session broker has to boot a container. The
  panel used to render neither until BOTH had landed, so a project whose entire
  conversation was already in hand showed a one-line "Starting sandbox…" for
  seconds. It now renders the history the moment it arrives and puts the wait
  where the next message would go, as the last thing in the scroll region —
  `SandboxNote`, which the composer is visibly gated on.
  - **The composer is TYPABLE through the wait, only unable to send**
    (`sendDisabled` on `Composer`, distinct from `disabled`). A dead field for
    those seconds is the swallow-what-you-typed bug the follow-up queue exists
    to fix, one step earlier — and an early Enter must not clear the field
    either, since the text is the thing being held back. `disabled` stays for
    the case with nothing to wait out (the LLM being unreachable).
  - **The composer's text is owned by `ChatPanel`, not `ProjectChat`.** That
    is what makes the wait cost nothing: `ProjectChat` mounts LATE — it cannot
    exist before the brokered URL, and `useChat` seeds its messages once at
    mount — so state held inside it would be born empty and take anything
    typed against the pre-sandbox composer down with the swap.
  - **A FAILED broker keeps the history up too**, with the same note carrying
    the reason and the Try again button. It used to replace the whole panel,
    which threw away the one thing that had successfully loaded. The only
    state with no transcript to hold is a history request still in flight, and
    that one still says "Loading conversation…" rather than claiming an empty
    conversation.
  - Both the pre-sandbox view and the live chat render through one
    `Transcript` (`chat-transcript.tsx`) with `lead`/`footer` slots. Two
    hand-matched copies would shift the messages under the reader at the exact
    moment the live chat takes over.

- **The chat transport is aimed at the CURRENT sandbox lease, per request**
  (`sandbox-transport.ts`). A brokered session is a lease on a guest sandbox
  that is idle-evicted after `STUDIO_SESSION_IDLE_MS`, so a tab left open holds
  a URL and a token for a process that no longer exists.
  `DefaultChatTransport` captures its `api` and `headers` at construction and
  `useChat` needs ONE transport for the life of the conversation, so a
  transport built from the lease that existed at mount could only ever talk to
  that one sandbox: the re-broker landed in the query cache and the chat went
  on posting to the dead origin. **That is what made "Failed to fetch" a
  RELOAD-only failure** — the first message after a spin-down failed, and so
  did every retype, because nothing in the tab could re-aim itself. The wrapper
  builds the real transport per request from the lease the app holds now.
  - **The retry lives with the TURN, not the request** — the replacement
    sandbox answers on a different origin with a different token, so nothing
    inside one fetch can re-aim itself. `resilient-fetch.ts` therefore only
    NAMES the failure (`StaleSandboxError`, thrown for the three signals it
    already classified) and the transport re-sends the turn once on the fresh
    lease. Retrying is safe because of what that error means: the guest either
    never received the request or refused it before the turn began, so nothing
    ran and nothing is duplicated. A 423 (another tab holds the turn) is
    deliberately NOT in that class.
  - **The re-broker reports the lease; the transport never re-reads it.** The
    broker's query settles before React has re-rendered with the new prop, so
    a re-read of the render-time value sees the dead lease and gives up on a
    sandbox that is right there. `onSessionStale` (app.tsx) therefore resolves
    with what it read out of the query CACHE.
  - **The wait says what it is waiting on.** A mid-turn re-broker is a
    container boot, so the footer shows "Restarting the sandbox…" rather than
    "Working…" — reporting the agent as busy while nothing runs is the same
    unexplained wait `SandboxNote` exists to avoid on the way in. A retry with
    no replacement to aim at (the broker gave up) fails the turn with the
    error's own sentence, not the browser's "Failed to fetch".
- **The composer QUEUES follow-ups typed mid-turn**
  (`aai-studio-client/src/chat-queue.ts`), Claude-Code style: the input stays
  live while the agent works, Enter parks the message in a visible, dismissable
  row above the composer, and it is sent when the turn settles — one turn at a
  time, FIFO. It used to be disabled, which silently swallowed anything typed
  mid-turn.

  **The AI SDK has no queue of its own**, and this is not an oversight to work
  around at the call site: `sendMessage` goes straight to `makeRequest`, which
  resets the chat status and overwrites the live `activeResponse` (its
  `SerialJobExecutor` serializes stream-update jobs, not requests), so a second
  send while a turn is open runs two turns against one guest session and
  interleaves their end-of-turn workspace syncs. `sendAutomaticallyWhen` is the
  nearest native hook but only re-sends the EXISTING message list, and
  appending a user message mid-stream corrupts the transcript (the SDK's
  `write` compares its streaming message against `lastMessage`, so a message
  pushed underneath it gets pushed a second time). Hence a queue held OUTSIDE
  `messages`, flushed on the settle.

  Three rules the reducer exists to hold, each covering a bug that is invisible
  without it: the flush is **latched** from dispatch until the turn is observed
  (`sendMessage` awaits before flipping the status, so a re-render in that
  window sees `ready` with the next item at the head and would start a
  concurrent turn — the same window makes a submit queue and keeps Publish
  locked, which is why `hasPendingWork` is one predicate serving both); a
  **Stop hands the queue back to the composer** rather than firing or dropping
  it (`drainText` — an explicit interrupt must not start the next turn behind
  the user's back, and the composer is a textarea partly so it can hold what
  comes back); and a **failed turn drains the same way**, because an `error`
  status never flushes while every submit joins a non-empty queue — parking it
  there wedges the composer permanently.

- **Requests are deadlined; the SSE streams deliberately are NOT.** Every
  one-shot request that a screen waits on carries `AbortSignal.timeout` (the
  gate reads above, the broker call, the preview probe), because a browser
  fetch has none of its own and a hung request is not a failure — it never
  settles, so no error path, retry, or backoff ever runs. `watchEventStream`
  (`api-events.ts`) is the one place that must not have one: a healthy
  stream IS a request that stays open indefinitely and says nothing for
  minutes, so no duration separates it from a hung one. Its liveness comes
  from the other end — the server pings, a dead connection surfaces as the
  read ending, and that reaches `onDown` → backoff resubscribe.
- **The SSE backoff resets on a stream that SERVED, not one that opened**
  (`EVENTS_MIN_UPTIME_MS` in `use-event-stream.ts`). Accepting a request is
  not the same as serving it: a server that answers `200` and then ends the
  body immediately — a crash-looping container, a Modal instance being
  replaced mid-rollout, a proxy that upgrades and drops — has "opened" the
  stream by every test the hook can apply, so resetting on `onOpen` reset the
  counter on EVERY attempt and the backoff never grew. Driven against a
  server in exactly that state: a flat attempt **every 3.0s indefinitely**,
  versus the correct 3s/6s/12s when the same server refused outright. Two
  subscriptions per tab makes that ~40 requests a minute, forever, aimed at a
  server already unhealthy enough to be dropping streams — the transport-side
  twin of the 401 storm the module header describes. A stream that stayed up
  10s still resets, so the promptness the reset exists for is intact.

## Surviving a platform deploy (`stale-build.ts`)

A chunk URL is only valid while the container image holding it is running,
and a Modal deploy replaces that image. The client's assets are
content-hashed and served `Cache-Control: immutable`, so **a tab open across
a deploy is holding names the new containers 404** — with no race and no
expiry to wait out. `CodeView` is lazily imported (CodeMirror is the bulk of
the bundle), so nothing surfaces it until the user clicks the Code tab, which
may be hours later. Untreated, React's `lazy` throws into a tree with no
boundary and the whole studio unmounts to a blank page.

Two other properties make this bigger than one lazy chunk, and neither is
fixable from the client:

- Modal's default deploy strategy is **rolling** — old containers keep
  serving beside new ones (up to `scaledown_window`, 300s) and every request
  is load-balanced independently, so a shell fetched from one build can have
  its assets answered by the other.
- **This package ships only as a side effect of a SERVER release.** Its
  `dist/` is baked into the one Modal app's image (`aai-server-web`, running
  `AAI_SERVICE=combined`), and `.github/workflows/deploy.yml` fires on a
  version bump to `aai-server` **or** `aai-studio-server` — never on this
  package's own version. So a studio-client change needs a changeset naming
  one of those two, or it ships to nothing.

The fix is in two halves, and the client half is deliberately just "reload":

- **The shell is `no-store`** (`aai-studio-server/studio-static.ts`). It is
  the one response that must never outlive the build it names; cached, it
  pins a browser to a build whose assets are gone, and the entry script 404s
  with no JS left to recover from it. It previously carried no cache headers
  at all, which is not the same thing — with no validator, a heuristically
  caching intermediary is free to reuse it.
- **`lazyRetry` + `installStaleBuildRecovery`** wrap the two ways a missing
  chunk reports itself: a rejected dynamic import, and Vite's cancelable
  `vite:preloadError` for a `<link rel="modulepreload">` that failed before
  any import ran (unclaimed, Vite rethrows it). Both retry once — a dropped
  connection is not a deploy — then reload, which picks up the current shell
  and with it the current chunk names.

**The reload is guarded, and that is the load-bearing part.** A chunk can
also fail for reasons a reload cannot fix (offline, a proxy, a genuinely
broken deploy), and unguarded reload-on-failure is a loop that never renders
long enough to say what went wrong. The marker lives in `sessionStorage`:
per-tab, so one tab's recovery does not suppress another's, and gone when the
tab closes, so a stale marker cannot disarm recovery weeks later. No store
means no guard, so `reloadForStaleBuild` **declines** rather than reload
unguarded — and on a triggered reload `lazyRetry` returns a promise that never
settles, because the document is already being replaced and settling would
flash a failure state over it.
