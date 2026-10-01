---
summary: >-
  The studio's panes: the switcher order and the UI tab's id, Settings, Secrets,
  the Phone card, Workflows, Logs, the Code pane's drafts, the UI preview's
  probe and wake, and the chat panel's pre-sandbox states
read_when: >-
  adding, reordering or changing a pane in `aai-studio-client/src/panes/`, or a
  card one of them renders.
---

# `src/panes/` — the studio's panes

Package-wide rules (layout, CSP, auth, request deadlines, the chat transport and
queue) are in `../../CLAUDE.md`; the API pane and the public docs page are in
`../../API-DOCS-CLAUDE.md`.

## The switcher

- **Order: UI, API, Workflows, then Code, Logs, Secrets, Settings** — the
  running agent first, then the workspace (`TABS` / `StudioTab` in
  `top-bar.tsx` is the one union; `project-view.tsx`'s `selectedTab` the only
  selection). UI leads and API sits beside it: one question, asked of a person
  and of a caller. Secrets precedes Settings because Settings ends in Delete
  project. The order is a product decision nothing else holds, so one test in
  `top-bar.test.tsx` pins the rendered sequence.
- **No pane is gated.** If a gate ever returns: ONE exported predicate shared by
  the switcher and `project-view.tsx` (they must not disagree — a tab bar with
  no `aria-current` beside a blank pane), the fallback derived during render
  rather than corrected by an effect, and the switcher's borders indexing the
  VISIBLE list.
- **The UI tab's id is `preview` and its label is "UI".** The id is the
  platform's word (the PREVIEW agent, `previewSlug`, `previewVersion`,
  `previewStale`); only the label moves, and `top-bar.test.tsx` pins label
  against id.
- **A relabel must update the coding agent's preamble too**
  (`aai-studio-server/src/prompts/studio-preamble.ts`, `studio-preamble-mode.ts`
  say "UI pane"). It lives in another package and no test reads it.
- **Anything that POINTS at a pane names the pane, never a direction or a path
  inside another pane** ("the Secrets pane", not "Secrets below" or
  "Settings → Secrets") — sections move.

## Settings (`settings.tsx`)

A full-width pane like every other. **Nothing on it gates on a build or a
deploy**: Delete project must work before anything is published, so
`SettingsPane` takes no slug and makes no request of its own —
`settings.test.tsx` asserts it never touches `/secret`.

- **Sections in a FIXED order: Sync to GitHub, Danger zone.**
  `settings.test.tsx` asserts the card-title sequence; read titles through
  `.eyebrow`, since a blurb repeating a title word matches `getByText` too.
- **The studio shows NO `aai pull` commands.** GitHub sync
  (`components/github-card.tsx`) is the one way out of the studio the product
  points at; `settings.test.tsx` asserts no `aai pull` renders. The CLI's `pull`
  and its server routes are untouched. Commands, if reintroduced, carry no
  `--server`: the CLI targets its own `DEFAULT_SERVER` (`aai-cli/_agent.ts`),
  and comparing against it would mean importing aai-cli.
- **A future project-level switch**: put the intent on the WORKSPACE and act on
  the SLUG — a switch is reachable before either agent exists, and acting
  against an unclaimed slug creates a resource no cleanup path sees
  (orphan-preview sweep and `deleteAgentResources` key off an agents row) that
  another tenant could inherit. A change only a sandbox BUILD reads must bump
  the slug's agents row (`AgentRows.touch`), or the running guest keeps its old
  environment. `secretsDeployHook` (`studio-deploy-hooks.ts`) is the pattern.

## Secrets (`secrets.tsx`)

