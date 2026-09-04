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
Panes: `chat.tsx` (chat + composer), plus the seven the top bar's segmented
control switches between. **Which modules those are is
`studio-client-pane-modules` and `studio-client-pane-export` in
`konsistent.json`, not a list here** — the list that used to be here named a
pane that had been deleted and omitted one that had been added, which is what
those two conventions exist to stop. `top-bar.tsx`'s `StudioTab` union is the
roster and `top-bar.test.tsx` pins the label each id renders under (**UI** for
`preview`, **API** for `docs`). The page-shaped panes share `pane-shell.tsx`;
only the UI and Code panes have layouts of their own. One page lives OUTSIDE
that shell — `public-api.tsx` at `/studio/api/<slug>`, which needs no session
and is chosen before the auth gate (see "The same documentation is served
PUBLICLY" below).

**The shell splits on whether a project is open**, and the split is what makes
`project` a `string` rather than a `string | null` everywhere below it.
`app.tsx` owns the account-scoped half — routing (`project-route.ts`), the
project list, the home hero, the account menu — and `project-view.tsx` owns
everything that only exists while a project is open: its workspace, chat and
sandbox queries, the panes, Publish, and the unsaved editor drafts. In
one component the six calls that take a project name all narrowed it with
`project as string`, a cast standing in for the `enabled:` flag two lines
above — an agreement nothing checks. `ProjectView` is mounted `key={project}`,
so every piece of per-project state resets on a switch with no effect to do it.

## Panes and behaviour

- **The home hero switches between the two things the platform builds**
  (`home.tsx` — Voice agent / Workflow, `starters.ts`, `api.createProject`).
  The position is not a display preference: it is sent as `kind` on
  `POST /studio/projects`, stamped on the workspace, and read back at every
  session install to pick the coding agent's system prompt (see "A project has
  a KIND" in `packages/aai-studio-server/CLAUDE.md`). So it is settable ONLY
  here — `app.tsx`'s create mutation is the one call that carries it, and
  nothing in the project view can change it afterwards.
  - **Each position owns its copy AND its starter catalog.** The heading,
    blurb and placeholder come from `KIND_COPY`, and the chips from
    `STARTERS[kind]` — two separate lists rather than one tagged list, because
    a workflow-mode pick must never land a voice template in a project whose
    prompt forbids writing one. The workflow catalog leads with
    `transcription-workflow` and `link-digest`, the two `workflowApp()` templates;
    `research-workflow` stays under Voice agent, since it is an `agent()` that
    hands off to a run.
  - **Both catalogs are sampled once per MOUNT, not per flip.** Re-sampling
    when the switcher moves reads as the chips being unrelated to the position
    just chosen, so `useState` holds one sample per kind for the page load.
  - **`creating` disables the switcher; a still-loading `/studio/status` does
    not.** The kind is baked into the create that is already in flight, so it
    must not move under it — but with nothing yet submittable, choosing what
    you are about to build costs the server nothing.
  - It is a `fieldset` of real radios with an `sr-only` legend, not a row of
    buttons with `aria-pressed`: arrow-key navigation and the group's
    accessible name then come from the markup, and the segmented look is
    entirely on the labels.
- **The switcher runs deployed-agent-first, then workspace**: API, UI,
  Workflows, Database, Code, Secrets, Settings (`StudioTab` in `top-bar.tsx`
  is the one union; `project-view.tsx`'s `selectedTab` state is the only
  selection).
  - **No pane is gated any more, and the gate that was here is worth knowing.**
    `isTabVisible` hid **Database** and **Workflows** behind one
    `ProjectData.databaseEnabled` flag: a database was an opt-in taken in
    Settings, and before it was taken the Database pane could only show an empty
    table list — a tab that answers no question reads as a broken feature rather
    than an unused one, and it drew "where is my data" from users who had never
    switched anything on.
    - **Workflows rode the same flag because a run was only DURABLE with a
      database behind it.** `configureWorkflowWorld` picked the Postgres world
      off the app's `DATABASE_URL`; with none the guest got the LOCAL world,
      whose queue is in memory and whose data directory is per-process under
      `tmpdir()`. A pane promising runs that "keep going after the call, the
      page, or the request that began them" would have been listing runs that
      die with the sandbox — worse than no tab, because it looks like the
      feature working.
    - **Both premises are gone**: there is no Database pane, and a durable run
      no longer needs the project to have a database, because the workflow world
      is the PLATFORM's and every agent reaches it over HTTP. So Workflows is
      unconditional and the flag, the predicate and the prop threaded to reach
      it are deleted rather than left always-true.
    - **The shape to copy if a gate returns**: ONE exported predicate, because
      the switcher (what to render) and `project-view.tsx` (what a selection of
      a now-hidden pane means) must not disagree — that disagreement is a tab
      bar with no `aria-current` beside a blank pane. Its fallback was
      **Settings**, not the default UI pane, because Settings held the switch
      that hid it; derived during render rather than corrected by an effect,
      since a selection of something that stopped existing is not a selection.
    - The switcher's left borders index the VISIBLE list, or a missing pane
      leaves a seam where it used to be.
  The first four are all about the agent that is RUNNING — talk to it, call
  it, watch what it is still doing, read what it stored — where Code, Secrets
  and Settings are about the workspace and the project. UI LEADS and API sits
  beside it: the two ask one question of a person and of a caller, so the
  client someone can actually use comes before the contract it exercises.
  Secrets sits before Settings because a key is what a WORKING project needs
  where Settings ends in Delete project. The order is a product decision
  nothing else here holds — the panes are peers, so a reshuffle of `TABS` is
  invisible to every other assertion in `top-bar.test.tsx`, which is why one
  test pins the rendered sequence.
  - **The UI tab's id is `preview` and its label is "UI".** The id names a
    platform concept the whole product spells that way (the auto-deployed
    PREVIEW agent, `previewSlug`, `previewVersion`, `previewStale`), so
    renaming the state to match a button would put a second word for one
    thing into the codebase. The LABEL is what has moved twice: "Preview"
    read as a rendering of the code rather than something to use, and
    "Playground" said what the pane was FOR without naming what it is — the
    client the project serves. `top-bar.test.tsx` pins the pairs, label
    against id, for exactly this reason.
  - **The coding agent's preamble says "UI pane" too**
    (`aai-studio-server/studio-preamble.ts`, `studio-preamble-mode.ts`). It
    told users to "try it in the Preview pane" through both label changes,
    naming a tab that has never existed under that name — the one copy in the
    product that a relabel here silently invalidates, because it lives in
    another package and no test reads it.
- **Settings is a PANE, not a dropdown** (`settings.tsx`): it renders
  full-width beside the chat panel like every other pane. It was
  a floating 384px panel that scrolled itself — three unrelated sections
  (secrets, the CLI round-trip, Delete project) never laid out in that
  width. Nothing on the pane gates on a build or a deploy: Delete project
  has to work before anything has ever been published, so Settings is
  reachable whenever a project is open.
- **The sections are in a FIXED order**: Work locally, Database, Danger zone
  — setting up first, destruction last. `settings.test.tsx` asserts the
  sequence of card titles, so moving one means updating that list — and
  re-reading any copy that names a neighbour's direction, which is the trap
  this used to carry: the Phone card said "Secrets **below**" twice while
  sitting above it, and then moved panes entirely.
  - **Three subjects LEFT this pane.** The carrier webhook URLs and the
    workflow runs are both about a DEPLOYED agent — how something calls it,
    and what it is still doing — which is the API and Workflows panes'
    subject rather than this one's. Secrets left for a different reason (see
    below). What that buys is that "nothing here gates on a deploy" is now
    literally true rather than nearly: every remaining card works from the
    moment a project exists, so `SettingsPane` takes no slug of any kind, and
    with the secrets query gone it makes no request of its own at all —
    `settings.test.tsx` asserts it never touches `/secret`, which is what
    would catch a copy of the card coming back.
