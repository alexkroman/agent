---
summary: >-
  Studio front-end: layout and the frame, the project shell, CSP, sign-in and
  the session, gate screens, request deadlines and the SSE streams, the chat
  transport and follow-up queue, the aai-ui import rule, testing, and surviving
  a platform deploy
read_when: >-
  working on the studio's browser UI
---

# packages/aai-studio-client — studio front-end guide

The studio's React front-end (private package). The server it talks to over
HTTP/SSE is documented in `packages/aai-studio-server/CLAUDE.md`. Two more
guides cover the rest of this package:

- `src/panes/CLAUDE.md` (auto-loaded there) — the switcher and every pane:
  Settings, Secrets, Workflows, Logs, Code, the UI preview and the chat panel.
- `API-DOCS-CLAUDE.md` (read on demand) — the API pane, its generated snippets
  and form-field map, and the public `/studio/api/<slug>` page.

## Layout

Three directories: `panes/` (the eight modules `project-view.tsx` renders),
`components/`, `hooks/` (the `use-*` modules).

- **A PANE and a COMPONENT are different categories, and the roster says so.**
  konsistent's `studio-client-pane-modules` names the eight — `chat.tsx`,
  `preview.tsx`, `docs.tsx`, `workflows.tsx`, `code-view.tsx`, `logs-view.tsx`,
  `secrets.tsx`, `settings.tsx` — as what the switcher renders.
- **The FRAME stays at `src/` root**: it is what a pane is mounted BY. `app.tsx`
  (the root), `main.tsx` (the Vite entry), `project-view.tsx` (renders the
  eight), `top-bar.tsx` (the switcher), `pane-shell.tsx` (the shared shell) and
  `public-api.tsx` (a top-level ROUTE, never a tab). `auth.tsx`, `starters.ts`
  (an export subpath) and `_test-utils.ts` stay there too.
- **`studio-client-pane-export` names FIVE panes and that is not the roster.**
  Those five have a filename equal to their tab id, so they export `<Tab>Pane`;
  `code-view.tsx` (tab `code`) and `logs-view.tsx` (tab `logs`) are named for
  what they are, and `chat.tsx` sits outside the switcher.
- **On any file move, re-check `studio-client-cleanup-is-setup`.** It is keyed
  on `src/{suite}.test.tsx` and a konsistent `**` glob needs a subdirectory to
  match, so both spellings are listed; a spec moved into a directory neither
  names drops out of the rule while it keeps printing green. A/B a widening by
  adding the forbidden import and watching the rule fire.

## The app