Talks to `/studio/projects/:project/secret`, reports its own outcome and writes
nothing into the conversation. A database is configured here like any other
secret (`DATABASE_URL` at the author's own provider): the platform provisions
no tenant database.

- **Two forms, one endpoint.** A NAME/VALUE pair is the primary path (value in
  `type="password"`, name checked against `VALID_NAME` locally); the `.env`
  textarea is the bulk path and keeps the dotenv parse that makes quoted
  multi-line values (PEM keys, service-account JSON) work. Two `useMutation`s
  over one PUT, so `isPending`/`error` sit beside the button that fired them;
  each form clears only on its OWN success.
- **Deleting asks first** — the value cannot be read back.
- **UNGATED — no publish first.** An agent needs its key to run, and the
  preview (auto-deployed on first edit) needs it before production. The server
  holds the project's copy and reconciles it into each slug as a deploy claims
  one (`aai-studio-server/src/studio-secrets.ts`). A name no deployed agent
  carries yet is labelled **"on next deploy"** (the response's `pending` list)
  against **"live"**.
- **`ASSEMBLYAI_API_KEY` is platform-managed: the pane neither lists, deletes,
  nor sets it** (`PLATFORM_MANAGED_SECRETS`). It is seeded at publish from the
  caller's account key and deleting it takes the agent off the air. Setting it
  is refused by name in BOTH forms (a save that vanished from the list reads as
  a failed write). Overriding it stays a CLI action (`aai secret`, or `.env` +
  `aai publish`).

## The Phone card (`components/phone-card.tsx`, on the API pane)

Hands out one carrier webhook URL per carrier, each with a copy button, at the
platform's `/:slug/phone` route ("Telephony" in `packages/aai-server/CLAUDE.md`).
The URL needs the platform origin, the PUBLISHED slug and `?carrier=`.

- **`?carrier=` is spelled out even for Twilio** (the platform's default): the
  string is pasted into a carrier console once and must keep its meaning.
- **It GATES on `deployedSlug`.** A webhook URL is not an intent a later deploy
  picks up; pointed at an unpublished slug it hangs up on the caller.
- **Each carrier names its signing secret and whether it is LIVE**, from the
  Secrets pane's own lists (`secretState`, the shared secrets query key). A
  `pending` secret has not reached the agent, so verification is not running;
  the missing case names where to find the value (Twilio Console → Auth Token;
  Telnyx Portal → Public Key).
- The origin is `window.location.origin`: studio and agent surface are one
  origin ("Origin and CORS" in `packages/aai-studio-server/CLAUDE.md`).
- Clipboard flashes are keyed by the copied TEXT with one live timer
  (`useCopy`), so one row's "Copied" does not light every button.

## Workflows (`workflows.tsx` → `components/workflows-card.tsx`)

Reads the AGENT's own brokered API (`/:slug/workflows`), never a studio route —
the platform already brokers it and `connect-src 'self'` permits it. A run is
the one thing that outlives every other surface the studio shows.

- **Through the SDK's client** (`createWorkflowApiClient`,
  `@alexkroman1/aai/workflow-api`), passing `timeoutMs`. The agent's own
  `{ error }` sentence is what tells "the sandbox is booting" from "this slug is
  gone"; quote it.
- **Reading can BOOT the agent's sandbox** (brokering does) — accepted. Refresh
  is manual: a poll would hold a container open for a pane nobody watches.
- **It falls back to the PREVIEW slug and says so**; the query key is the SLUG,
  since preview and production keep separate runs.
- Only a LIVE run offers Stop; resuming a terminal one belongs to the Workflow
  DevKit.

## Logs (`logs-view.tsx` → `GET /:slug/logs`)

The platform route already owns the ownership check, so no studio proxy. It
polls by CURSOR and appends — the guest holds a bounded RING with a cursor.

- **`running` is read from the response, never from `lines.length`**: an empty
  page means either "up and silent" or "nothing running", which want opposite
  actions.
- **A gap is a ROW**: `dropped` counts lines the ring evicted before this pane
  read them.
- **It follows the bottom through `<AutoScroll>`** (`instant`/`instant`, since
  a spring never settles on a tail that appends every second). jsdom computes no
  layout, so the one test asserts the lines are mounted INSIDE that scroller (a
  plain `overflow-auto` div renders identically and follows nothing).
- **The footer says the log is not durable**: the ring goes with the sandbox
  ("Why the buffer lives in the guest" in
  `packages/aai-guest/src/harness/CLAUDE.md`).
- Preview is the default target; Production is a deliberate switch, each
  disabled until that environment has an agent.

## Code (`code-view.tsx`) — unsaved work lives ABOVE the editor

`FileBuffer` is mounted `key={currentFile}` under a `CodeView` the switcher
unmounts, so the buffers (`file-drafts.ts`) are held by `ProjectView`: both a
pane switch and a file switch are survivable, and `beforeunload` covers a reload
or a closed tab. A project switch is deliberately unguarded (the drafts belong
to that project).

- Not a confirm and not a hidden-but-mounted `CodeView`: a confirm still needs
  the flag to survive the unmount, and a mounted pane fixes the pane switch but
  not the file switch, and pins lazy CodeMirror into a `display: none` subtree.
- **The reconcile rule is a pure function** (`syncBuffers`): a clean buffer
  adopts the agent's edit; a dirty one keeps its text and raises `conflict`; a
  just-saved one keeps its draft until the refetch catches up (`lastServer`, not
  equality with `draft`, is what a change is measured against).

## UI preview (`preview.tsx`) — probe before framing

A stamped `previewSlug` is not proof the platform serves `/:slug/`: the stamp
outlives a swept deploy ("Waking a preview" in
`packages/aai-studio-server/src/CLAUDE.md`), a deploy takes seconds, and
`GET /:slug/` for a missing agent answers a bare `{"error":"HTML not found"}`.
`useAgentPageReady` probes the unauthenticated agent health route (existence
only) and keeps "Starting your preview" up until the page is there.

- **The probe carries its own deadline** (`AGENT_PAGE_PROBE_TIMEOUT_MS`, 5s).
  The loop re-arms from the SETTLED promise, so a hung probe would end polling
  for good.
- **Readiness is LATCHED per slug**: re-probing could unmount the iframe and
  kill a voice session; a new deploy reaches the frame via the `previewVersion`
  key. The first probe renders an empty pane, so a ready preview does not flash
  "starting".
- **A build in flight takes the whole pane** (`building` = `previewStale &&
hasAgent && !previewError`). `hasAgent` keeps an untouched project on
  "Nothing to preview yet" (no preview is stale server-side); `!previewError`
  keeps a failed build from parking the pane forever — that case frames the
  last good preview under the error banner.
- **The failed build is the ONLY banner** (`PaneBanner`): the one state the
  frame cannot show by itself. The workspace still reports `unpublished`;
  nothing here reads it.
- **Polling is not a recovery.** The server wakes a swept preview when a project
  is OPENED, which an open tab never does again. After
  `PROBE_FAILURES_BEFORE_WAKE` failures the pane calls `api.wakePreview`
  (`POST /studio/projects/:project/preview/wake`; the server re-checks, so the
  pane is a trigger, not evidence) **once**, latched on DELIVERY rather than on
  the attempt. Cadence is two-speed (`PROBE_SLOW_AFTER`,
  `PROBE_SLOW_RETRY_MS`): 3s for a deploy about to land, slower once waiting on
  the wake. Not exponential: it is slowest exactly where promptness matters.

## Chat (`chat.tsx`) — the transcript does not wait on the sandbox

Opening a project fires the history read and the session broker together; the
broker boots a container. `ChatPanel` renders the history as soon as it lands
and puts the wait where the next message would go (`SandboxNote`, last in the
scroll region).

- **The composer is TYPABLE through the wait, only unable to send**
  (`sendDisabled`, distinct from `disabled`); an early Enter must not clear the
  field. `disabled` is for nothing-to-wait-out (the LLM unreachable).
- **The composer's text is owned by `ChatPanel`, not `ProjectChat`.**
  `ProjectChat` mounts late (it needs the brokered URL; `useChat` seeds once at
  mount), so state inside it would drop what was typed before the swap.
- **A FAILED broker keeps the history up**, with the reason and Try again in the
  note. Only a history request still in flight says "Loading conversation…".
- Both views render through one `Transcript` (`components/chat-transcript.tsx`,
  `lead`/`footer` slots), so messages do not shift when the live chat takes
  over.