- **Secrets are a PANE; storage has none.** `secrets.tsx` talks to the
  project route (`/studio/projects/:project/secret`) and, like every pane,
  reports its own outcome and writes NOTHING into the conversation — see "No
  studio action writes into the transcript" below.

  **It was a card in Settings, and what forced the move was its UI rather
  than its subject.** The whole control was one textarea of `KEY=value`
  lines: attaching a single key meant typing a shell assignment into a
  free-text box, the value sat in plaintext beside its own name, and an
  emptied box was the only report that anything had happened. Secrets are also
  the one piece of project configuration people come BACK to — a rotated key,
  a provider added weeks later — which sits badly on a page whose other half
  deletes the project.

  **Two forms, one endpoint, and the split is the design.** A NAME/VALUE pair
  is the primary path (the value in a `type="password"` field, the name
  checked against `VALID_NAME` here rather than by a round trip that answers
  "`my key` was never going to work"); the `.env` textarea stays for the bulk
  case and keeps the dotenv parse that makes quoted multi-line values — PEM
  keys, service-account JSON — work at all. They are two `useMutation`s over
  the same PUT, not one: `isPending` and `error` are read beside the button
  that fired them, so a shared mutation would put "Saving…" on the .env
  button while a one-key add was in flight and print a failed paste's error
  under both. Each form clears only on its OWN success — a draft is what the
  user would otherwise retype.

  **Deleting asks first.** A row's Delete used to fire on the click; the value
  cannot be read back, so an accidental one costs a trip to the provider to
  reissue the key.

  **The pane is UNGATED — no publish first.** It used to render "Publish the
  project first" until `deployedSlug` existed, which asks for the one order
  that cannot work: an agent needs its provider key to run at all, so the
  sequence was ship it broken, attach the key, ship again. And production is
  not even the environment that needs the key first — the preview agent is
  auto-deployed by the first edit and is the one the user is about to talk
  to. The server holds the project's own copy and reconciles it into each
  slug as a deploy claims one (`aai-studio-server/studio-secrets.ts`), so a
  save before anything is deployed is durable rather than a write reaching
  nobody. A name no deployed agent carries yet is labelled **"on next
  deploy"** from the response's `pending` list, against **"live"** for the
  rest — a bare list would report a saved-but-undelivered key as live
  everywhere.
  **`ASSEMBLYAI_API_KEY` is platform-managed and the pane neither lists,
  deletes, nor sets it** (`PLATFORM_MANAGED_SECRETS` in `secrets.tsx`): it
  is seeded at publish from the caller's own account key, so it is not a
  third-party key the user attached, and deleting it takes the agent off the
  air (an empty bearer → `unauthorized` from AssemblyAI) with nothing in the
  pane to put it back. Filtering it out of the list is also what withholds
  its Delete button — there is no row to hang one on. Setting it is refused
  by name rather than accepted, in BOTH forms: a save that then vanished from
  the list reads as a failed write. Overriding it with another account's key
  stays a CLI action (`aai secret`, or `.env` + `aai publish`), where it is
  deliberate.

  **Anything that POINTS here names the pane, never a path inside Settings.**
  The Phone card's signing-secret hints, the API pane's workflow-token line
  and the coding agent's preamble all said "Settings → Secrets", which is
  furniture that has moved twice now — the same failure as the Phone card's
  "Secrets **below**".
