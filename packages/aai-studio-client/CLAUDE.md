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
- **Secrets have their own section; storage has none.** Deployed-agent
  secrets are managed in the Settings pane's Secrets card, which talks to
  the platform's own `/:slug/secret` routes — the exact ones `aai secret`
  uses — and posts a note into the chat on every change (key names only,
  values withheld) so the coding agent knows which keys exist.
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
  - Ownership of each slug is checked against the agents row's credential
    hashes (`verifySlugOwner`), exactly as the project-delete cascade does —
    a workspace naming a foreign slug must not become a lever on, or an
    oracle for, someone else's agent.
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
  there, re-probing every few seconds. Readiness is LATCHED per slug:
  nothing re-probes a page that answered once, because dropping back to the
  placeholder would unmount the iframe and kill any voice session inside it
  — a new deploy still reaches the frame through the `previewVersion` key.
  The first probe renders as an empty pane rather than the screen, so an
  already-deployed preview doesn't flash "starting" on every open.

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
