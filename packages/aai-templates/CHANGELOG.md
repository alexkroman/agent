# aai-templates

## 0.4.0

### Minor Changes

- 14e70ea: Add `hiring-desk`, a port of CrewAI's `lead-score-flow` — the most complex example in `crewAI-examples` — as a voice agent: one crew scores a stack of applicants against a role (`ctx.generate` with a schema, fanned out through `mapConcurrent`), the human-in-the-loop router becomes a `dialog()` whose `reviewing` state offers the caller the same three choices, the feedback cycle gains the bound their flow lacks, and the other crew writes every applicant an email as a `subagent()` with `expectedOutput` and a `guardrail`. `crews.ts` carries the attribution and the their-name → our-name table.
  
  The CLI is named alongside it because that is what actually ships a template — `bundle-templates.mjs` copies `templates/` into the CLI's dist at build time, so a changeset naming `aai-templates` alone bumps a version nobody resolves and delivers the template to no one.
- b463bb5: Add `roadside-assist`, the template for a dialog that describes a CALL rather than a form: a silence ladder, an abandonment deadline, an uninterruptible disclosure, and per-state LLM knobs.
  
  The CLI is named alongside it because that is what actually ships a template — `bundle-templates.mjs` copies `templates/` and the scaffold into the CLI's dist at build time, so a changeset naming `aai-templates` alone bumps a version nobody resolves and delivers the template to no one.