- **There is no Database card, and the settings pane is where that shows.** It
  switched `ctx.db` on per PROJECT across both environments, fronted a Database
  pane, and reported each schema's table/row/byte counts. The platform
  provisions no tenant database now — an author points a `DATABASE_URL` secret
  at their own provider — so the card, its pane, its routes and the per-slug
  `aai storage enable` primitive behind them are all gone, and a database is
  configured on the **Secrets** pane like anything else.
  - **The test consequence outlived the card**: its blurb contained the word
    "Database", so `getByText("Database")` in `settings.test.tsx` matched the
    title AND the blurb. The rule that came out of it stands for every card —
    read card titles through `.eyebrow`.
  - **Two arguments from it are worth keeping**, because the next project-level
    switch meets both. Intent belongs on the WORKSPACE while the action follows
    the SLUG: a switch is reachable before either agent exists (a project has a
    preview long before a publish), so acting against an unclaimed slug would
    create a resource no cleanup path can see — both the orphan-preview sweep
    and `deleteAgentResources` key off an agents row — and that another tenant
    could inherit by claiming the name. And a change only a sandbox BUILD reads
    has to bump the slug's agents row, or the running guest keeps the
    environment it was spawned with. `secretsDeployHook` is the surviving
    instance of the first (`studio-deploy-hooks.ts`); `AgentRows.touch` is the
    seam for the second, now with no caller.
- **The Phone number card hands out the carrier webhook URLs**
  (`phone-card.tsx`, rendered on the **API** pane) — one per carrier, each
  with a copy button, pointing at
  the platform's `/:slug/phone` route (see "Telephony" in
  `packages/aai-server/CLAUDE.md`). Pasting one into a phone number's voice
  webhook is the whole integration on the user's side, and the URL is not
  derivable by hand: it needs the platform origin, the project's PUBLISHED
  slug rather than its name, and the `?carrier=` value.
  - It sits with the API docs rather than in Settings because a webhook URL is
    how a CARRIER calls this agent, which is that pane's whole subject — it
    was the one card in Settings documenting a request instead of configuring
    the project. The signing-secret hints therefore point ACROSS to the
    **Secrets pane** rather than "below" — and name the pane rather than a
    path inside Settings, because a direction is copy that stops being true
    when a section moves, and this one has now moved twice.
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
    read off the same two lists the Secrets pane renders (`secretState`, over
    the shared secrets query key). The three-way split is the point: a
    `pending` secret is visible in that pane but
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

- **The Workflows PANE reads the AGENT's own brokered API, not a studio route**
  (`workflows.tsx` → the card in `workflows-card.tsx` → `/:slug/workflows`), and
  the pane is only OFFERED once the project has a database — see the switcher
  above. A
  workflow run is the one thing
  in this product that OUTLIVES every surface the studio already shows: the
  UI pane frames a page, the transcript shows a conversation, and a run
  started an hour ago by a caller who has since hung up appears in neither.
  That is also why it is a pane rather than the Settings card it began as: a
  live view of a RUNNING system does not belong behind a page about
  configuration.
  There is deliberately no studio endpoint in front of it — the platform already
  brokers that path for exactly this shape of caller and the studio shares the
  origin, so `connect-src 'self'` permits it; a second route would be a second
  thing to keep in step with the run shape.
  - **It reads it through the SDK's client** (`createWorkflowApiClient`,
    `@alexkroman1/aai/workflow-api`), not its own fetches. This card was one of
    three hand-written copies and the one that got the error handling wrong:
    it quoted the raw body, so the agent's own `{ error }` sentence — the whole
    difference between "the sandbox is booting" and "this slug is gone" — reached
    the card still wrapped in its JSON. What it passes that the others don't is
    `timeoutMs`, the deadline every studio fetch carries.
  - **Reading it can BOOT the agent's sandbox**, because brokering does. Accepted
    rather than overlooked: someone opening Settings to ask what their workflows
    are doing is asking a question only the agent can answer, and a card that
    shows nothing until you press a button answers it less often than it costs.
    The refresh is manual for the reason the Database card's was — a poll would
    hold a container open for a pane nobody is watching.
  - **It falls back to the PREVIEW slug and says so**, because that is the usual
    state: a project has a preview long before a first publish, and the two
    agents keep separate runs (which is also why the query key is the SLUG, not
    the project — otherwise a publish would show production's runs against the
    preview).
  - Only a LIVE run offers Stop. A terminal one is a dead end here on purpose:
    resuming it belongs to the Workflow DevKit, not to a button that would have
    to guess what "again" means. A failure quotes the agent's own sentence — a
    503 while a sandbox boots reads very differently from the 404 an agent that
    declares no workflows answers, and that text is the whole difference.