A Vite-built React app (React 19 + Tailwind v4 + `useChat` + TanStack Query +
CodeMirror), built into its `dist/` by `pnpm --filter aai-studio-client build`.
It talks to the server purely over HTTP/SSE (no code imports either way).
`aai-studio-server/src/studio-static.ts` resolves the built `dist/` via
`require.resolve` (as aai-ui's `dist/default-client` is) and serves it at `/`
with hashed assets under `/studio-assets/`; unbuilt, `GET /` serves a fallback
page with build instructions (unit tests do not need it).

- **The pane roster is `studio-client-pane-modules` /
  `studio-client-pane-export` in `konsistent.json`, never a list in prose.**
  `top-bar.tsx`'s `StudioTab` union is the roster and `top-bar.test.tsx` pins
  the label each id renders under (**UI** for `preview`, **API** for `docs`).
  Page-shaped panes share `pane-shell.tsx`; only UI and Code have layouts of
  their own.
- **The shell splits on whether a project is open**, which is what makes
  `project` a `string` rather than `string | null` below it. `app.tsx` owns the
  account-scoped half — routing (`project-route.ts`), the project list, the home
  hero, the account menu; `project-view.tsx` owns everything that exists only
  while a project is open — its workspace, chat and sandbox queries, the panes,
  Publish, and the unsaved editor drafts. `ProjectView` is mounted
  `key={project}`, so per-project state resets on a switch with no effect.
- **The home hero's Voice agent / Workflow switch is the ONLY place a project's
  `kind` is set** (`components/home.tsx`, `starters.ts`, `api.createProject`).
  It is sent as `kind` on `POST /studio/projects`, stamped on the workspace and
  read at every session install to pick the coding agent's system prompt ("A
  project has a KIND" in `packages/aai-studio-server/src/prompts/CLAUDE.md`).
  - Each position owns its copy (`KIND_COPY`) AND its starter list
    (`STARTERS[kind]`) — two lists, not one tagged list, so a workflow-mode pick
    never lands a voice template in a project whose prompt forbids one.
    `research-handoff-agent` stays under Voice agent: it is an `agent()` that
    hands off to a run.
  - Both catalogs are sampled once per MOUNT (`useState`), not per flip, or the
    chips read as unrelated to the position just chosen.
  - `creating` disables the switch (the kind is baked into the in-flight
    create); a still-loading `/studio/status` does not.
  - It is a `fieldset` of real radios with an `sr-only` legend, so arrow keys
    and the accessible name come from the markup.

## Every cross-origin the page dials must be in its `connect-src`

`studioCsp` in `studio-static.ts`. A missing origin is refused by the browser
before sending, so the client shows a bare **"Failed to fetch"** and the server
logs NOTHING. There are exactly two:

1. the project's guest sandbox (chat + tool labels), keyed by sandbox backend so
   a production policy never trusts loopback;
2. the Supabase project — the provider read (`auth-methods.ts`), password
   sign-in, the session restore and the OAuth code exchange. GitHub itself is
   top-level navigation, which `connect-src` does not govern.

Both are derived from what the server hands the client (`chatUrlForGuest`'s
shape, the auth binding's `clientConfig`), never hand-copied, and both are exact
— `https://*.supabase.co` would trust every Supabase project. The sign-in case
hides best: the page and `GET /studio/auth` load (`'self'`), and only the button
fails.

## Sign-in and the session

**The sign-in screen offers what the BACKEND has, read from GoTrue**
(`auth-methods.ts` → `GET /auth/v1/settings`; `SignInGate` renders it), so one
screen serves hosted GitHub OAuth and a local email+password stack with no
environment check — which is what makes a local dev server usable without an
OAuth app. Four rules:

- **An unknown answer falls back to GitHub-only, never to nothing**; assuming
  everything is on offers a button GoTrue refuses after a GitHub round trip.
- **A backend with NEITHER method renders as such**, not as dead controls.
- **"Create account" is its own action, never a fallback from a failed sign-in**
  — a mistyped password would silently become a new, empty account.
- **The email is trimmed and the password is not** (spaces are legal in it).

`readSignInMethods` lives outside `auth.tsx` so the coverage floors govern it:
the hook in `auth.tsx` (supabase-js, an auth subscription, an OAuth redirect) is
deliberately never LOADED by a test, and importing a value from `auth.tsx` in a
spec drops package coverage ~11 points.

**The session lives in `localStorage`, and the origin split is owed**
(`auth.tsx`, and the threat-model note in `main.tsx`). Tenant agent pages are
served from this same origin (`/:slug/`) with attacker-controlled JS that can
read that key — **moving them to a dedicated origin is a precondition of real
users.** Per-tab `sessionStorage` bought little: the Live pane iframes `/:slug/`
same-origin, which shares the tab's storage either way. The dev-token path uses
the same storage.

**A rejected bearer is REFRESHED, never signed out on** (`auth-recovery.ts`).
supabase-js refreshes only on FOCUSED tabs, so a background tab holds an
expired-but-refreshable token and its first refetches 401. There is one
`useAuthRecovery(authRejection(…), refreshAuth)`, and `refresh` alone decides
whether the session survives.

- **The recovery is CAPPED, and the cap is the terminal state**: against a
  server that 401s a refreshable token (another Supabase project, a JWT-secret
  mismatch, clock skew) an uncapped refresh loops. It is an effect (never a call
  in a render body), renders "Signing you back in…" while in flight, and past
  the cap signs out to the sign-in gate.
- **A refreshed bearer has to be pushed at the queries**: only the account's
  cache key carries a bearer, so `App` invalidates on a bearer change, excluding
  the chat session (its token comes from the broker).

## A gate screen never sits on an unexplained wait

`components/gate-card.tsx`, the pre-app cards in `main.tsx`, the `unavailable`
phase in `auth.tsx`. A gate has no app to degrade into, so "Loading…" must end
somewhere the user can act. Both mechanisms are needed:

- **The two gating reads carry per-attempt deadlines**
  (`ACCOUNT_ATTEMPT_TIMEOUT_MS`, `AUTH_CONFIG_ATTEMPT_TIMEOUT_MS`). A request to
  a restarting server can HANG, and TanStack Query folds a `refetch` into the
  in-flight promise, so without a deadline there is nothing a retry button can
  start.
- **The card appears after ONE failed attempt** (`gateProblem`): a mid-retry
  failure lives in `failureReason` with `error` NULL. Automatic retries keep
  running behind the card; while one is in flight the button reads "Retrying…"
  and is disabled.

Wording splits on `isTransientError` (`loadFailureText`): a 5xx, a rejected
fetch or a timeout reads as "AssemblyAI Build is busy right now", quoting the
server only when it answered; anything else is quoted verbatim. The one failure
with no retry is a server answering "sign-in is not configured here".

## Requests are deadlined BY DEFAULT; the SSE streams are NOT

A browser fetch has no timeout and a hung request never settles, so no error
path runs. The deadline lives in `fetchJson()` in `api.ts`
(`DEFAULT_REQUEST_TIMEOUT_MS`), which every request goes through; a call names
its own `timeoutMs` only when its work is slower
(`CHAT_SESSION_ATTEMPT_TIMEOUT_MS`) or its screen cannot wait (the gate reads,
the preview probe, `/studio/status` — which gates the home hero's Send and
`chatReady`). A caller's `signal` is COMPOSED with the deadline via
`AbortSignal.any`, so it can only settle a request sooner.

`watchEventStream` (`api-events.ts`) must not have a deadline: a healthy stream
stays open and silent for minutes. Liveness comes from the server's pings, and a
dead connection surfaces as the read ending → `onDown` → backoff resubscribe.

- **The FRAMING is the SDK's, the policy is ours.** Frames are read by
  `@alexkroman1/aai`'s event-stream reader (`sdk/event-stream.ts`); this package
  keeps only its policy (the `auth`/`transport` taxonomy, the abort handle,
  `onOpen`, the `ApiError` mapping). Frames arrive JSON-parsed and are narrowed
  by guards (`isProjectData`/`isChatMessages`/`isProjectNames` in
  `api-types.ts`, which argues what they check); a frame that fails a guard is
  DROPPED, not fatal, since every frame is a whole snapshot.
- **The SSE backoff resets on a stream that SERVED, not one that opened**
  (`EVENTS_MIN_UPTIME_MS` in `hooks/use-event-stream.ts`). A server that answers
  `200` and ends the body (a crash-looping container, a rollout, a dropping
  proxy) has "opened" by every test the hook can apply, so resetting on `onOpen`
  kept the backoff flat at 3s forever. A stream up 10s resets.

## The chat transport and the follow-up queue

**The chat transport is aimed at the CURRENT sandbox lease, per request**
(`sandbox-transport.ts`). A brokered session is a lease on a guest sandbox
idle-evicted after `STUDIO_SESSION_IDLE_MS`. `DefaultChatTransport` captures
`api`/`headers` at construction and `useChat` needs ONE transport per
conversation, so the wrapper builds the real transport per request from the
lease the app holds now — otherwise every message after a spin-down fails with
"Failed to fetch" until a reload.

- **The retry lives with the TURN, not the request** — the replacement sandbox
  has a different origin and token. `resilient-fetch.ts` only NAMES the failure
  (`StaleSandboxError`, for the three signals it classifies) and the transport
  re-sends the turn once on the fresh lease. Safe because the guest never
  received or refused the request before the turn began. A 423 (another tab
  holds the turn) is NOT in that class.
- **The re-broker reports the lease; the transport never re-reads it.** The
  broker query settles before React re-renders with the new prop, so
  `onSessionStale` (`app.tsx`) resolves with what it read from the query CACHE.
- **The wait says what it is waiting on**: "Restarting the sandbox…", not
  "Working…". A retry with no replacement (the broker gave up) fails the turn
  with the error's own sentence.

**The composer QUEUES follow-ups typed mid-turn** (`chat-queue.ts`): the input
stays live, Enter parks the message in a visible, dismissable row above the
composer, and it is sent when the turn settles — one turn at a time, FIFO.

- **The AI SDK has no queue of its own.** `sendMessage` goes straight to
  `makeRequest`, which overwrites the live `activeResponse`, so a second send
  mid-turn runs two turns against one guest session and interleaves their
  workspace syncs. `sendAutomaticallyWhen` only re-sends the existing list, and
  appending a user message mid-stream corrupts the transcript. Hence a queue
  held OUTSIDE `messages`, flushed on the settle.
- Three reducer rules: the flush is **latched** from dispatch until the turn is
  observed (`sendMessage` awaits before flipping status; the same window keeps
  Publish locked, so `hasPendingWork` serves both); a **Stop hands the queue
  back to the composer** (`drainText`), never firing or dropping it; a **failed
  turn drains the same way**, or an `error` status wedges the queue.

**No studio action writes into the transcript.** Publish, a secret save or
delete each report beside their own control (the PublishMenu renders
`publish.data.output` / `publish.error`; each Secrets form clears only on its
own success). The coding agent therefore cannot see a secret change or a failed
deploy, and the preamble says so
(`aai-studio-server/src/prompts/studio-preamble.ts` — the Secrets section and
the Publish bullet). If that ever has to change, add a "send this to the agent"
BUTTON, never an automatic injection — and wait for a settled turn: the SDK's
streaming writer (`ai@7`, `Chat.makeRequest`) compares
`response.state.message.id` with `this.lastMessage?.id` per chunk, so a message
appended UNDER a streaming assistant message makes the next chunk push that
assistant message a second time — one object at two indices, in the array the
end-of-turn sync PERSISTS.

## Reach for `aai-ui` when it carries a RULE, not a look

`@alexkroman1/aai-ui`'s components are driven by a theme OBJECT (`useTheme`,
`--aai-*` properties) because they ship into end-user agent apps; the studio is
a Tailwind app on its own tokens (`bg-panel`, `text-muted`, `border-line`,
`bg-indigo`). **A rule crosses; a look does not.** What crosses today:

- `Markdown` and `ToolCallRow` — a parse and a disclosure shape.
- `AutoScroll` (`components/chat-transcript.tsx`, `panes/logs-view.tsx`) — the
  one owner of stick-to-bottom, driven by a `ResizeObserver`. Do not depend on
  `use-stick-to-bottom` directly. It is unthemed (`className`,
  `contentClassName`, `scrollClassName`) and forwards `initial`/`resize`; both
  panes pass `scrollClassName="overflow-y-auto"` because the default hides the
  scrollbar.
- `useCopy` / `useFlash` (`components/phone-card.tsx`) — see "Forms" in
  `packages/aai-ui/src/components/CLAUDE.md`.

`aai-ui` may never import this package or anything platform-side
(`browser-package-boundary` in `konsistent.json`), so a shared primitive MOVES
down rather than being reached up for.

## Testing this package

- **node is the default and jsdom is a per-file pragma**
  (`// @vitest-environment jsdom` on line 1). Pure-logic suites (`file-drafts`,
  `chat-queue`, `stale-build`, `starters`, `project-route`, the `api` and
  `docs-*` reads) and `panes/chat.test.tsx` (markup via `react-dom/server`)
  carry none. Interaction behaviour — clicks, effects, timers, `beforeunload`,
  clipboard, fake-timer polls — belongs in a pragma'd file; a `.tsx` test
  missing the pragma fails loudly on `document is not defined`.
- **`src/_test-utils.ts` is the shared seam** (`studio-client-test-seam` in
  `konsistent.json`); a suite rebuilding one of its shapes is the half
  konsistent cannot see.
- **`afterEach(cleanup)` lives in `src/_test-setup.ts`**, never in a suite
  (`studio-client-cleanup-is-setup`). The setup raises Testing Library's async
  ceiling to 10s, which `vitest.config.ts` backs with `testTimeout` 20s.
- **Constants a test asserts a cadence against are IMPORTED, never mirrored**
  (`studio-client-probe-cadence` and `studio-client-probe-cadence-imported`, for
  `panes/preview.tsx`'s `PROBE_*` figures).

## Surviving a platform deploy (`stale-build.ts`)

Assets are content-hashed and served `Cache-Control: immutable`, and a Modal
deploy replaces the image holding them, so **a tab open across a deploy holds
chunk names the new containers 404**. `CodeView` is lazy (CodeMirror is the bulk
of the bundle), so this surfaces whenever the user next opens Code; an unhandled
`lazy` rejection unmounts the whole studio to a blank page.

- Modal deploys are **rolling**: old and new containers serve side by side (up
  to `scaledown_window`, 300s) and requests balance independently, so a shell
  from one build can have its assets answered by the other.
- **This package ships only as a side effect of a SERVER release.** Its `dist/`
  is baked into the one Modal app's image (`aai-server-web`,
  `AAI_SERVICE=combined`), and `.github/workflows/ship.yml` deploys on a version
  bump to `aai-server` **or** `aai-studio-server`. A studio-client change needs
  a changeset naming one of those two, or it ships to nothing —
  `guard-invariants` rule 20 (`SHIPS_VIA` in
  `scripts/guard-invariants-changesets.mjs`) enforces it.

The fix has two halves, and the client half is just "reload":

- **The shell is `no-store`** (`aai-studio-server/src/studio-static.ts`): it
  must never outlive the build it names. No cache header at all is not the same
  — a heuristic cache may reuse it.
- **`lazyRetry` + `installStaleBuildRecovery`** cover both ways a missing chunk
  reports itself: a rejected dynamic import, and Vite's cancelable
  `vite:preloadError` for a failed `<link rel="modulepreload">`. Both retry once
  (a dropped connection is not a deploy), then reload.

**The reload is guarded, and that is the load-bearing part.** A chunk can fail
for reasons a reload cannot fix (offline, a proxy, a broken deploy), and an
unguarded reload loops. The marker lives in `sessionStorage` — per-tab, and gone
when the tab closes. No store means no guard, so `reloadForStaleBuild`
**declines** rather than reload unguarded; on a triggered reload `lazyRetry`
returns a promise that never settles, since the document is being replaced.