- ffb795f: Publish `dialogRefusalPattern` and `expectDialogRefused` from `@alexkroman1/aai/testing`. A `dialog()` gate refuses an out-of-state call with one sentence, and seven templates' specs had pinned that sentence by hand — two of them re-deriving the JSON escaping an eval reads it through — so rewording the model-facing half of the gate would have broken eight suites that never imported it. The sentence is built in one module now, the pattern is derived from it, and `expectDialogRefused` is the mirror of `expectDialogOk`: it throws when the gate did NOT hold, naming where the dialog landed, where the `isToolFailure` + `if` shape it replaces let a success through with every assertion after the guard skipped.
  
  The templates also stop re-deriving five helpers the SDK already exports: `formatMoney` (travel-concierge's page), `spokenDigits` (retail's zip lookup), `plural` (dispatch-center's "protocol(s)"), `countWords` (pipeline-simple's eval) and `toolNames` (a starter's eval).
- 3b55bab: Add two templates ported from the other two voice-agent frameworks' largest samples.
  
  `hotel-desk` is LiveKit Agents' `hotel_receptionist` — the biggest example in that repository — as a voice agent: a boutique hotel's whole front desk over one seeded `sessionSlot`, verification the TOOLS run (three strikes and a human takes over), a room-booking flow as a `dialog()` whose step is derived from what has been captured and whose read-back is OWED until the caller's next committed turn, a dispute engine that reads the disputed amount off the stored line item, the re-accommodation procedure that moves a double-booked guest up or walks them, a guest-privacy tool whose result cannot leak whether anyone is in house, and a twenty-topic policy book rendered partly from the concierge catalogs. Forty-one tools; `shared.ts` carries the attribution and the their-name → our-name table.
  
  `word-wrangler` is Pipecat's `word-wrangler-gemini-live` phone game — a three-way word game whose upstream is a parallel pipeline running two Gemini Live sessions — as one voice agent: the host is the agent, the AI player is `ctx.generate` on its own prompt with only the current word's context, the referee is a function, the describer's own transcript is what rules a foul, and the two-minute game clock is the `playing` state's `timeout`.
  
  The CLI is named alongside because that is what actually ships a template — `bundle-templates.mjs` copies `templates/` into the CLI's dist at build time, so a changeset naming `aai-templates` alone bumps a version nobody resolves and delivers the template to no one.
- 9f78b85: Re-express every template through the SDK surface it had been hand-rolling.
  
  The templates are the SDK's reference consumers, so a primitive with no worked
  example is one nobody is shown — and the sweep's finding is that those are
  exactly the primitives templates got wrong by hand. `createKeyedLock` had no
  exerciser at all, and both templates needing mutual exclusion had written
  something broken: `roadside-assist` handed every concurrent caller the same
  truck (nothing marked one taken), and `hiring-desk` lost updates on the counter
  bounding its own feedback loop, silently unbounding `MAX_FEEDBACK_ROUNDS`. Both
  now go through the primitive, and both bugs are pinned by tests that fail
  against a passthrough lock.
  
  Around twenty defects came out with them. A shipped `"1 episode summaries"`
  whose spec pinned the typo (`plural`); float drift in two carts, one rate with
  cents making it visible (`roundMoney`); a grader's `reason` read by nobody
  (`GuardrailVerdict`); a clamped upload read that produced a transcript missing
  its tail and reported it complete; `solo-rpg` and `dispatch-center` each
  declaring a dialog, gating tools with it, and never passing it to `agent()`, so
  per-state instructions reached the model only on turns that happened to run a
  gated tool; a weekday named by `toLocaleDateString`, which answers to the host's
  ICU build rather than the guest's; a reservation lookup that normalized one side
  of its comparison and so never matched a spoken code; and four tools declared as
  a plain `tool()` over `slot.get(ctx)`, which the package guide describes as a
  compile error and is not.
  
  `web-researcher` gains the first `mcpServers` example in the repository, gated
  on an env var so the starter still deploys with no credential. `pipeline-simple`
  becomes the worked example for the provider surface — the option types, model
  and voice constants, and both presets — which had none.
  
  The CLI is named alongside it for the reason every template changeset names it:
  `bundle-templates.mjs` copies `templates/` into the CLI's dist at build time, so
  a changeset naming `aai-templates` alone bumps a version nobody resolves.
- a09acd2: Publish `WorkflowPendingNote` and `WorkflowRunError` from `@alexkroman1/aai-ui` — the pending-run sentence and the announced failed-run line six workflow-app templates had each written by hand — and migrate the templates onto them and onto the existing `SessionErrorBanner`, `AGENT_STATE_LABELS` and `useSessionStatus` where a page still carried its own copy.
- 083662f: Remove three templates that were near-duplicates of ones that stay, taking `aai init`'s catalog from 31 to 28. The picker lists bare directory names with no hints, so four indistinguishable spellings of one starter cost an author real attention at the moment of choice.
  
  - **`embedded-assets`** — its whole subject was a knowledge base bundled as a JSON asset import, which `support-line` does with the identical `with { type: "json" }` import over a real IDF-weighted retriever with graders on top (and `hiring-desk` and `retail` import JSON assets too). It exercised no SDK export nothing else does.
  - **`math-buddy`** — `code-interpreter` (the same `run_code`, the same never-do-mental-arithmetic prompt) plus the one-line LLM stage swap that `pipeline-simple` exists for. Its one distinct claim, that a declared stage's `options` survive the conversion and not just its `kind`, moves to `pipeline-simple`'s spec, where the swap lives.
  - **`personal-finance`** — `code-interpreter`'s prompt with the `fetch_json` builtin added and no code of its own. That builtin lands on `health-assistant` instead, with a job the two `tools/` files cannot do: they read openFDA's LABEL endpoint, so what people actually REPORT (`/drug/event.json`, a counting query) is the model's to compose. Its spec gains the starter invariants it never had — `expectDeployable`, the builtins surviving into the config, and the prompt↔`builtinTools` pairing.
  
  The studio's hero catalog drops the three matching starter buttons, so `aai-studio-server` is named alongside it: the starters are front-end source a DEPLOY carries, and a bump to a carrier is what arms one.
  
  `commandedBuiltins` (`@alexkroman1/aai/testing`) loses its only exerciser and becomes a template-API allowlist entry: `expectPromptBuiltinsDeclared` already returns the commanded list, so a second call would be the contrived use the allowlist exists to avoid.
- ffb795f: The second half of the template audit: five families of code the templates kept rebuilding move into the SDK, and the templates become their worked examples.
  
  **`@alexkroman1/aai-ui` — the session chrome kit.** `SessionStateDot`, `SessionControls` (with the headless `useSessionControls`), `ConversationView` (which `MessageList` is now built on, DOM unchanged), plus `AudioResult` and `WorkflowRunPanel` for workflow-app pages, and an `.aai-scroll` utility in `styles.css`. Three custom chromes (`dispatch-center`, `retail`, `infocom-adventure`) each rebuilt the dot, the Start/Pause/New/End row with the same twelve-line comment on `end()` vs `reset()`, and the conversation skeleton; two pages each rendered the audio block and the run panel by hand.
  
  **`@alexkroman1/aai` — `sessionSlot({ caps })`.** A per-array growth cap the slot enforces after every write (after the author's `after` hook), typed so only array-valued keys are accepted (`SlotCaps<T>`). Ten templates paired a `MAX_*` constant with a wrapper whose whole body was `pushCapped`, and a wrapper caps only the paths that call it: `executive-assistant` had three uncapped arrays riding every `syncState` frame. `pushCapped` stays for nested lists.
  
  **`@alexkroman1/aai/step` `mapSettled` / `partitionSettled` / `Settled`** — bounded fan-out with per-item failure isolated into a value, which `hiring-desk` and `briefing-desk` had composed over `mapConcurrent` and `Promise.allSettled`. **`@alexkroman1/aai/tts` `ttsVoiceIds(language?)`** — the `z.enum` tuple of catalog voices two templates derived by hand. **`spokenAlphanumeric`** beside `spokenDigits`.
  
  **`@alexkroman1/aai/testing`** — `expectDeployable` (the three starter invariants six specs wrote out), `expectPromptBuiltinsDeclared` / `commandedBuiltins` (the prompt↔`builtinTools` scan two specs had byte-identically), `runGuardrail`, and `scriptedToolContext` (both model seams scripted, answering `{ ctx, model, desk }`).
  
  **`@alexkroman1/aai-runtime/eval`** — `runCodeIn` / `runCodeOutput` (the second throws on the executor's refusal, importing the sentence from the executor rather than letting a spec re-type it), `expectToolBeforeSpeech`, and `EvalTurn.errors` with `errorsIn`.
  
  Epochs: `aai:state` 18, `aai:testing` 29 and `aai-runtime:eval` 9 retain their predecessors with frozen examples; `aai:spoken`, `aai:step`, `aai:tts` and the three `aai-ui` capabilities are bumped with the additive-drop reason this repo records for a package that keeps no example of the superseded epoch.

### Patch Changes

- 66568a5: Templates: remove dead code, adopt the SDK helpers three of them still re-implemented, and cut wasted work on the voice and workflow paths.
  
  User-visible in the templates `aai init` copies: hotel-desk prints money with thousands separators (its own formatter had none, so a multi-night bill read $1240.00) and validates every date field through its schema, so a bad date is refused before the tool body runs and the model is told why; podcast-digest bounds its feed-read fan-out instead of opening one request per link at once; solo-rpg's projection no longer sends the browser the goal and mood of acts the player has not reached; night-owl's spinner clears when the tool settles rather than when the list happens to grow.
- b463bb5: Give `retail` and `travel-concierge` an abandonment state, and `retail`'s confirmation read-back a low temperature.
  
  Both templates hold a staged change in a confirmation gate that nothing settles if the caller hangs up, leaving every sensitive tool legal for the rest of the session. `"@session.timed-out"` now carries each into a `final` state where nothing runs. `retail`'s `awaitingConfirmation` also declares `temperature: 0.2`: reading an order number and a dollar amount back is transcription, and the template already guards the same problem on the way in through `resolve.ts`.
- 7062ab9: Add the `executive-assistant` template: LangChain's Executive AI Assistant (EAIA) as a voice agent. Triage, drafting in the executive's voice, a meeting-assistant subagent over the calendar, the Agent Inbox's four answers (accept, edit, ignore, respond) as tools gated on a review dialog so nothing is sent before a spoken yes, and the reflection graphs that rewrite the assistant's own prompts from each correction.
- 66568a5: Pin three template layout conventions that were carried by habit, and correct two docs that described the wrong one.
- 0666785: `aai init` no longer copies the 120KB authoring guide into the project. A scaffolded `CLAUDE.md` is now a ~30-line pointer at `node_modules/@alexkroman1/aai/AGENT_GUIDE.md` — the version-matched copy that ships in the SDK tarball, which the SDK's own skill has always named as the authoritative one.
  
  The copy it replaces could not be right. It froze at the moment `aai init` ran and went stale on the project's next `pnpm update @alexkroman1/aai`, which is what `AGENT_GUIDE.md` exists to fix; and Claude Code loads a project-root `CLAUDE.md` in full at launch against a documented 200-line target, so every session in a user's agent project paid ~30k tokens for 2,533 lines of guidance whose own publisher told agents to prefer the other file. Splitting it behind an `@import` would not have helped — imports are expanded at launch too — so the pointer names the path in a fence, the documented spelling for "mention, do not import", and an agent reads it on demand out of the tarball the project actually resolved.
  
  A scaffolded project is 21KB across 12 files instead of 136KB. Nothing else in `scaffold/` changed, a project's own `CLAUDE.md` still wins, and a template that ships one still has it copied — only the scaffold's guide is filtered.

## 0.3.10

### Patch Changes

- 9584e2e: Parse third-party JSON in the recap-workflow, podcast-digest and call-audit workflow bodies with declared zod schemas instead of hand-rolled per-field guards, keeping every degradation path (a malformed payload, a missing optional field, a field of the wrong type) exactly as it was.
- b94fdd1: transcription-workflow: measure the upload's byte rate as an AVERAGE, and give the poll floor a comparison that means something.
  
  The streaming flow's adaptive sleep took its rate from two adjacent polls. The store publishes bytes an `UPLOAD_PART_BYTES` window at a time, so that difference is bimodal — zero (read as a stall, giving back the flat ceiling) or one whole 8 MiB window (an instantaneous burst tens of times the true average, collapsing the sleep to its floor) — and never a throughput. It now measures against the run's FIRST poll, which is also what removes a placement bug: the `previous = at` assignment sat after the sleep, so the `continue` taken on a batch of ready segments skipped it and the next rate was computed against a pre-batch view.
  
  `MIN_POLL_INTERVAL_MS` was 250ms and therefore dead: a durable sleep's deadline is computed before its journal write is issued and tested after that write returns, so at the measured 164-796ms of journal latency a 250ms sleep had already expired and did not sleep at all. It is 1000ms, and its doc now compares against the round trip of the machinery that implements the sleep rather than against a segment's transcription latency. Two more corrections in the same file: `MAX_IDLE_POLLS` is 20-40 minutes of silence rather than the five its doc claimed (a poll costs a delivery, not an interval), and an unreachable `remaining <= 0` arm is gone — the clamp below it already answered the floor for every input.

## 0.3.9

### Patch Changes

- 14b1d2d: Give every voice template a one-click new-conversation control. The three templates that pass a custom `component:` render no `<Controls>`, so dispatch-center and retail had no way back to a fresh conversation without going through the start screen; each now carries its own button, and infocom-adventure's [N]ew Game deals a new game in one click with [Q]uit keeping the hang-up. A new case in template-page-mount.test.ts holds the line.

## 0.3.8

### Patch Changes

- afe5ac3: Retail template: the "confirm every change out loud" policy is a dialog gate now, not prose. The seven changing tools stage a validated, priced change and return the sentence to read back; `confirm_change` — gated on a new `serving.awaitingConfirmation` state and the only tool that writes to the store — applies it, and `cancel_change` drops it. Departing from tau2's fifteen-tool set also lets an exchange record the pairing it priced rather than two independently sorted lists.

## 0.3.7

### Patch Changes

- d98169a: Publish `dist` and nothing else. `@alexkroman1/aai` had no `files` field, and
  `.npmignore` excludes only repo artifacts (`etc/`, `coverage/`, `.turbo/`,
  `contracts/`) — so every tarball carried the whole `host/` and `sdk/` TypeScript
  source and 219 test files: 961 entries, 2,049 kB packed, 7,632 kB unpacked,
  against 209/505/1,476 now. Consumers were downloading the SDK's test suite.
  
  `AGENT_GUIDE.md` and `skills/` stay (both ship deliberately); `CHANGELOG.md`
  does not, matching `aai-ui` and `aai-cli`. Nothing supported breaks — every
  `exports` target is under `dist`, and the `@dev/source` condition that points at
  `.ts` source is activated only by this monorepo's own `customConditions`.
  
  `published-files-gate.test.ts` is the guard: every publishable package declares
  a non-empty `files`, and every `exports` target is covered by it. The two things
  that should have caught this and did not are worth naming — the artifact-size
  report compares against the PR base, so a package that has ALWAYS shipped its
  source never trips a delta gate, and `publint` files it as a *suggestion*, which
  `check:publint` passes over.
- b8a5529: Version `@alexkroman1/aai-runtime`'s published surface in epochs, like `aai` and
  `aai-ui`. Twelve capabilities — `server`, `runtime`, `session`, `session-state`,
  `providers`, `telephony`, `uploads`, `db`, `keys`, `workflow`, `logging`,
  `text` — partition all 122 public names, each with a committed epoch and a
  frozen, compiling authoring example. `pnpm check:api-contracts` now reports 42
  contracts across 3 packages.
  
  The split shipped a published package with no `contracts/` tree, so 221 exports
  could move with nothing recording it while its two siblings could not change a
  parameter without a gate asking which. `contracts/internal-surface.json` opens
  at 68 and may only shrink — the ratchet that took `aai` from 74 to 0.
  
  Two gate-test parsers had never seen shapes this package introduces, and both
  reported a healthy tree as broken. A capability whose every name is a type
  collapses to `export type { … } from` under Biome, which
  `api-contracts-gate.test.ts` read as "declares something of its own" — so
  `session` and `session-state`, the two most obviously correct roots, failed. And
  an entry point can be ALL re-export (`/internal` passes on 31 names and declares
  nothing), which `api-surface-file.test.ts` read as an empty report —
  indistinguishable there from a parser that stopped working. The gate tests also
  pin the three-way `:workflow` ambiguity now, plus `:session` and `:uploads`,
  which is what makes the CLI's refusal to guess load-bearing.
- abfc018: Correct the subpath every step primitive is named under. `packages/aai-templates/CLAUDE.md`
  and `scaffold/CLAUDE.md` said `mapConcurrent`, `emit`, `stepEnv` / `requireStepEnv`,
  `stepGenerate`, `stepFetch` / `multipartBody`, `stepSpeak`, `writeUpload`, `report`,
  `encodeWav` / `pcmDurationMs` and the four `stepTranscribe*` were on
  `@alexkroman1/aai/utils`. That subpath has 15 exports and not one of them is a step
  primitive — all of the above are on `@alexkroman1/aai/step`, which was split out of
  `/utils` precisely because "zod-free so the CLI can import it cheaply" is a build
  property nobody imports BY. Nine prose claims across the two guides, nine template
  doc comments, and three of the scaffold guide's copy-paste import lines.
  
  The scaffold guide is the one that mattered: it ships twice, as the studio coding
  agent's system prompt and as `AGENT_GUIDE.md` inside the `@alexkroman1/aai` tarball.
  `packages/aai-studio-server/studio-preamble-mode.ts` had copied the error, and every
  workflow the studio generated from it carried an import that cannot resolve. Its three
  fences are `ts no-check` fragments, so `check:doc-examples` compiles them for nobody —
  which is why a wrong specifier in a shipped guide survived a gate that exists to catch
  exactly that.
  
  Two more names, found by validating every `@alexkroman1/*` import in the two guides
  against `API-EXPORTS.json`. The scaffold's workflow-app page imported
  `WorkflowOutputOf` from `@alexkroman1/aai`, where it does not exist; all six template
  `client.tsx` files take it from `@alexkroman1/aai/workflow-api`. And the HTTP/2
  fan-out passage still named `mapInBatches`, which `sdk/map-concurrent.ts` declares a
  `@deprecated` alias — `research-workflow` was the last template still calling it, and
  is converted (the alias IS `mapConcurrent`, so the two calls are identical), with the
  `recap-workflow` prose mention that named it as a live primitive. The two
  `transcription-workflow` mentions stay: both narrate the rename.
  
  Also drops two claims about the coverage gate that the wrong subpath had propped up.
  `template-api-coverage.test.ts`'s `SCOPED_MODULES` is the `aai` root plus
  `stt`/`tts`/`llm`/`s2s` and the `aai-ui` root — so `/step` and `/testing` are outside
  it entirely, and neither the step surface nor the bare `stubGateway` has, or could
  have, the allowlist entry the guide credited them with.
  
  And re-baselines `template-api-allowlist.json` against the surface either side of it
  moved. Down by four — `BaseOptions`, `ComponentTier`, `ConfigTier` and
  `VOICE_CAPTURE_CONSTRAINTS` are no longer exported by `@alexkroman1/aai-ui`, so the
  gate reported them stale. Up by two, and only after exhausting the better option:
  `isRecord`, `omitUndefined` and `responseErrorMessage` joined the `aai` root barrel,
  where no template exercised them because every template takes them from `/utils`,
  which the gate does not scan. `omitUndefined` needs no entry — its four agent-side
  consumers (`retail/store.ts`, `retail/tools/get_order_details.ts`,
  `support-line/procedure.ts`, and `plan-and-execute/shared.ts` for `isToolFailure`)
  already import the root barrel one line above, so the second import line is now
  merged into the first and the name is exercised for real. The other two are consumed
  ONLY from `workflows/*.ts` modules, where a root import is the exact thing the
  bundling rule above forbids, so they are recorded instead — beside the seven
  root-and-`/utils` names (`safeJsonParse`, `errorDetail`, `createKeyedLock`, …) already
  there for the same reason.

## 0.3.6

### Patch Changes

- 58788ee: Internal quality pass: give repeated shapes one home each, remove stranded code, and hoist redundant work out of render and streaming paths. No API or behaviour change.

## 0.3.5

### Patch Changes

- 16bec88: Use the SDK's own `errorMessage` and `isToolFailure` where the guest harness and the retail template had hand-written copies of them.

## 0.3.4

### Patch Changes

- 29fa487: Scaffold: the `deploy` npm script is now `publish:agent` running `aai publish`.

## 0.3.3

### Patch Changes

- 5de32f3: Simplify and de-duplicate template code: shared price/menu helpers in pizza-ordering, derived move labels and shared save-slot schema in solo-rpg, shared utilization/age/resource-brief helpers in dispatch-center, memoized FDA label lookups in health-assistant, precomputed FAQ search text in embedded-assets, and drift pins for the scaffold guide's SDK defaults.

## 0.3.2

### Patch Changes

- e8fef4b: Add template API coverage ratchet: a test that flags public aai/aai-ui exports no template exercises, held in template-api-allowlist.json (baseline may only shrink)

## 0.3.1

### Patch Changes

- 34b40f7: Switch the pipeline-simple template's TTS from Cartesia to AssemblyAI so all templates use AssemblyAI TTS

## 0.3.0

### Minor Changes

- 2236275: Move the platform to Supabase and replace KV with an opt-in per-app database.

  - **Blob storage**: agent bundles now live in Supabase Storage via its
    S3-compatible endpoint (`SUPABASE_S3_ENDPOINT` / `SUPABASE_S3_ACCESS_KEY_ID`
    / `SUPABASE_S3_SECRET_ACCESS_KEY` / `SUPABASE_STORAGE_BUCKET`), replacing
    Tigris.
  - **Secrets**: agent env vars are stored in Supabase Vault over
    `SUPABASE_DB_URL` (service-role Postgres). The master-key envelope
    encryption and `KV_SCOPE_SECRET` are removed.
  - **KV support is removed** — `ctx.kv`, the `@alexkroman1/aai/kv` providers
    (`memoryKv`, `fsKv`, `s3Kv`, `redisKv`), the `kv:` agent config field, the
    `/:slug/kv` HTTP API, and the guest `kv/*` RPC are all gone. The
    `remember`/`recall` builtins keep working, now backed by in-memory
    per-session notes.
  - **New: opt-in app storage (`ctx.db`)** — enabling storage gives an app its
    own Postgres schema + role in the platform's Supabase database, exposed to
    tool code as `ctx.db.query(sql, params)` (proxied over the `db/query` guest
    RPC). Enable it with the new `aai storage enable|disable|status` CLI
    command or the studio's Storage toggle; under `aai dev`, set `DATABASE_URL`
    in the project `.env`. Templates needing persistence (solo-rpg saves,
    debrief-workflow records) now use `ctx.db`; session-scoped template state
    moved to `ctx.state`.

### Patch Changes

- 53b1b45: Declare allowedHosts in templates whose tool code fetches external services (health-assistant: api.fda.gov; personal-finance: open.er-api.com, api.coingecko.com)
- 2236275: Migrate all sandboxing and deployment to Modal.

  Agent guest sandboxes now run as remote Modal Sandboxes (`modal-sandbox.ts`,
  via the `modal` SDK): network-blocked containers running the Deno harness,
  speaking the same NDJSON JSON-RPC protocol over the exec'd process's stdio.
  The gVisor (runsc) OCI backend, the dev-mode child-process fallback, and the
  fake-VM harness are all removed — Modal credentials (`MODAL_TOKEN_ID` /
  `MODAL_TOKEN_SECRET`) are now required to run sandboxes in dev and prod alike.

  The server itself also deploys to Modal (`modal_deploy.py`,
  `pnpm --filter aai-server deploy:modal`); the production Dockerfile, the
  Docker test image, and the Fly.io configuration/deploy pipeline are removed.

- 3722a9f: Improve the studio coding-agent prompt: concrete design guidelines for custom client.tsx UI (color, typography, layout, Tailwind, accessibility) in the scaffold guide, plus parallel tool-call and context-gathering rules in the studio preamble

## 0.2.3

### Patch Changes

- e17fdc4: Rename workflow templates: voice-debrief → debrief-workflow, slack-translator → slack-translator-workflow; scaffold guide notes that a "workflow" request means workflow(), not agent()

## 0.2.2

### Patch Changes

- 7043302: Add a slack-translator template: text-only pipeline (tts: none()) that translates dictated speech to French and posts it to Slack via send: slack().

## 0.2.1

### Patch Changes

- fbcb755: Drop the direct esbuild dependency: the CLI now bundles with Rolldown end to end.

  - `aai dev`'s fast worker builds (`_dev-bundler.ts`) run on Rolldown — the native bundler Vite 8 itself uses, so the dependency dedupes to zero extra install weight. Fresh builds land in tens of ms, so the old incremental esbuild context is no longer needed; non-compile failures still fall back to the cold Vite path.
  - Deploy/studio worker minification switches from `minify: "esbuild"` (which loaded esbuild as Vite's optional peer) to Vite 8's native `"oxc"` minifier. The studio inherits this automatically via `@alexkroman1/aai-cli/worker-bundler`.
  - The scaffold keeps its pnpm build-script approval for esbuild: the CLI no longer pulls it in, but esbuild remains an optional peer of vite, so projects whose lockfile ever resolved it (upgrades from an older CLI) still install it and need its postinstall approved.

- 857c7d3: Remove the smart-research template

## 0.2.0

### Minor Changes

- c5a5351: Add pipeline-mode silence nudge: new silenceTimeoutMs and silencePrompt agent config fields make the assistant proactively take a turn after a period of user silence (capped at 3 consecutive nudges until the user speaks again)

## 0.1.0

### Minor Changes

- d3b39ef: Wire pluggable STT/LLM/TTS providers through the managed-platform sandbox. Previously providers were defined as live Vercel AI SDK / SDK-client instances in agent.ts, which meant the bundle shipped '@ai-sdk/anthropic' etc. into the guest Deno sandbox — the SDK's eager ANTHROPIC_BASE_URL env read crashed under '--allow-env'-free Deno. The server's createRuntime() also ignored stt/llm/tts entirely, so pipeline mode never activated in production. Now factories under @alexkroman1/aai/{stt,tts,llm} return '{ kind, options }' descriptors (JSON-serializable, no AI-SDK imports). The host resolves them to real openers at session start via a new resolver. IsolateConfig carries mode + descriptors through deploy, and sandbox.ts threads them into createRuntime. The agent bundle is now ~66 KB with zero AI-SDK code.

## 0.0.6

### Patch Changes

- 66cbc95: Fix pnpm install failure when scaffolding pipeline-simple template. The template's package.json was replacing the scaffold's, leaving a workspace:\* marker that pnpm cannot resolve outside the monorepo. Pipeline-mode SDKs (ai, assemblyai, @ai-sdk/anthropic, @cartesia/cartesia-js) now live in the scaffold's package.json. Also surface pnpm's actual stdout/stderr on install failure instead of the opaque 'Command failed' wrapper.

## 0.0.5

### Patch Changes

- 5cda7c5: Add ctx.send for real-time tool-to-client events

  Tools can now push arbitrary events to the browser client via `ctx.send(event, data)`. Events flow over the existing WebSocket as `custom_event` messages. The new `useEvent` React hook subscribes to named events. Migrated solo-rpg, pizza-ordering, dispatch-center, and night-owl templates from `useToolResult` to `ctx.send` + `useEvent`.

## 0.0.4

### Patch Changes

- 27faac9: Fix missing CSS in scaffolded agents: remove client.tsx and index.html from scaffold, serve pre-built default UI when no custom client exists, provide fallback index.html via Vite plugin for custom clients

## 0.0.3

### Patch Changes

- b3bafa7: Fix missing CSS in scaffolded agents: remove client.tsx and index.html from scaffold, serve pre-built default UI when no custom client exists, provide fallback index.html via Vite plugin for custom clients

## 0.0.2

### Patch Changes

- 50cd113: Fix scaffold missing client.tsx and route pnpm install through safe-chain

  - Add client.tsx to scaffold with correct `client` import from aai-ui (fixes build failure from stale `defineClient` reference)
  - Detect safe-chain on PATH and route pnpm install through it with `--safe-chain-skip-minimum-package-age` to avoid blocking newly published packages

## 0.0.1

### Patch Changes

- 486fb23: Simplify aai-ui package: remove Reactive<T> abstraction, hardcode Preact signals, inline micro-components, merge createSessionControls into createVoiceSession, remove ./session subpath export.

  BREAKING CHANGES:

  - `createSessionControls` removed (merged into `createVoiceSession`)
  - `SessionSignals` type removed
  - `Reactive<T>` type removed
  - `useSession()` return shape changed (returns `VoiceSession` directly)
  - `VoiceSessionOptions` no longer accepts `reactiveFactory` or `batch`
  - `./session` subpath export removed
  - Components removed from exports: `ErrorBanner`, `StateIndicator`, `ThinkingIndicator`, `Transcript`, `MessageBubble`
  - `ButtonVariant`, `ButtonSize` types removed from exports
  - `ClientHandle.signals` removed (use `ClientHandle.session` directly)