- **The API pane is GENERATED from the running agent, never written**
  (`docs.tsx` + `docs-content.ts` → `GET /:slug/workflows`). A deployed agent
  IS an API — `client-config` and a carrier webhook for a voice agent,
  `GET|POST|PUT|DELETE /workflows/*` for a workflow app — and that is
  simultaneously the most useful thing about the shape and the least
  discoverable: nothing in a framed page suggests the same work is three
  `curl` calls, that a run id is the entire handle (no session, no cookie), or
  that a result can be collected days later from another machine.
  - **The request bodies come from the agent's own input schemas.**
    `WorkflowSummary.inputSchema` is the same JSON a workflow app's page
    renders its form from, so `sampleInput` builds an example carrying THIS
    deployment's field names at the version that is deployed right now. A
    workflow that gains a field gains it here on the next read, which is the
    whole reason the pane can exist without somebody maintaining it. The
    property NAME is the placeholder (`"<topic>"`), because a generic
    `"string"` reads as a value somebody meant to keep.
  - **Each half is offered only to the agents it is TRUE for.** The pane used
    to show every card to every project, so a workflow app was told to paste a
    Twilio webhook into a carrier console and a voice agent got twelve workflow
    routes it had nothing to call them with. Both halves are now gated on what
    the agent ITSELF answers:
    - **No carrier webhook for a workflow app.** `page: "static"` declines
      `/websocket` with a reason and can declare no carrier (`AgentDef.page`),
      so a phone number pointed at one answers and hangs up — the worst kind of
      wrong documentation, since it is only wrong at the end of an afternoon in
      somebody's carrier console. `frontDoorEndpoints(page)` drops the
      `POST /phone` row and the Phone card goes with it; the page and its
      config stay, because they are how a caller discovers the shape at all.
    - **No workflow routes for an agent that declares no workflow.** This is a
      question about DECLARATIONS, not about routes: the platform proxies
      `/:slug/workflows/*` for every agent, so the table would be true for a
      voice agent and useless to it — `POST /workflows/runs` needs a `workflow`
      name and there is none to put there. What is left is the one sentence
      saying the project declares none, which is not a route table: this pane
      exists on the argument that the API surface is the least discoverable
      thing about a deployment, and "you could have workflows" is part of that
      surface.
    - **Neither gate DEFAULTS while the answer is outstanding.** Both reads are
      one-shot (`staleTime: Infinity`), and defaulting to the fuller shape
      would put the Phone card and the route tables on screen for a moment and
      then take them away on every open — which reads as a glitch, not as a
      judgement. The front-door card is held back until `client-config`
      answers; the workflow half shows one line (reading / could not read /
      declares none) until the listing does. A FAILED `client-config` does
      default to voice, since `page` is optional and absent has always read
      that way.
    - `docs.test.tsx` pins both, and each negative sits beside a positive:
      a `queryByText(…)).toBeNull()` pair passes just as well for a pane that
      renders nothing, so the voice-agent test asserting all of it is what
      makes the absences a decision rather than a bug.
  - **Whether the agent is a voice session or a page is asked of the AGENT**
    (`GET /:slug/client-config`), never read off the project's stored `kind`.
    That field selects the coding agent's system prompt and is explicitly a
    default rather than a cage — a project can be told to change shape
    mid-conversation and nothing rewrites the stamp — so it can disagree with
    what is deployed. `client-config` cannot: it is the same route a browser
    client reads before it dials.
  - **Whether a snippet carries `Authorization` is read off the project's
    secrets**, not left in prose as a caveat: the workflow API is open unless
    the agent's env sets `AAI_WORKFLOW_API_TOKEN`, and the pane shares the
    Secrets pane's own query key to find out.
  - **The endpoint tables cannot import `GUEST_ROUTE_EXPOSURE`** — this
    package may not depend on server code — so the tie to what the platform
    really proxies is the shared `WORKFLOW_API_PREFIX` constant plus
    aai-server's own parity test. `docs-content.test.ts` asserts all four
    methods are documented, because a table listing only GET and POST would
    hide exactly the bug that table exists to catch.
  - **Every example DEFAULTS to the aai SDK, and `curl` is a disclosure**
    (`docs-snippets.ts`, and the `Examples` component in `docs-examples.tsx`,
    shared by the pane and the upload card). The
    pane used to lead with `curl` in every section, which teaches the HTTP shape
    and leaves the reader to re-derive everything the client they already have
    knows: that `startAndWait` is ONE held-open request rather than a poll loop,
    that an `idle` frame on the event stream means re-open rather than "the run
    ended", that a progress read is bounded by the tail so a live run's next read
    must resume from an absolute index, and that an upload's bytes go in once and
    the run carries the id. A reader who pastes the shell version writes a worse
    client than the one in their dependencies. So each section shows the SDK call
    and puts `curl` and `aai workflow` behind a `<summary>` — a `<details>` rather
    than a language switcher, because they answer "I am not in TypeScript" rather
    than a preference worth remembering, and both stay in the DOM so a reader
    searching the page for `curl` still finds it.
    - **The route rows name their SDK call too** (`DocEndpoint.sdk`), which is
      what turns the table from a list of URLs into an index into that client.
      Absent on the two rows that are nobody's method to call: the page a browser
      fetches, and the carrier webhook a phone company posts to.
    - **The pane reads the agent through the same client it documents.** Both
      reads go through one `createAgentClient` — `agent.list()` and
      `agent.config()` — so the component is a worked example of the thing on
      screen rather than a second, hand-rolled way of asking the same two
      questions. `api.clientConfig` was that second way and is deleted.
    - **An upload property renders as a CALL, not a placeholder.** JSON can only
      say "get an id from this route"; the SDK snippet shows
      `const recordingUpload = await agent.upload(file, …)` and references
      `recordingUpload.id`, which is also what says the bytes go in once. That is
      why `sampleInput` takes an `upload` renderer — the same schema has to come
      out as data for one language and as an expression for the other.
    - **And the page documents how to DO the upload, not only how to use one**
      (`docs-uploads.tsx`, the "Sending a file" card). The four
      `/workflows/uploads` routes have been in the table since the pane existed
      and every generated run body for an upload-carrying workflow carried an
      id, but the only worked example of OBTAINING one was the `agent.upload`
      line inside the SDK start snippet — so a reader in a shell, or anyone
      reading the run body to find out what the field wants, was told the
      property takes an upload id and left to reverse-engineer the route that
      mints one from a summary line. The card leads with the client SDK
      (`agent.upload` / `agent.uploadStream` / `agent.uploadInfo` — uploads are
      a call on the client, not something a caller assembles), covers the two
      ORDERS (send the file and get an id back; or mint the id, start the run,
      and stream the bytes into it while the run reads the prefix), and is
      generated from the agent's own listing so the start-first example names a
      real workflow and a real property. It renders only for an agent some
      workflow of which declares an upload — the same judgement that keeps the
      workflow table off a voice agent.
    - **The shell alternate really uploads.** `curlStart` now emits the upload
      command above the run, leaving the id in a shell variable the run body
      EXPANDS (`"'"$AUDIO_FILE_UPLOAD_ID"'"` — the shell's own spelling for an
      expansion inside a single-quoted JSON argument), so the pair runs as
      pasted. Before that the body carried `<upload id for audio_file>`, which
      is a placeholder with no documented way to fill it in. Two details are
      load-bearing: the `curl` example file is a CONCRETE name rather than the
      `<angle bracket>` placeholder every other snippet uses, because an angle
      bracket is a shell redirect; and the bearer reaches the upload command as
      well as the start, since closing the workflow API closes the upload
      routes with it.
  - **And it maps every FORM CONTROL to the JSON that sets it**
    (`docs-forms.tsx`, the "Every form field, over HTTP" card, over
    `docs-form-fields.ts` and `docs-field-snippets.ts`). A workflow app's front
    door is a form, and the pane documented the form's DESTINATION while leaving
    the correspondence to inference: that one control is one property of the run
    `input`, which control a declared property renders as, and that exactly one
    of them is not a value at all. A reader could work most of it out; the place
    inference reliably fails is the file, because an upload property is a plain
    `string` in the schema — so the generated body reads as "type the recording
    here" for the one field where the caller has two calls to make.
    - **The classification is `<WorkflowFields>`'s, not a second opinion.**
      `classify()` mirrors `SchemaField` in
      aai-ui/components/workflow-fields.tsx, ORDER included — a declared upload
      beats everything, then `enum`, then `boolean`, then `number`/`integer`,
      then `string`, and anything else gets no control. A copy that drifted
      would name a control the reader cannot find on their own page, so
      `docs-form-fields.test.ts` pins the order rather than only the cases.
    - **Every control is listed, even the ones this agent declares nothing
      of** — deliberately the opposite of the rule the rest of the pane follows.
      The vocabulary IS the answer to "what can I send this thing", and a table
      that dropped `<CheckboxField>` because today's schema has no boolean would
      teach that the API cannot take one. What is GENERATED is the example on
      each row (this agent's own property and its own sampled value, from the
      same `sampleInput` the run bodies use), and each row says which of the two
      it is showing — a placeholder read as a real field name is how somebody
      pastes a 400. `<TextAreaField>` is never matched on purpose: it is a
      string like a text field, so one property would appear on two rows
      claiming to be two controls, and only one is what the generated form
      renders.
    - **The annotated snippet is written against ONE REAL workflow** — the one
      declaring the most fields (`fieldsWorkflow`). A synthesized every-kind
      body would be the more complete table and an unpastable command: the
      properties would come from two workflows and the run would 400 on the
      first one the schema does not know. It is one entry point
      (`fieldSnippets`) rather than two exported builders, because both halves
      are present together or not at all and two `string | undefined`s would
      leave the caller narrowing a pair that cannot disagree.
    - Why it is not the run card's own snippet: `sdkStart`/`curlStart` send the
      same body and are right for their card — the shortest runnable thing, one
      line — and a compact literal has nowhere to put the correspondence. So the
      body is expanded one property per line with the control it is, the
      comment column ALIGNED (it is a two-column table that happens to compile;
      a ragged edge reads as trailing remarks), and the upload rendered as the
      expression reading the id off the upload above it.
  - **The STUDIO pane carries no `/workflows/*` route table; the public page
    does** (`AgentApiDocsProps.workflowRoutes`, `false` from `docs.tsx`). A
    twelve-row route list is a reference for somebody writing a client, and a
    studio reader is being shown what their own agent answers — with a Workflows
    tab beside this pane for the subsystem itself. The public page's reader has
    a slug and an integration to write, so the table is what they came for. The
    asymmetry is the feature, and nothing is hidden by it: every route is still
    shown being CALLED in the snippets, and the openness sentence (whether
    `AAI_WORKFLOW_API_TOKEN` closes the API — the one thing on this half only
    the studio can say, since it reads the project's secrets) FOLLOWS the
    reader into the "Running a workflow" blurb rather than going with the rows.
  - The builders are a separate module from the pane for the reason every
    extracted-logic module here is one: a snippet whose field is spelled
    differently than the workflow declared it renders perfectly and 400s when
    somebody pastes it, so it is worth asserting directly rather than through
    a render. They are `docs-snippets.ts` now — the route tables and the schema
    sampling stayed in `docs-content.ts`, which is one subject where three
    languages' worth of code generation is another.
- **The same documentation is served PUBLICLY at `/studio/api/<slug>`, and the
  API pane links to it** (`public-api.tsx`, the shared body in `api-docs.tsx`,
  the path pair in `project-route.ts`). The pane is behind sign-in and scoped
  to the account that owns the project, so the one question it could not answer
  is the common one — "send me your API docs" — and every link it could hand a
  colleague, a customer, or whoever is integrating against the agent landed
  them on somebody else's sign-in screen.
  - **It discloses nothing new.** Both reads are the AGENT's own already-public
    routes (`GET /:slug/client-config`, `GET /:slug/workflows`), so a reader
    could have had all of it from two `curl` calls against a slug they already
    know; what the page adds is that they no longer have to know to try. That
    is also why the server route needs no ownership check — the response is the
    app shell, and the browser does the reading.
  - **Two things stay behind the studio**, and `AgentApiDocs` is split exactly
    along that line: the project's SECRETS (hence `token={false}` on the public
    page — a closed workflow API refuses the listing and the card quotes the
    agent's own 401, which beats printing an `Authorization` line nobody can
    fill in) and the carrier webhook CARD, which reads those secrets to report
    whether request signing is live. The `POST /:slug/phone` route ROW stays on
    both: it is a public route this agent answers, which is the page's subject.
  - **The page is chosen before the auth gate, in `main.tsx`'s render call**,
    not by an early return inside `Root`. `Root` calls `useStudioAuth`
    unconditionally, so an early return would sit above that hook (a rule
    violation the moment a path can change under a `pushState`) or below it —
    the version that reads `/studio/auth`, restores a session, and can flash a
    sign-in screen at a reader who will never have an account.
  - **The link names whichever agent the pane is documenting**, so before a
    first publish it points at the PREVIEW — replaced on every edit, swept with
    the project — and the card says so rather than handing out a URL that dies
    on the next turn.
- **There is no Database pane.** It was a read-only table viewer (`database.tsx`
  → `GET …/database/tables` and `…/database/rows`) over the app's own
  provisioned database, offered once the project opted in. The platform
  provisions no tenant database, so the pane, its routes and the SQL behind them
  are gone.
  - **Its best idea is worth restating if a data viewer ever returns**: the
    ENVIRONMENT was an explicit choice, never a default. Production and preview
    are separate agents, so "my tool saved nothing" versus "my tool saved it in
    the preview" is the confusion such a pane most easily either causes or
    resolves — the picker was always visible, the pane named the slug that
    answered, and the environment travelled to the server, which 400s a value it
    does not know rather than picking one.
- **The Logs pane TAILS the agent, and says which of two silences it is**
  (`logs-view.tsx` → `GET /:slug/logs`, the platform route — same posture as the
  Secrets card talking to `/:slug/secret`, and for the same reason: that route
  already owns the ownership check, so a studio proxy in front of it would be a
  second place to get it wrong). It polls by CURSOR and appends; a stream would
  be the nicer shape and the source is not one — the guest holds a bounded RING
  with a cursor, which a reconnecting stream would have to re-derive anyway.
  - **`running` is read from the response, never from `lines.length`.** An empty
    page means two different things — the agent is up and has printed nothing,
    or nothing is running to print — and they want opposite things from the
    reader (wait, versus go send it a request). A pane that guessed would get
    the first open of every project wrong.
  - **A gap is a ROW, not a silence.** `dropped` counts lines the ring evicted
    before this pane read them; rendering nothing for them is indistinguishable
    from an agent that went quiet, which is the one thing a log must never be
    ambiguous about.
  - **It follows the bottom only while the reader is there**, and that is
    `<AutoScroll>`'s job — `@alexkroman1/aai-ui`'s one owner of the effect, and
    the same component the chat transcript mounts — rather than the pane's.
    Scrolling up
    to read something is exactly when a forced scroll is worst, and the
    hand-rolled version this replaced got the second half wrong: it re-pinned
    only when a LINE arrived, so a line that wrapped, or a monospace font that
    finished loading, grew the content under a pane that thought it was already
    at the bottom. `instant` at both ends, because a spring animation on a tail
    that appends every second never settles.

    Its two behavioural specs went with it, deliberately. They were writable
    only because the hand-rolled version read three numbers (`scrollHeight`,
    `clientHeight`, `scrollTop`) a test could define by hand; the library is
    driven by a ResizeObserver over real boxes, and jsdom computes no layout, so
    an assertion here would pass or fail on the stub in `installResizeObserver`
    rather than on the pane. What is still THIS pane's claim, and still
    regresses silently, is that the lines are mounted inside that scroller at
    all — a plain `<div className="overflow-auto">` renders identically and
    follows nothing — so one wiring test asserts that, A/B'd against the div.
  - **The footer says the log is not durable**, once, because it is not: the
    ring lives in the sandbox and goes when the sandbox does (see "Why the
    buffer lives in the guest" in `packages/aai-guest/CLAUDE.md`). A pane that
    presented this as a log FILE would be lying about what it can show.
  - Preview is the default target because it is what the pane beside it shows —
    the agent the user is iterating on; Production is a deliberate switch, and
    each is disabled until that environment has an agent.

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
- **Unsaved editor work lives ABOVE the editor** (`file-drafts.ts`). The Code
  pane's buffer used to live inside `FileBuffer`, which is mounted
  `key={currentFile}` under a `CodeView` the pane switcher renders as
  `{tab === "code" && …}` — so the `dirty` flag and the `conflict` warning that
  exist to protect the user's text were computed by a component React unmounts
  the moment they click Preview or pick another file. Typing an edit and
  switching panes threw it away, silently, with nothing consulting either flag
  first. The buffers are held by `ProjectView` now, so both unmounts are
  survivable, and `beforeunload` covers the one thing that outlives even that
  (a reload, a closed tab). A project switch is deliberately unguarded: it is
  the same navigation the browser prompt covers, and the drafts belong to the
  project they go with.
  - Not a confirm and not a hidden-but-mounted `CodeView`: a confirm needs the
    dirty flag to have survived the unmount anyway (so it is this *plus* a
    dialog), and keeping the pane mounted fixes the pane switch but not the file
    switch — and pins CodeMirror, lazily loaded because it is the bulk of the
    bundle, into a `display: none` subtree it re-measures on every re-show.
  - The reconcile rule is a **pure function** (`syncBuffers`), not an effect:
    what happens to your text when the agent edits the same file is the thing
    worth testing directly. A clean buffer adopts; a dirty one keeps the text
    and raises `conflict`; a just-saved one keeps its draft until the workspace
    refetch catches up (`lastServer`, not equality with `draft`, is what a
    change is measured against).
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
  project, which the page dials for the provider read
  (`auth-methods.ts`), password sign-in, the session restore, and the
  code/token exchange after an OAuth redirect — GitHub itself is
  reached by top-level navigation, which connect-src does not govern. Both
  are derived
  from what the server really hands the client (`chatUrlForGuest`'s shape,
  the auth binding's own `clientConfig`) rather than hand-copied literals,
  and both are exact — `https://*.supabase.co` would trust every Supabase
  project on the internet. The sign-in case is the one that hides best:
  the page loads and `GET /studio/auth` succeeds (both `'self'`), so
  everything looks healthy until the button is clicked.

- **The sign-in screen offers what the BACKEND has, read from GoTrue**
  (`auth-methods.ts` → `GET /auth/v1/settings`; `SignInGate` renders it). One
  screen therefore serves a hosted project on GitHub OAuth and a local stack on
  email+password with no second code path and no environment check — which is
  what makes a local dev server usable without registering an OAuth app, now
  that a platform database refuses the no-auth dev tokens. Four rules:
  - **An unknown answer falls back to GitHub-only, never to nothing.** A failed
    or unparsable read must not remove the method production actually uses; the
    mirror-image default (assume everything is on) offers a button GoTrue
    answers `provider is not enabled` to, after a round trip through GitHub.
  - **A backend with NEITHER method renders as such.** It is a real state (a
    project that disabled both), and a card saying so beats dead controls.
  - **"Create account" is its own action, never a fallback from a failed
    sign-in.** Signing up because a password was MISTYPED leaves the user
    authenticated as somebody new with an empty project list, which reads as
    data loss and cannot be seen.
  - **The email is trimmed and the password is not.** Leading and trailing
    spaces are legitimate characters in a password, and stripping them makes a
    correct one fail with the message a wrong one gets.

  `readSignInMethods` lives in its own module rather than in `auth.tsx`, and the
  reason is the coverage split this package already documents: it is a plain
  fetch-and-parse the floors should govern, while the hook beside it is
  supabase-js plus an auth-state subscription plus an OAuth redirect and is
  deliberately never LOADED by a test. Importing a VALUE from `auth.tsx` in a
  spec drops the package ~11 points without covering anything new.

- **The session lives in `localStorage`, and the origin split is owed**
  (`auth.tsx`, and the threat-model note in `main.tsx`). Closing the tab no
  longer signs the user out. Tenant agent pages are served from this same origin
  (`/:slug/`) and their JS is attacker-controlled, so one can read that key —
  **moving them to a dedicated origin is a precondition of real users**, recorded
  in both places rather than assumed. What per-tab `sessionStorage` bought was
  narrower than it looks: the Live pane iframes `/:slug/` SAME-ORIGIN, and a
  same-origin iframe shares the tab's storage and can script the parent either
  way, so a hostile `client.tsx` already owned the session. The delta given up is
  a malicious agent page opened in a separately-opened tab. The dev-token path
  moved with it, deliberately — a dev-mode developer signed out on every restart
  while a Supabase one stayed in would be a difference nothing intends.

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

- **No studio action writes into the transcript.** Publish (success AND
  failure), a secret save or delete, and the Database toggle each used to
  inject a first-person user message — "I set the secret X…", "I published the
  project with the Publish button. aai deploy output: …" — so that the coding
  agent would know what changed. It is deleted (`chat-notify.ts`,
  `use-notify-registration.ts`, `NotifyChat`, `registerNotify`, and the
  `appendMessage` seam over `setMessages`), on the user's call: the transcript
  is a record of a conversation, and every one of those messages put words in
  the user's mouth for something a pane already reports beside the control that
  did it. Each surface now answers for itself — the PublishMenu renders
  `publish.data.output` and `publish.error`, each form on the Secrets pane
  clears its own input only on a successful save.

  What that gives up, stated because it is real: **the coding agent cannot see
  a secret, a database switch, or a failed deploy**, and the preamble tells it
  so rather than claiming a note will arrive (`studio-preamble.ts` — the
  Secrets section, and the Publish bullet under "AssemblyAI Build
  Capabilities"). A failed publish is the one with a cost: the user has to
  relay the error instead of the agent reading it. That is the trade that was
  chosen; the fix if it bites is a pane that offers "send this to the agent" as
  a BUTTON, never an automatic injection.

  Anything re-adding one owes the hazard the deleted module existed for: the
  SDK's streaming writer (`ai@7`, `Chat.makeRequest`) compares
  `response.state.message.id` against `this.lastMessage?.id` on every chunk and
  takes `pushMessage` when they differ, so a message appended UNDER a streaming
  assistant message becomes `lastMessage` and the next chunk pushes the
  assistant message a second time instead of replacing it — one object at two
  indices, under one React key, in the array the end-of-turn sync PERSISTS.
  Saving a secret while the agent worked was enough to corrupt a stored
  conversation. An injection therefore has to wait for a settled turn, exactly
  as the follow-up queue does.

- **Requests are deadlined BY DEFAULT; the SSE streams deliberately are NOT.**
  A browser fetch has no timeout of its own and a hung request is not a failure
  — it never settles, so no error path, retry, or backoff ever runs. That is
  what `fetch` does rather than a per-call hazard to remember, so the deadline
  lives in `fetchJson()` in `api.ts`, which every request goes through
  (`DEFAULT_REQUEST_TIMEOUT_MS`); a call names its own `timeoutMs` only when its
  work really is slower (`CHAT_SESSION_ATTEMPT_TIMEOUT_MS`) or its screen cannot
  afford to wait (the gate reads, the preview probe, `/studio/status`). A
  caller's own `signal` is COMPOSED with the deadline via `AbortSignal.any`, so
  passing one can only ever make a request settle sooner — never opt out.

  It was per-call before, and **four of ~18 requests carried one**.
  `GET /studio/status` was not among them, and it gates two screens: the home
  hero's textarea and Send sit behind "Checking the server's chat status…" while
  `status.data` is undefined, and inside a project `chatReady` stays false so the
  composer is disabled and `send()` returns early. One hung read deadened both,
  with no error, no retry and no way out but a reload.

  `watchEventStream` (`api-events.ts`) is the one place that must not have a
  deadline: a healthy stream IS a request that stays open indefinitely and says
  nothing for minutes, so no duration separates it from a hung one. Its liveness
  comes from the other end — the server pings, a dead connection surfaces as the
  read ending, and that reaches `onDown` → backoff resubscribe.

  **The FRAMING is the SDK's, and only the policy is ours.** `api-events.ts`
  carried its own `drainEventStream` — the third copy of that parser in the
  repo, and the one `sdk/event-stream.ts`'s doc names as such; aai-ui's
  `_sse.ts` was deleted rather than kept when the reader moved into the SDK,
  and this is the same deletion. What stays here is the studio's own stream
  policy (the `auth`/`transport` taxonomy, the abort handle, `onOpen`, the
  `ApiError` mapping). Two consequences: the SDK's reader hands back `data`
  already JSON-parsed, so the three `JSON.parse(frame.data) as T` casts in
  `api.ts` are gone and each frame is narrowed by a real guard instead
  (`isProjectData`/`isChatMessages`/`isProjectNames`, in `api-types.ts`, which
  is also where the line between what they check and what they leave to the AI
  SDK's own readers is argued); and a frame that fails a guard is DROPPED rather
  than tearing the stream down, which is the right answer where every frame
  carries a whole snapshot.

- **A rejected bearer is REFRESHED, never signed out on** (`auth-recovery.ts`).
  There were three call sites and two opposite conclusions. supabase-js runs its
  refresh ticker only on FOCUSED tabs, so a studio tab left in the background for
  an hour holds an expired-but-*refreshable* access token; focusing it refetches
  `projects`, `workspace` and `chat` with that dead bearer, all three 401, and
  the app's effect called `auth.signOut()` with no scope — revoking the refresh
  token on a session that was still good, and racing supabase-js's own focus
  refresh on the same event (the synchronous effect won). The event stream and
  the account gate already did the right thing; now there is one
  `useAuthRecovery(authRejection(…), refreshAuth)` and `refresh` alone decides
  whether the session survives, which is already its stated contract.
  - **The recovery is CAPPED, and the cap is the terminal state.** Against a
    server that will 401 a refreshable token — a different Supabase project, a
    JWT-secret mismatch, clock skew — an uncapped refresh is a loop behind a
    screen that says nothing. `AccountGate` used to run `void refreshAuth();
    return null;` *in its render body* (twice, under `StrictMode`), which is
    exactly that loop with a blank page in front of it. It is an effect now, it
    renders "Signing you back in…" while an attempt is in flight, and past the
    cap it signs out — the sign-in gate is somewhere the user can act.
  - **A refreshed bearer has to be pushed at the queries.** Only the account's
    cache key carries a bearer, so an error-state query has nothing to notice
    and would stay refused until the next window focus; `App` invalidates on a
    bearer change, excluding the chat session (its token comes from the broker's
    response, not from this bearer).
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

## Reach for `aai-ui` when it carries a RULE, not a look

This package imports very little from `@alexkroman1/aai-ui`, and most of that
restraint is correct: that package's components are driven by a theme OBJECT
(`useTheme`, the `--aai-*` custom properties) because they ship into end-user
agent apps, while the studio is a Tailwind app on its own tokens (`bg-panel`,
`text-muted`, `border-line`, `bg-indigo`). A themed component cannot cross that
line without dragging a second design system in behind it.

**The test is whether the export carries a LOOK or a RULE.** A rule crosses; a
look does not. Three things cross today and each was a duplicate before it did:

- `Markdown` and `ToolCallRow` — a parse and a disclosure shape.
- `AutoScroll` (`chat-transcript.tsx`, `logs-view.tsx`) — pin to the bottom,
  release when the reader scrolls up, re-engage at the bottom, driven by a
  `ResizeObserver` rather than a `messages` dependency. Both panes reached past
  it straight to `use-stick-to-bottom`, which is the library `AutoScroll`
  exists to have ONE owner of; the dependency is gone from this package's
  manifest with them. It is not themed — `className`, `contentClassName`,
  `scrollClassName`, composed with `clsx` — and it forwards `initial`/`resize`,
  so neither pane gave anything up: the chat keeps `instant`/`smooth` and the
  Logs tail keeps `instant`/`instant`. Both pass `scrollClassName="overflow-y-auto"`,
  because the default hides the scrollbar and these panes show a native one.
- `useCopy` / `useFlash` (`phone-card.tsx`, `cli-commands.tsx`) — they were
  EXTRACTED here and have moved INTO `aai-ui`, which had a third copy of the
  flash inside its own URL chips. See "The flash primitive is `aai-ui`'s" in
  `packages/aai-ui/CLAUDE.md`.

The direction that is never right is the other one: `aai-ui` may not import
this package or anything platform-side (`browser-package-boundary` in
`konsistent.json`), so a shared primitive MOVES down rather than being reached
up for.

## Testing this package

**node is the default and jsdom is a per-file pragma.** Most suites here carry
`// @vitest-environment jsdom` on line 1; the ones that do not are pure logic
(`file-drafts`, `chat-queue`, `stale-build`, `starters`, `project-route`, the
`api` and `docs-*` reads) plus `chat.test.tsx`, which asserts markup through
`react-dom/server` and says so. A count used to stand here ("18 of the 26")
and was wrong in both halves within a release — nothing measures it, so read
the pragmas.
Interaction behaviour — clicks, effects, timers, `beforeunload`, clipboard,
fake-timer poll loops — belongs in a pragma'd file. The split costs nothing in
coverage: a `.tsx` test that forgets the pragma fails loudly on `document is
not defined`, never silently.

**`src/_test-utils.ts` is the shared seam, and reaching past it is the smell.**
What it owes is `studio-client-test-seam` in `konsistent.json` rather than a
list here; a suite that rebuilds one of those shapes instead of importing it is
the half konsistent cannot see, and stays a review question.

**`afterEach(cleanup)` lives in `src/_test-setup.ts`, not in the suites** —
`studio-client-cleanup-is-setup` forbids the import outright, and its
description carries the leaked-fake-timer failure that bought the rule. The
setup file also raises Testing Library's async ceiling to 10s, which
`vitest.config.ts` has to back with a matching `testTimeout` (20s), or the
5000ms default aborts the wait first and throws away the message.

**Constants a test asserts a cadence against are IMPORTED, never mirrored** —
`studio-client-probe-cadence` and `studio-client-probe-cadence-imported` are the
two halves of that for `preview.tsx`'s four `PROBE_*` figures, and the second
one's description says why an exact bound over a mirrored number is the worst
of both.

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
  `AAI_SERVICE=combined`), and `.github/workflows/ship.yml`'s deploy job fires
  on a version bump to `aai-server` **or** `aai-studio-server` — never on this
  package's own version. So a studio-client change needs a changeset naming
  one of those two, or it ships to nothing.

  **That is `guard-invariants` rule 20 now, not advice.** It used to be guarded
  by nothing, and the trap is that every other gate stays green: the pre-push
  `changeset status` only asks whether the changed packages have A changeset, so
  an author who changes this package, is correctly told to write one, and names
  the package they changed has satisfied every check and deployed nothing. The
  rule's table (`SHIPS_VIA` in `scripts/guard-invariants-changesets.mjs`) carries
  `aai-guest` and `aai-templates` for the same reason — each is built into
  another package's artifact, so its own version reaches nobody.

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
