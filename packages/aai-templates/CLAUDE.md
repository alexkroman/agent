# packages/aai-templates — templates guide

Agent templates + the project scaffold (private package). Note
`scaffold/CLAUDE.md` is a PRODUCT artifact — it is scaffolded into every
`aai init` project and embedded in the studio system prompt — not
documentation for this repo.

## Templates

- `packages/aai-templates/templates/` contains agent
  scaffolding templates (simple, web-researcher, etc.). Each is
  self-contained with its own `agent.ts` and optional `client.tsx`.
  `scaffold/` has base project files (package.json, tsconfig,
  etc.) layered underneath.

  **They ship inside the `@alexkroman1/aai-cli` tarball**, copied into its
  `dist/` at build time by `aai-cli/bundle-templates.mjs` — the sources stay
  in `aai-templates`, which still owns their tests, typecheck, and lint;
  this is packaging, not a move. `aai init` used to fetch them at run time
  with giget (`github:alexkroman/agent/packages/aai-templates#main`), which
  required a network for every init and pinned templates to `main`
  regardless of the CLI version installed, so a template written against a
  newer SDK could land in a project resolving an older one. Two consequences
  worth knowing:
  - `packages/aai-cli/turbo.json` adds the template sources to the build's
    `inputs`. They live in another package, so the root task's
    package-relative globs cannot see them — without the override, editing a
    template replays a cached CLI build that predates it.
  - Nothing running in-tree can exercise the shipped path: `getMonorepoRoot()`
    keys off the module's own location, so a CLI built at
    `packages/aai-cli/dist` always finds the workspace root and takes the
    monorepo branch. The e2e suite's `detachedCli()` copies `dist/` somewhere
    with no `pnpm-workspace.yaml` above it for that reason, and `aaiEnv()`
    deliberately sets no `AAI_TEMPLATES_DIR` — that override used to pin
    every e2e run to the workspace sources.

## The scaffold is LINTED, and the exclusion that hid it

`biome.json`'s `files.includes` used to carry a negated scaffold glob, so every
file `aai init` copies into a user's project was checked by nothing — not the
per-package `biome check .`, not `pnpm lint`, not CI. It was never argued for:
the entry arrived with the whole config file (#1159) under no comment, and the
scaffold is the LAST tree in the repo that should go unchecked, being the only
one that lands in somebody else's project.

**It cost a real bug, and a gate that scans the whole tree is what found it.**
`scaffold/server.mjs` registered its `SIGINT`/`SIGTERM` handler as an `async`
listener, so a rejecting `server.close()` became an unhandled rejection — a
stack trace and a nonzero exit on Ctrl-C, in every project ever scaffolded.
`guard-invariants` rule 23 caught it because that gate walks `packages/`
directly; Biome's own `noMisusedPromises`, which is on and would have flagged it,
had been told not to look.

**Removing the exclusion cost one import-order fix** in `vite.config.ts` — six
code files checked, nothing else to report. `noUndeclaredDependencies` in
particular does NOT fire here, because the scaffold ships its own
`package.json` declaring what it imports; that is the objection this exclusion
looked like it existed for, and it does not hold.

`templates.test.ts` asserts the exclusion stays gone, in BOTH directions (no
negated scaffold glob, and `packages/**` still present to pull it in). That is
the same argument as every other assertion in that file: the failure mode here
makes the linter QUIETER, so nothing goes red and the loss is invisible in a
diff. A/B'd against the re-added exclusion before landing, per the non-vacuity
rule the gate specs carry.

## `check:scaffold` exists because the sync ran only during a release

`scripts/sync-scaffold-versions.mjs --check` asserts `scaffold/package.json`
still matches the workspace, and it was enforced by nothing until it broke. The
script ran only from `version`, unchecked, DURING a release — and the catalog
migration had left it copying the literal `"catalog:"` there, having read a
range out of a package.json without resolving it. npm has no such protocol, so
the next release would have shipped a scaffold that cannot install and
`aai init` would have failed at its own install step.

`check:publish-protocols` cannot see this: it PACKS the three publishable
packages and reads the manifest pnpm rewrote, and this file is DATA inside the
aai-cli tarball, not a manifest pnpm packs. The script resolves the catalog now
and, separately, refuses any workspace protocol left in the shipped manifest —
`sharedDepSources` is hand-kept, so a dependency outside it is synced by nothing
and caught by nothing.

## The scaffold pins `^<newest>`, so it must opt out of release-age quarantine

`scripts/sync-scaffold-versions.mjs` resyncs `scaffold/package.json` to the
workspace versions on every `changeset version`, so a scaffolded project always
asks for the SDK release that was just cut. That is correct — the templates are
written against it — but it collides with pnpm's `minimumReleaseAge`, which
holds a version back until it has been on the registry for N minutes (pnpm 11
turns it on by default; an org config can set it far higher). Because this repo
publishes several times a day, EVERY version satisfying `^<newest>` is inside
the window, there is nothing older to fall back to, and `aai init` dies at its
own install step with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. Lowering the pin
does not help: the floor has to admit the build the templates need.

`scaffold/pnpm-workspace.yaml` therefore ships
`minimumReleaseAgeExclude: ["@alexkroman1/*"]` — scoped to our own packages, not
`minimumReleaseAge: 0`, so a user's window still covers every third-party
dependency. `templates.test.ts` pins both that key and the
`onlyBuiltDependencies`/`allowBuilds` pair beside it, because **every setting in
that file fails only on a user's machine**: pnpm ignores unknown keys silently,
so a rename or a dropped line is invisible in-tree. Reproduce either failure by
copying `scaffold/` to a temp dir, appending `minimumReleaseAge: 10080`, and
running `pnpm install --lockfile-only`.

Do not confuse this with a stale metadata cache, which fails the same command
with a different error: plain `ERR_PNPM_NO_MATCHING_VERSION` and a
`The latest release … is "X"` line naming a version older than the pin. That one
is client-side (`pnpm cache delete "@alexkroman1/*"`), not ours — the quarantine
error always names the constraint or carries a `published by <date>` clause.

## Declare a stateful tool THROUGH the slot, and a read helper as `DeepReadonly`

Two rules that a sweep found broken in five templates at once, both of which are
now compile errors rather than advice.

**A tool that touches session state is `slot.tool` or `slot.updateTool`, never
a `tool()` that opens with `slot.get(ctx)`.** The declaration is what makes
"does this write?" visible, and what makes the wrong answer a compile error
instead of a `TypeError` on the first call. Three shipped tools had it wrong and
none of them could ever have worked: `infocom-adventure`'s `game_state_take` and
`game_state_flag` were declared `slot.tool` while pushing to `inventory` and
writing into `flags`, and `solo-rpg`'s `oracle` assigned `game.chaosFactor`
under a comment claiming `gameSlot.get` returned "the live state object", which
described the removed `ctx.state` bag. Nothing in the repo executed any of them
(`infocom-adventure` had no spec at all; `agent.test.ts` never reached
`oracle`), which is the other half of the lesson — a template's spec is what
makes its exemplar code true.

The mixed case is real and has one answer: a tool where only ONE branch writes
stays an ordinary `tool()` and calls `slot.update` inside that branch —
`oracle`'s `chaos_check` is the worked example. `updateTool` would open a
mutation window on the four branches that store nothing, and its body must be
synchronous, which `tool()` bodies routinely are not.

**A derived field belongs in the slot's `after` hook, and a tool that REPORTS it
needs a PREDICATE.** `dispatch-center`'s board declared
`after: (state) => { pruneState; recalculateAlertLevel }`; `solo-rpg` matches it
now, its `updateCrisisFlags` having been called by hand from three mutating
tools. Moving it is not a straight lift, and the reason generalizes:
**`update()` runs `mutate(draft)` and only THEN `after(draft)`**, so a result
object built inside the body carries the value the field had BEFORE the
recalculation. Three solo-rpg tools report `gameOver` in the same call that
empties the track and one turns it straight into `sendFrom`'s `DOWNED`, so a
naive move ended the story a tool call late, silently. What works is a
predicate beside the writer (`isGameOver`/`inCrisis`) with `after` owning the
WRITE: the rule is stated once, no mutating tool can store a stale flag, and a
body that must report the fact reads the predicate.

**A pure helper over slot state takes `DeepReadonly<T>`, and each template
aliases that once.** `slot.get` and `slot.tool` hand out a DEEP readonly value
matching what `freezeStorable` really does, and TypeScript does not ignore
readonly on ARRAYS — so `readonly string[]` stops satisfying `string[]` and the
widening propagates into every projection, view and summary helper the template
declares. `FrozenDispatchState`, `FrozenTripState`, `FrozenPlanState`,
`FrozenRetailState`, `FrozenSupportState`, `FrozenGameState` and
`FrozenOrderState` are that alias, one per template, each with the same note:
a mutable value still satisfies it, so an `updateTool` draft passes unchanged,
while a helper that WOULD have mutated stops compiling. Two shapes to copy when
the widening gets awkward — `dispatch-center`'s `findIncident` is GENERIC over
the incident's own type so one lookup serves the draft and the frozen value
alike, and `resourceBrief` COPIES the array it puts in a fresh result object
rather than aliasing a frozen one.

The client half is the same rule one hop out: `solo-rpg` renders
`DeepReadonly<GameState>` because that is what `gameSlot.projection((g) => g)`
produces, and a client only ever renders what the server pushed.

## The templates are where SDK primitives get their worked example

`template-api-coverage.test.ts` already enforces the direction "every public
export is exercised by a template". The converse is the rule to apply while
EDITING one: when the same helper appears in a third template, that is the
signal to extract it into the SDK rather than copy it again. Five came out at
once, and the templates are now their reference use:

| Primitive | Demonstrated by |
| --- | --- |
| `sessionSlot()` | every stateful template — `pizza-ordering` (smallest), `retail` (slot in `store.ts`, view in `shared.ts`, so the seed stays out of the browser bundle) |
| `slot.projection(view)` as `syncState` | `pizza-ordering`, `dispatch-center`, `retail`; `solo-rpg` projects the identity (`(game) => game`). Six templates now export the composed projection from the module that declares the slot and import it at BOTH ends — see `useAgentState(projection)` below |
| `slot.update` (the synchronous draft) | `dispatch-center` (every mutating tool, plus an `after` hook that prunes and recalculates the alert level), `plan-and-execute` (`work_next_step` CLAIMS its step inside one window, then awaits outside it — the shape to copy when a body needs a model call) |
| `slot.updateTool` (the mutating half) | `retail` — every one of its fifteen tools, through `retailTool`, which is what a per-agent wrapper on top of it looks like: the wrapper owns the auth gate and the activity log, and passes the DRAFT to the tool body rather than letting it re-read the slot |
| `slot.tool` (the reading half) | `pizza-ordering` (`view_order`), `travel-concierge` (`lookup_booking`), `infocom-adventure`, `solo-rpg` (`check_state`, and `save_game` — an async body is fine, only `updateTool` must be synchronous), `dispatch-center` (`incident_get`, `ops_dashboard`, `resources_get_available`) — and choosing wrong is loud, since what a read is handed is frozen |
| `ctx.generate` with a `schema` | `support-line` (five graders and a rewriter over one binary-score schema), `plan-and-execute` (planner, executor and replanner). `travel-concierge` deliberately uses none — its specialists are prompts, not models |
| `ToolFailure` / `isToolFailure` | `retail` (~40 sites, failures propagating through `store.ts` helpers), `dispatch-center` (six) |
| `pushCapped` | `dispatch-center` (incident timeline), `retail` (activity feed), `solo-rpg` (session log), `infocom-adventure` (command history) |
| `createToolContext` (`@alexkroman1/aai/testing`) | the four suites that test tools directly — `dispatch-center`, `pizza-ordering`, `retail`, `solo-rpg`. It admits an explicit `undefined` per field now, so the `...(x ? { x } : {})` two specs wrote around an optional `sessionId` — rule 22's shape — is gone |
| `ok` / `okPosition`, `parseToolInput` / `parseSchemaInput` (`@alexkroman1/aai/testing`) | the unwrap five specs wrote, and the `["~standard"].validate` reach 18 sites across ten templates re-derived. `travel-concierge` and `plan-and-execute` had read gated results through `(await run(…)) as { result: {…} }`, so a REFUSAL read `undefined` off the cast and died three assertions later; `ok` fails at the CALL, quoting what the flow refused |
| `installStubStepFetch` (`@alexkroman1/aai/testing/vitest`) | every workflow spec. `recap-workflow`'s used to publish over `globalThis.fetch` while every request in that file goes through `stepFetch`, so ~20 tests were green against `step-fetch.ts`'s unpublished-slot FALLBACK — a path production never takes. `link-digest/agent.test.ts` states the rule its sibling broke |
| `stubTranscribe` (`@alexkroman1/aai/testing`) | the three transcribing templates, which had each re-typed the wire; `transcription-workflow` had ended up asserting the SDK's own `Authorization` header and multipart boundary. Two SDK-contract specs stay there (`speech_models` plural, the file is STREAMED), both out of a live production failure that template's doc narrates |
| `useAgentState(projection)` | `pizza-ordering`, `dispatch-center`, `plan-and-execute`, `solo-rpg`, `support-line`, `travel-concierge`, `night-owl` — the seven that pass the projection itself, so nothing restates the type and nothing derives the empty frame. `night-owl` is also the one showing a slot BESIDE `useEvent`/`useToolCallStart`; the rule separating them is in `packages/aai-ui/CLAUDE.md` |
| `useAgentState(fallback)` | `retail` ONLY, and deliberately: the projection overload calls the slot's `create()`, whose factory pulls a 107 KB `seed.json`, so passing it would ship the catalog to the browser (see below) |
| `AutoScroll` | the three custom-chrome clients — `dispatch-center`, `retail`, `infocom-adventure` |
| `useUserTranscript` | the same three. Each had written `userTranscript !== null && (… === "" ? "…" : …)` by hand, re-deriving a PROTOCOL distinction (`null` is silence, `""` is speech detected with no words yet) from the type |
| `WorkflowProgress` | `transcription-workflow` and `redline` render a run's WHOLE narration; `link-digest` and `podcast-digest` pass `lines={1}` for the newest one, deleting two hand-rolled versions. `WORKFLOW_STATUS_LABELS` replaced two byte-identical status maps the same way |
| `useDownloadUrl` (`@alexkroman1/aai-ui`) | `spoken-summary` and `call-audit`, the two that exist BECAUSE of the audio round trip and had copied the 38-line object-URL lifecycle byte-for-byte |
| `resolveOne` + `spokenDigits` (`@alexkroman1/aai`) | `retail` — `resolve.ts`, both halves: an order picked out of the caller's own orders, and a variant picked by the options they named. What stayed there is the store's vocabulary (what an order id looks like, which words name a status); what moved is the never-guess contract |
| `dialog()` + `dialog.tool` + `dialog.send` | six templates, and the split between them is the lesson — see "A flow is WHERE A CONVERSATION IS" below. `travel-concierge` (the confirmation gate, two states), `plan-and-execute` (a plan's lifecycle, three), `retail` (a call's, nested, ending in a TERMINAL state), `solo-rpg` (nested, and a final one), `dispatch-center` (nested, and the one whose position is deliberately NOT per-entity) |
| `procedure()` | `support-line` — the CRAG loop, driven to completion inside one tool call with `ctx.signal` |
| `subagent()` + `ctx.delegate` | `briefing-desk` ONLY, and it exists for this — see below. Two subagents with different tool surfaces, models and budgets; the researcher fanned out one run per angle with `Promise.allSettled`. `stubDelegate` drives its spec, routed by subagent name |
| `workflow()` + `ctx.workflows` + `isTerminal` | `research-workflow` — the handoff: a VOICE template whose tool starts a run, correlates it with `key`, and reads it back (see below); `recap-workflow` is the same shape with `cancel` and a live-run check on top |
| `page()` + `useWorkflowSubmit` | `link-digest` — the WORKFLOW APP whose FORM is still hand-written and its own `useState`, which is the point of it and what its module doc now says specifically. **`useWorkflowRun` is exercised by no template at all** since `link-digest` and `podcast-digest` moved to `useWorkflowSubmit`; it is an allowlist entry, and see "The last remover pays" below |
| `Form` + `WorkflowFields` + `useWorkflowSubmit` | `transcription-workflow` — the same front door with the form layer, plus `WorkflowOutputOf`. Its form is ALL declared, so `FileField` is exercised by no template and sits in the allowlist |
| `TextAreaField` beside `<WorkflowFields>` | `redline` — the MIXED form: three scalars declared by the schema, one array field written by hand in the same `<Form>` and mapped on submit. The case "Forms" in `packages/aai-ui/CLAUDE.md` describes, which no template used to exercise |
| `toStepError` / `throwStepError` / `throwFatalStepError` (`@alexkroman1/aai/step-errors`) | every workflow template — `transcription-workflow` and `link-digest` for the HTTP classification each had hand-written identically, `research-workflow`/`link-digest`/`redline` for the `.catch(throwStepError)` on a model call, `transcription-workflow` for the two `catch`-block fatals, `recap-workflow` for both halves of a provider call it also polls, `podcast-digest` for `sendToChannelClassified` (the 4xx `FatalError` its Slack step used to raise by hand, from a body it had read itself) |
| `stepFetchOk` (`@alexkroman1/aai/step-errors`) | `link-digest`, `recap-workflow`'s `request()` and `podcast-digest`'s `fetchText` — the THIRD copy is what extracted it, on the rule below. Each had written `stepFetch` + `if (!res.ok) throw toStepError(…)`, and each threw the response BODY away, so a 4xx that said what was wrong arrived as a number. The one place that stays on raw `stepFetch` is `recap-workflow`'s DELETE, where a 404 means already-deleted. `podcast-digest`'s Slack post was the other, and it is not a template concern any more — see the `channels` row |
| `stepGenerateJson` + `stripJsonFence` | `research-workflow` (five stages, each with its own zod shape — including the LENIENT ones that replace its hand-rolled `strings()`/`isSource()` coercion), `link-digest` (one), `redline` (the critic's findings) and `recap-workflow` (the recap, whose `spoken` field is required rather than defaulted because the announced turn has nothing to read without it). `stripJsonFence` is exercised only through `stepGenerateJson`, which is the intended path |
| `installStubGateway` (`@alexkroman1/aai/testing/vitest`) | the `research-workflow`, `link-digest`, `redline` and `recap-workflow` specs — the bare `stubGateway` under it is exercised by no template and nothing records that, `/testing` being outside the coverage gate's scope (see the STEP row below) — the QUEUE form in the first and last, because their model calls sit in a loop or a chain, and the single-reply form in `link-digest`. The four had written the same five-line `vi.stubGlobal` wrapper, comment included |
| `toolOf` / `runTool` / `toolRunner` (`@alexkroman1/aai/testing`) | the TEN specs driving tools through the agent's own table, each opening `const run = toolRunner(agentDef);`. `args` and `ctx` are both optional (66 `{}` placeholders are gone). **The advice that sat here — write the NARROWEST wrapper your specs need — is RETIRED: it is what produced the drift**, measured on `toolRunner` |
| `withDiscoveredTools` (`@alexkroman1/aai/testing`) | the same four plus `retail` — the five whose tools are FILES, so `def.tools` is empty until something resolves `tools/`. See "A `tools/` file IS the tool" below for why the glob is written per template |
| `stubGenerate` (`@alexkroman1/aai/testing`) | `support-line` (five nodes over one binary-score schema) and `plan-and-execute` (planner, executor, replanner) — the two whose tools reason with a model. Both had hand-rolled a `GenerateFn` switching on `options.system`, and both carried the same comment about the schema overload's required `object` |
| `createRunSnapshot` + `createProgressStream` (`@alexkroman1/aai/testing`) | `research-workflow` and `recap-workflow` — the fixtures behind their `stubWorkflows`. The snapshot builder is the one that mattered: both hand-rolled versions ended in `as WorkflowRunSnapshot` |
| `mockWorkflows` (`@alexkroman1/aai/testing/vitest`) | the same two, and it IS their `stubWorkflows` — fifteen lines apiece, byte-identical apart from the name in `listing`, now one line each. On `/vitest` because `vi.fn` is its CONTENT |
| `mapConcurrent`, `emit`, `stepEnv` / `requireStepEnv`, `stepGenerate`, `stepFetch` / `multipartBody` | the STEP surface, and every workflow template uses it: `transcription-workflow` fans its segments out with `stepFetch` + `multipartBody` and reads `ASSEMBLYAI_API_KEY` for the sync STT endpoint, `recap-workflow` makes all three of its batch-API calls through `stepFetch` (it POLLS, so one run is many requests); `research-workflow`, `link-digest`, `redline` and `recap-workflow` call the model with `stepGenerate` (or `stepGenerateJson`, for a reply that has to be a shape), and `recap-workflow` reads the same key for the batch transcription endpoint it polls. Imported from `@alexkroman1/aai/step`, NOT the root: a `workflows/*.ts` module is bundled separately by the WDK builder, so the root barrel's graph would ride into the step bundle. That subpath is outside the coverage gate entirely — `SCOPED_MODULES` is the `aai` root plus `stt`/`tts`/`llm`/`s2s` and the `aai-ui` root — so a step export nothing exercised is caught by no gate and has no allowlist entry to sit in |
| `webSearch` / `visitWebpage` (`@alexkroman1/aai/tools`) | `research-workflow`, from inside a `"use step"` function — the demonstration that a step is not a lesser environment than a tool body; `plan-and-execute`, from an ordinary tool body, which is the case the module was published for |
| `stepSpeak` + `writeUpload` + `WorkflowApi.download` | `spoken-summary` ONLY, and it is the whole reason that template exists — the audio round trip a workflow could not make before. See "A step that SPEAKS returns an id" below |
| `stepTranscribeUpload` / `Submit` / `Poll`, and `stepTranscribeSync` | all three templates that transcribe, and the clearest case yet of the extract-on-the-third-copy rule above — `spoken-summary` and `transcription-workflow` had the async API's ~200 lines EACH, reworded and identical in behaviour, and `recap-workflow` a third variant. `transcription-workflow` is the reference for both halves (`batch.ts` for the job API, `sync-api.ts` for the one-request endpoint it fans out over); `recap-workflow` converts its SUBMIT only, and says in place why its poll must not follow — see "A transcription step is the SDK's; the boundaries are the template's" below |
| `runFfmpeg` / `probeMedia` / `wavEncodeArgs` (`@alexkroman1/aai/ffmpeg`) | `call-audit` — five invocations, every argv built by a pure function in `workflows/media.ts`; `transcription-workflow`'s `normalize.ts` for the smallest possible use (probe, convert, store). See "ffmpeg is what lets a desk cut a recording where a HUMAN would" below |
| `encodeWav` + `pcmDurationMs` (`@alexkroman1/aai/step`) | `call-audit` — the pair that makes a headerless intermediate workable: the store holds raw PCM so a byte offset is a timestamp, and each span gets a header back for the one request that needs one. `transcription-workflow` had 31 lines of `DataView` writes in a `wavWithHeader` that turned out to be `encodeWav` with the arguments swapped — `WavFormat` is structurally a `PcmFormat` — and now calls it |
| `throwFfmpegStepError` (`@alexkroman1/aai/step-errors`) | `call-audit` and `transcription-workflow`. **Nothing in a template names `isFfmpegError` or `FfmpegError` any more**, so both sit in `template-api-allowlist.json` deliberately: the SDK recognises the error STRUCTURALLY and makes the `exit`/`missing-binary` → fatal, `timeout`/`aborted` → retry call itself. Its inverted default is pinned in `sdk/step-errors.test.ts`, including `call-audit`'s case: a cause that is not an ffmpeg failure at all is fatal |
| `withTempDir` / `readUploadToFile` / `writeUploadFromFile` (`@alexkroman1/aai/step-files`) | `call-audit` and `transcription-workflow`, which between them had written the temp dir, the windowed read and the `.slice()`-ing generator FOUR times, with an identical warning that the `.slice()` was load-bearing. `temp-media.ts` (138 lines) is gone |
| `formatBytes` / `formatDuration` / `countWords` / `plural` (`@alexkroman1/aai/utils`) | seven templates, on BOTH sides of the bundle boundary — a step's `report()` and the page rendering the same run. They existed 4, 5, 4 and 17 times, and the duplication was a live bug: `call-audit` printed one recording as `1:04:09` from `workflows/media.ts` and `64:09` from `client.tsx`, and `transcription-workflow` had three copies of the same disagreement — one inside `workflows/stitch.ts`, the module that exists so the run and the page cannot drift |
| `slack` / `sendToChannel` (`@alexkroman1/aai/channels`) | `podcast-digest`, which is where the concept came from. It carried the whole third-party contract — Slack's two webhook URLs and the branch between them, Block Kit assembly, mrkdwn escaping, the 4xx/5xx split and the advice each refusal deserves — and every one of those rules is about SLACK rather than about podcasts. What is left in `workflows/slack.ts` is the digest as a `ChannelMessage` and the `"use step"` wrapper, which stays because the DevKit's builder only rewrites bodies it finds in a project's `workflows/` directory. `isSlackWebhookUrl` is imported by `agent.ts` for the same schema refinement as before |
| `decodeHtmlEntities` (`@alexkroman1/aai/utils`) | `link-digest` (as `decodeEntities`) and `podcast-digest` (as `decodeXml`) — one byte-identical body under two names, each arguing for the ORDERING in its own comment, which is the tell that the ordering was the whole function. Tag stripping did NOT move |
| `WorkflowInputOf` / `WorkflowRunOf` / `lastLine` | `podcast-digest`, `call-audit` and `spoken-summary` for the input type (see below — it obliges an annotation on the def); `research-workflow` and `recap-workflow` for the other two, each dropping an eight-line `streamTail`-then-`stream` dance and the comment warning that reading a stream with nothing in it waits forever |
| `stubSpeech` + `stubUploads(…, { writable: true })` (`@alexkroman1/aai/testing`) | `spoken-summary`'s spec, the pair's only use: a step that speaks and stores needs both slots filled, and the write half is opt-in so a step that stored a file nobody meant it to still fails. `stubUploads` answers `{ restore, writes, read }`, so a write is assertable without round-tripping through the seam that wrote it |

**The last remover pays.** A cross-template migration moves the allowlist in a
way no single diff shows — `ChatMessage`, `useUserTranscript` and `useTheme`
were each exercised by exactly three clients, and three agents converting three
chromes in parallel each removed one. The last removal of an export's only
examples owes an allowlist entry or a retained example, and only whoever lands
last can see it is owed.

## `briefing-desk` is where a subagent has to earn its latency

The desk has NO web tools. Everything it knows comes back from a `ctx.delegate`
run started inside a tool call, and the template is arranged so the three
reasons to pay for that are each visible in one place:

- **A context window the caller does not pay for.** A researcher reads whole
  pages; what crosses back is its final paragraph, because that is all
  `DelegateResult.text` is. `web-researcher` is the counter-example to compare
  it against — search builtins on the agent ITSELF, which is right for one
  lookup and wrong the moment a question has four sides.
- **Parallelism.** `tools/research_topic.ts` fans every angle out at once, so
  the caller waits for the slowest rather than the sum. `allSettled`, not
  `all`: a caller on the phone would rather hear three angles and an apology
  than an error, and the spec asserts exactly that.
- **Tools isolated by capability.** `researcher` searches AND browses on six
  steps; `factChecker` only searches, on two, on a cheaper model. A capability
  a run does not need is one it cannot misuse.

Two things the template states in place because they are the ways a subagent
disappoints. Its instructions END with "your final message is the only thing
the desk receives" — a run that signs off with "Done." has thrown away
everything it read, and no budget recovers it. And every angle is written as a
COMPLETE brief: a subagent has not heard the call, so "the same but for Europe"
is not an angle. `angleBrief()` is where the one line of conversation it does
get is decided.

Its spec runs no model. `stubDelegate` answers by subagent NAME, which is what
tells a research run from a check; a subagent's own tools are ordinary `tool()`
defs and are tested with an ordinary `createToolContext()`.

## A flow is WHERE A CONVERSATION IS, and a board is not one

Five templates declare a `dialog()`, and the interesting one is the template that
almost could not. `dispatch-center` holds many incidents at once and a flow is
bound to a session, so it has exactly ONE position — and the first instinct, a
machine per incident over `Incident.status`, is not available at all.

**The resolution is that a position is a fact about the CONVERSATION, not about
the world.** `working.monitoring` there means "the incident this dispatcher last
touched has units on it", never "every incident does"; per-incident status stays
on `Incident.status` and every gated tool stays addressed by id. What its six
gated tools actually need is one bit — "has anything been logged this shift" — so
they gate on the PARENT state, and the three children exist to carry the
instruction for the step in front of the dispatcher. Do not read a position as a
summary of the data, and do not reach for a flow when the thing to constrain is
per-entity; a `ToolFailure` from a data lookup is what that is for. Read the
other four in this order: `travel-concierge` (two states, one gate),
`plan-and-execute` (three, a lifecycle), `retail` (a call ending in a TERMINAL
state, with a confirmation gate nested inside it), `solo-rpg` (nested, plus a
`final` one).

Four rules came out of converting `dispatch-center`, `retail` and `solo-rpg`,
each a trap rather than a preference:

- **A tool legal in EVERY state is not a flow tool.** `when` is required, so an
  ungated one would list every state — a gate that gates nothing, paying the
  wrapper for it. It stays an ordinary `tool()`/`slot.updateTool` and calls
  `dialog.send` itself, which is what that method is public for
  (`incident_create`, `setup_character`, `load_game`, `start_plan`). Each still
  reports the position it landed in: the READOUT is most of the value and needs
  no gate.
- **`sendFrom` goes BELOW `execute`** — the rule SHRANK with `NoInfer` rather
  than going away; the section of that name below has the A/B. It is also the
  field for "did this actually do the thing": `resources_dispatch` sends nothing
  when every requested callsign was busy.
- **A `final` state delivers no events, so restarting is `dialog.reset`.** An `on:
  { SETUP }` on `solo-rpg`'s `gameOver` was dead config that read as live, caught
  by a test asserting the POSITION rather than a refusal. Resetting is the honest
  mirror anyway — `setup_character` replaces the campaign with a pristine
  default, so it replaces the position too.
- **A refusal short-circuits before the tool's own body, bookkeeping included.**
  `retail`'s wrapper logs an activity entry and bumps `callSeq` on every call, and
  a gated refusal no longer reaches it — so a blocked call stopped appearing in
  the sidebar. Stated where the wrapper is, because the natural reading of a
  missing line is a bug. It is the right trade (the refusal reaches the MODEL,
  which a sidebar line never did) and it is a trade.

### A `sendFrom` goes BELOW `execute`

`dialog.test-d.ts` pins that a `sendFrom` written ABOVE `execute` sees the
success type, and **that holds only for the non-context-sensitive `execute` the
type test uses**, a reference to an annotated function. Every real tool body is
an inline arrow whose parameters are contextually typed, so its return type is
inferred in a LATER pass than `sendFrom`'s signature is checked: A/B'd on
`dispatch-center/tools/resources_dispatch.ts`, where moving `sendFrom` above the
inline `execute` still gives `TS18046: 'result' is of type 'unknown'`. The
mutually-dependent case is worse — where the body ends in a generic call the
outer inference must resolve first (`planSlot.update(ctx, …)`, i.e. `update<R>`)
TypeScript gives up and `R` lands as `unknown` with NO error at the declaration,
reproduced both ways in `plan-and-execute`, whose two tools declare `sendFrom`
last and say why.

So the rule SHRANK rather than going away: **declare `sendFrom` after
`execute`; if you do not, you now get an error instead of silence.** Do not
write "the order no longer matters". What changed is that the absorbing guards
can go — an `"x" in result &&` test, an `isToolFailure(result) ? … : …` ternary
in every `summary` — which compiled against `unknown` and meant nothing, and
which the three deleted ordering warnings existed to explain.

**A per-agent wrapper must copy the SDK's own signature, not its `Exclude`.**
`retail`'s `RetailToolSpec` typed `execute: (…) => R`, so `R` absorbed the
failure arm and all nineteen tools wrote a ternary for a case the wrapper never
passed them. `Exclude<NoInfer<R>, ToolFailure>` does NOT fix that: `Exclude`
over a NON-NAKED type parameter is not distributive, returning the union
unchanged. What subtracts the failure arm is declaring
`execute: (…) => R | ToolFailure` and letting UNION INFERENCE match it off,
`NoInfer` only holding the second position; `summary` then takes `NoInfer<R>`.

**And `sendFrom` reads one field across a UNION, so every arm must have it.**
TypeScript gives fresh object literals in ONE group the others' keys as
`?: never`; a return through a declared type, or an already-normalized inner
union such as a `slot.update` callback's, is a separate constituent and gains
nothing. Deleting `plan-and-execute`'s `StepOutcome` hit that — the fix is
`response: undefined` at the one early return, not concluding the annotation was
load-bearing.

### A dialog is a plain state map now

Every flow template dropped `setup({ types: … })`, its `xstate` import and every
`meta: { instruction }` wrapper; `type: "final"` is `final: true`, and the
persisted snapshot is unchanged (every flow suite passed untouched,
`solo-rpg`'s save/load round trip included). One conversion rule: **the spec
goes in `as const`** — the event union is synthesized from the `on` keys, so
widening them to `string` gives `send` nothing to check against.
`packages/aai/CLAUDE.md` has why it is worth converting a dialog that worked.

**An ungated tool reports its position by SPREADING it.** A gated tool's result
carries `{ state, done, instruction? }` because the SDK writes it; three
templates had each RENAMED those fields on the way out (`at`, `next`,
`storyOver`), so within one agent the model read its own position under two key
sets depending on which tool it called. `dialog.send` and `dialog.position`
already return a `DialogPosition` of the right shape, so the fix is a spread —
`return { incidentId: id, ...callFlow.send(ctx, { type: "LOGGED" }) }`, five
sites. `solo-rpg`'s prompt had asserted the invariant "every other tool answers
with the same pair" while three of its tools did not.

**Three things a flow deleted outright, and all three were dead guarantees.**
`retail`'s policy said to say one sentence after `transfer_to_human_agents` "and
nothing else", enforced by nothing — every tool stayed callable, so a model that
kept going kept acting on a call it had given away. Its "confirm every change
out loud … never act on an implied yes" was carried by nothing too, and cost
more to fix than one line — see below. `solo-rpg`'s `gameOver` was written
by `updateCrisisFlags` and read by nobody who could act on it, so a player with
both tracks empty could roll forever. A terminal state is one line of config for
each. `solo-rpg` also lost a FIELD: `phase: "genre" | "playing"` was
`initialized` spelled twice and neither gated anything.

**A spec is what makes the gate true.** Each of the three drives its gated tools
through `ok`/`okPosition` (`@alexkroman1/aai/testing`) — the unwrap four template
specs had written byte-identically, and the reason each conversion cost two lines
rather than twenty-four. Pin the POSITION as well
as the refusal: that a tool refuses in the wrong state is half of it, and that
the position moved (and did NOT move on a failure) is the half a dead transition
hides in.

### A rule the model can skip is not a rule: `retail`'s confirmation gate

`retail` is the worked example of the expensive case, where a prose rule and the
tool surface disagree. "Confirm every change out loud … never act on an implied
yes" was in the prompt and in seven tool descriptions, and
`cancel_pending_order` cancelled and refunded on its first call regardless — a
`grep` for "confirm" over its source returned nothing. Three things, in order:

- **Nothing mutates.** The seven changing tools became STAGERS: each validates,
  prices, writes a `PendingAction` and returns the sentence to read back.
  `confirm_change` is the only tool in the template that writes to the store;
  `cancel_change` drops a staged change unconditionally.
- **`serving` grew two children** (`helping`, `awaitingConfirmation`).
  `confirm_change` is gated on the second, reachable ONLY by staging, so
  confirming what nobody staged is refused before the body runs. `when:
  "serving"` matches both children, which keeps a read and a transfer legal
  while a change waits — "what was the total again?", or asking for a human.
- **`IDENTIFIED` came OFF `serving`.** It was there so a caller repeating their
  email did not error. With children, that self-transition RE-ENTERS and resets
  to `helping`, stranding the change `state.pending` still holds — the one way
  the position and the store could disagree. An unhandled event is ignored,
  which was the behaviour wanted all along.

**Validate at STAGE time, not at confirm time.** `travel-concierge` re-derives
its effect in `confirm_action`; `retail` computes each plan once and every
`apply*` is total, because a "yes" followed by a refusal is the exact sequence
the gate exists to prevent. Hence plans of ids and amounts rather than the
`Order`/`Variant` references their in-tool-call ancestor held: those alias the
store, and a persisted session could not carry them.

**And the tool set stopped being tau2's** — fifteen names `registry.test.ts`
pinned as a fidelity claim; the gate needs seventeen. Two improvements the
fidelity was holding back came with it: `exchange_items`/`exchange_new_items`
hold the PAIRING that was priced rather than two independently sorted sets
(which read as espresso -> sneaker if anything treated them as one), and
`return_items` keeps the order the caller named. Check what a fidelity
constraint COSTS before treating it as fixed.

## A run can be the SCHEDULE

`podcast-digest` is the only template whose run is periodic, and it is worth
reading for that one property rather than for podcasts. It watches some feeds,
transcribes what is new, summarizes it, posts a Slack digest — and then
`sleep`s and does it again, for as many digests as it was asked for.

There is **no cron anywhere in it**. A durable `sleep()` inside the body IS the
scheduler: the run suspends, nothing is resident, nothing is billed, and the
platform brings it back days later. That makes a recurring job something a
template can demonstrate in forty lines with no infrastructure behind it, and it
is the cheapest correct answer to "run this every morning" on this platform.

Three consequences the template states in place, because each is a trap:

- **Storage stops being optional.** Every other template treats the database as
  a durability upgrade you can defer. A multi-day sleep does not survive in
  process memory, so without it the first digest arrives and the second never
  does — a failure with no error attached. Build it on `intervalUnit: "minutes"`
  and it works either way, which is exactly what hides the problem.
- **A run is asked when to STOP.** `daysToRun` is an input rather than a
  constant: a run that repeats forever is a resource nobody can see and nobody
  remembers to cancel. Its page pairs `cancel` with `wake`, which is the other
  half — a sleeping run needs "send it now" to be a different button from
  "throw it away".
- **Batch polling is not the single-transcript loop.** `spoken-summary` and
  `transcription-workflow` wait for ONE transcript, so their body is
  `for (…) { if (done) return; await sleep(…) }`. Here N episodes finish out of
  order, so the loop carries a SHRINKING pending set and lets finished episodes
  drop out — otherwise the whole digest waits on its slowest episode. One that
  never finishes degrades to a stated reason in the digest rather than failing
  the run, because a partial digest beats none.

It is also the template that shows what a scaffolded project may DEPEND on. The
studio app it came from imported `spotify-uri` and `@extractus/feed-extractor`;
neither is in `scaffold/package.json`, so neither could ship. The first became
six lines of `URL` parsing and the second was already dead code. A template may
import the SDK, `workflow`, `zod` and React — anything else has to earn a place
in the scaffold manifest first, or the starter fails to build the moment
somebody runs it.

## A step that SPEAKS returns an id

`spoken-summary` is the audio round trip — upload a recording, get back a
summary you can read AND one you can listen to — and it is the reference use of
three SDK additions that only make sense together. It is worth reading against
`transcription-workflow`, which owns the way IN (uploads, and what it costs to
cut a long recording up) and stops at text.

```text
   a WAV  →  transcript  →  summary  →  a WAV of the summary
              async STT     LLM Gateway   streaming TTS
```

The first three arrows are ordinary step work. The fourth needed the SDK to
grow, twice:

- **`stepSpeak`** synthesizes from inside a step. The session TTS surface cannot
  be used there at all — a `TtsSession` is an event stream wired into a live
  pipeline's playback, with a turn tracker and barge-in behind it, and a step has
  no turn to be part of and has to return a VALUE. `sdk/step-speak.ts` and
  `host/step-speak.ts` carry the argument, including why the one-socket exchange
  reuses nothing from the session opener.
- **`writeUpload`** is `readUpload`'s other direction. A run's OUTPUT is read
  back as JSON, so audio cannot travel in one — the same rule that keeps a
  recording's bytes out of a run's INPUT, arriving at the other end of the run.
- **`api.download(id)`** is the browser half, and it answers a `Blob` rather
  than a URL for a reason a page cannot discover on its own: the byte route
  takes the same bearer every other route does, and neither `<audio src>` nor
  `<a href>` can send one — so a page built on a URL works under `aai dev` and
  401s the moment the agent has a token.

Three rules the template is written to demonstrate, each of which a first draft
gets wrong:

- **Speak and store in ONE step.** A step is journaled by its RETURN VALUE, so
  an id is replayed and bytes are not; split in two, the audio crosses the queue
  between them on every resume. The cost is that a retried step writes a second
  upload and abandons the first — cheap next to a step that cannot retry.
- **Ask the model for a SPOKEN script, not just points.** A template that
  synthesized its own bullet list produces a voice reading "one. two. three."
  with no connective tissue, so the schema asks for both and only the script is
  spoken. It is the same decision `recap-workflow` makes for the sentence it
  reads down a phone, and one a prompt alone does not hold — hence a required
  `spoken` field rather than a defaulted one, so a missing script is a retry
  instead of half a second of silence.
- **Derive the voice list from `ASSEMBLYAI_TTS_VOICES`.** A wrong voice id is a
  SILENT failure — the service accepts the socket and refuses in band — so the
  form's enum is read from the SDK's catalog rather than typed out, which also
  makes the control a `<select>` for free.

It transcribes through the ASYNC API rather than cutting the file up, and that
is a deliberate narrowing: the fan-out is a whole subject and it already has a
template. Here the transcription should be the boring leg.

## ffmpeg is what lets a desk cut a recording where a HUMAN would

`call-audit` is the reference use of `@alexkroman1/aai/ffmpeg`, and until it
existed that subpath's only worked example was a `no-check` snippet in
`packages/aai-guest/CLAUDE.md`. It is the deepest of the workflow apps and the
wrong one to read first — `link-digest` owns the shape, `transcription-workflow`
the fan-out, `spoken-summary` the audio round trip — so what it is FOR is the
one thing none of those can show: what changes downstream when a decoder is in
the pipeline.

The answer is that almost everything gets SMALLER, which is the argument worth
keeping. `transcription-workflow` cuts by arithmetic because with no decoder that
is all it can do, and it pays for that three times over. Normalizing first, to a
format the desk itself chose, deletes all three:

| | `transcription-workflow` | `call-audit` |
| --- | --- | --- |
| intermediate | linear-PCM WAV | headerless raw PCM |
| header | parsed — `parseWav`, ~180 lines | **none: byte 0 is second 0** |
| cut at | every 90s, wherever that lands | **the middle of a pause** |
| overlap | 2s per segment, transcribed twice | **none** |
| stitching | seam matching over 40 words | **ordered concatenation** |
| caps to plan against | 120s AND 40 MB, whichever binds | **120s** |
| fan-out width | derived per recording from a byte budget | **a constant** |

Four rules came out of building it, each of which a first draft gets wrong:

- **An analysis whose output grows with the recording must NOT come back on
  stderr.** The SDK keeps a capped stderr TAIL (`FFMPEG_STDERR_TAIL_CHARS`, 4000
  chars), which is right for `loudnorm`'s one fixed-size JSON block printed after
  the last frame, and wrong for `silencedetect`, which logs an event per pause —
  720 of them on a two-hour call. What a tail drops is the BEGINNING, so the
  failure is a desk that cuts the back half of every long recording and the front
  half of none, silently, on inputs nobody tests with.
  `ametadata=mode=print:file=…` writes to a path with no cap, and does so at
  `-loglevel error`, so that pass is quiet AND complete. The mirror-image trap is
  on the other pass: `print_format=json` writes through the LOG, so at
  `-loglevel error` the measure pass runs, succeeds, and prints nothing.
- **Build the argv in a pure module, and it becomes testable.** An ffmpeg step is
  untestable exactly where it spawns, so `workflows/media.ts` holds every argv
  and both parsers as pure functions and the steps hold only materialize, spawn,
  store. That is what makes 100% line coverage of the decisions possible in the
  UNIT tier, with no subprocess: `media.ts` measures 100% statements where
  `ingest.ts` measures 26%, and the 26% is plumbing.
- **A temp file may not cross a step boundary**, so the shape of an ffmpeg step
  is decided by materialization cost rather than by retry granularity.
  `ingestRecording` runs `ffprobe` and both `loudnorm` passes in ONE step because
  splitting them would read the whole recording out of the upload store three
  times — and on a 700 MB file that is the expensive part by an order of
  magnitude, while the decodes are seconds. Its module doc carries the argument.
- **Plan byte offsets from the BYTE COUNT, never from a duration.**
  `pcmDurationMs` answers whole milliseconds, so a 640,500-byte file reports
  20,016 ms where it holds 20,015.625 — and planning from that put the last
  segment's `endByte` twelve bytes past the end of the file. `readUpload`
  clamps a window to the stored size, so nothing threw; the plan simply
  described audio that did not exist. `planSegments` therefore takes the byte
  count and derives its own seconds. **It was found by running the real argv
  against a real ffmpeg**, which is the only place a twelve-byte error was ever
  going to surface, and it is the reason the spec's fixtures are captured from
  ffmpeg 6.1.1 verbatim rather than typed from the documentation.

**The desk stays honest about the case it cannot serve.** A stretch of unbroken
speech longer than the cap has no pause to cut in, so it gets the blind cut —
flagged as `cutInSpeech`, counted in the run's output, and rendered on the page.
A mangled word at a seam is otherwise a mystery, and hiding the one number that
explains it would be the worse trade.

The same subpath also closed a defect in `transcription-workflow`, which is worth
reading as the SMALL version of all of this: `workflows/normalize.ts` converts
anything that is not already cuttable, so its classic flow accepts an m4a off a
phone. **The test for whether to convert is `parseWav` ITSELF**, not an `ffprobe`
codec check — a `WAVE_FORMAT_EXTENSIBLE` file reports `pcm_s16le` to ffprobe and
is refused by the parser, so a probe-based check would pass it through and then
fail to cut it. Asking the downstream authority as a QUESTION makes the two
decisions the same decision by construction, and it repairs anything the parser
rejects for any reason — a 192 kHz 32-bit WAV over `MAX_BYTES_PER_SECOND`
included. `transcribeStream` still refuses, and has to: it cuts while the bytes
are still arriving, and a partial file is not something a decoder can be pointed
at.

### A `workflows/` module keeps every MODULE-SCOPE import in the workflow bundle

Only a `"use step"` BODY is removed by the WDK builder — the transform's whole
point is to leave a stub that enqueues. An import nothing outside a step body
names goes with the body; one a SURVIVING top-level binding still names does
not, and rides into a bundle compiled as a `node:vm` Script with no `require`.
The symptom is a `ReferenceError: require is not defined` at REPLAY, thrown from
generated code inside the SDK with nothing pointing back at the import that
caused it, so it reads as a broken framework rather than a misplaced import —
and it is invisible until the workflow runs: the bundle builds, the types check,
and `aai dev` may serve the route.

**This is a rule about REFERENCES, not about import statements.**
`call-audit/workflows/ingest.ts` holds `node:fs/promises`,
`@alexkroman1/aai/ffmpeg` and `@alexkroman1/aai/step-files` at module scope and
is correct, because every name they bind is used only inside `ingestRecording`'s
body — the shape `host/step-files.ts`'s own module doc demonstrates. Verify it
mechanically: the test is not "does this file spawn", it is "does anything the
transform KEEPS name it" — an exported helper, a module constant, a default
argument, and the usual reason a helper is exported is a spec importing it.

Both ffmpeg templates shipped broken this way and paid the full price: each
carried a one-function `workflows/ffmpeg-verdict.ts` whose only job was to keep
a module-scope `isFfmpegError` — and therefore `@alexkroman1/aai/ffmpeg`, which
spawns a child process — out of the bundle. Both built, type-checked, passed
their specs, deployed, and failed EVERY run at replay.
`throwFfmpegStepError` reaches no `node:` builtin at all, so both boundary files
dissolved. Reach for a boundary module only when a name you must hold at module
scope is itself node-reaching.

**In-tree this failed LOUDLY and in production it did not**, because the WDK's
detector needs a first-party import line and pnpm links the workspace SDK. The
gate that catches both is `aai-cli`'s `template-workflows.test.ts`, over the
BUILT artifact — see "And the FLOW bundle may `require` NOTHING" in
`packages/aai-cli/CLAUDE.md`.

### A body that names `WorkflowInputOf` obliges the DEF to carry a type

A `"use workflow"` body should take `WorkflowInputOf<typeof theDef>` —
`WorkflowBody` is contravariant, so a body restating a WIDER shape is assignable
and nothing warns, which is how `podcast-digest` came to re-implement six schema
`.default()`s with `??`. But **the obvious spelling does not compile**:
`workflow<P, R>()` infers `R` from `run`, so `typeof theDef` needs the body's
signature and vice versa — `TS7022` against `agent.ts`, plus
`TS2456`/`TS2502` at the body, and annotating the body's RETURN type does not
break it. Two template groups hit this independently; the type tests miss it
because every def there declares `run` as an inline arrow, and
`sdk/workflow.ts`'s `@example` is `no-check`.

The fix is two edits in `agent.ts`, not one — name the schema const and ANNOTATE
the declaration:

```ts
const auditInput = z.object({ /* … */ });
export const audit: WorkflowDef<typeof auditInput, CallAudit> =
  workflow({ input: auditInput, run: auditFlow });
```

The annotation resolves without the initializer, so `WorkflowInputOf<typeof
audit>` comes from the schema alone; the body takes it through a type-only
import of `agent.ts`, erased at build, so there is no runtime cycle. The cost is
that the output type must be NAMED — the trade to weigh per template.
`podcast-digest`, `call-audit` and `spoken-summary` pay it, having exported that
type for `WorkflowOutputOf` already, and it deletes five `??` fallbacks that
could silently disagree with a `.default()`. `redline` does NOT convert: its
body returns an inferred object literal, so the annotation would mean writing
that shape out by hand.

## A transcription step is the SDK's; the boundaries are the template's

The way IN is now `stepTranscribeUpload` / `stepTranscribeSubmit` /
`stepTranscribePoll` (the async job API) and `stepTranscribeSync` (the
one-request endpoint), all on `@alexkroman1/aai/step`. Before them all three
transcribing templates carried their own copy of AssemblyAI's HTTP: the URL, the
raw-key auth (no `Bearer`, which is a 401 that reads like a wrong key), the
windowed streaming upload, the PLURAL `speech_models` field, and the failure
classification. `spoken-summary` and `transcription-workflow` had the SAME ~200
lines, reworded, drifting at the edges.

**What did NOT move is the step boundaries, and that is structural rather than
tidy.** The WDK builder transforms exactly the files under a project's
`workflows/` directory, so a `"use step"` shipped inside the SDK would be
scanned by nothing, transformed into nothing, and would run inline as an
ordinary function with no journal and no retry — with no symptom saying so. So
the SDK owns what happens INSIDE a step and the template owns which steps exist,
which is the same thing as owning what gets journaled and what a retry repeats.
Each template's step is now three lines: a `report` and one
`stepTranscribe*Classified` call.

Three things the conversion settled, each worth knowing before the next one:

- **The upload/submit split survives, because it was paid for.** Folding them
  into one step made the DevKit re-upload 24 MB on all five retries of a
  deprecated JSON field. That measurement is a property of the BOUNDARY, so it
  stays in the templates and in the SDK's module doc rather than in one of them.
- **Polling READS.** Both templates polled `GET /v2/transcript/:id` for a status
  and then fetched the identical URL again for the text the completed poll
  already had in its hand. `stepTranscribePoll` answers with the transcript, so
  a finished job costs one round trip and the value journaled by the last poll
  IS the result. Four steps became three.
- **`recap-workflow` converts its SUBMIT and deliberately not its POLL.** Its
  `checkTranscript` returns the provider's status as a VALUE — read by the Query
  port (`recap_status`) while the run is still going, and branched on by the saga
  to unwind the compensation stack — where `stepTranscribePoll` answers `done`
  and THROWS on a job the provider gave up on. That state machine is the
  template's whole subject, so converting it would trade the thing being
  demonstrated for a throw. The module says so in place, because the next reader
  will otherwise finish the job.

**A provider refusal is where `TranscribeError` earns its keep.** It carries
`retryable`/`retryAfter` the way `StepGenerateError` does and `toStepError` reads
both — which is the only way a failed job or a recording with no speech can be
TERMINAL, since either arrives with a 200 and no status to judge.
`stepTranscribe*Classified` is what turns that into the DevKit's verdict, and it
is what `podcast-digest`'s two hand-written
`err instanceof TranscribeError && err.retryable` checks were missing —
both dropped `retryAfter`.

**`research-workflow` is the workflow template, and its shape is dictated by the
Workflow DevKit rather than chosen.** The `"use workflow"` / `"use step"` bodies
live in `workflows/research.ts` because the WDK builder scans that directory at
build time and rewrites what it finds; a body written in `agent.ts` is never
transformed, so it runs inline once with no durability and nothing saying so.
`agent.ts` holds only the declaration (`workflow({ description, input, run })`)
and the two tools that start and read runs.

**Its research is real, and it really searches the web.** Five stages, adapted
from LangChain's `open_deep_research` (MIT — `workflows/prompts.ts` carries the
attribution and a table mapping their stages onto ours): `writeBrief` settles
what the phone request was actually asking, `planAngles` decides the fan-out's
width, `investigate` gives each angle its own researcher step, `findGaps` is the
supervisor's second look, and `writeReport` writes the report and then the two
sentences a phone can carry. That is five to twelve model calls and as many
searches, which is what makes it too slow to answer on the line and therefore
worth a durable run at all. The fan-out's WIDTH comes from a step's journaled
result rather than from anything the body computes, which is the ordinary
determinism rule.

**A step can do what a TOOL can do, and this is the template that shows it.**
`investigate` imports `webSearch` and `visitWebpage` from
`@alexkroman1/aai/tools` — the same implementations behind the model-facing
builtins, with the same URL screening, redirect re-validation and size caps —
and runs a bounded search/read/stop loop on them. A step artifact bundles
everything it imports, so anything a tool body can reach a step can reach; what
it does NOT get is the `ToolContext`, which is why the model call is
`stepGenerate` and the key comes from `requireStepEnv`. Before this the
template's "research" was three model calls asking a model what it already
believed, which is the thing deep research exists not to be.

Three things in the loop are decisions rather than defaults, and each is the
kind a prompt alone does not hold:

- **The budget is the mechanism, not the prompt.** `RESEARCH_BUDGET` bounds the
  actions one researcher may take, because a model told to stop when it has
  enough will sometimes not — and a run whose cost is decided by a model is a
  run nobody can price. The prompt's numbered stop rules (theirs, kept close to
  verbatim) are what makes it stop EARLIER than the budget.
- **The loop is journaled as ONE step result**, not one per iteration. The loop
  is a negotiation with a model and a search engine, and replaying it turn by
  turn would pin a run to decisions that were only ever provisional; what has to
  survive a resume is what the researcher CONCLUDED.
- **A failed search goes back to the researcher, not only to the log.** The next
  turn is chosen from what it has been shown, so a search that quietly returned
  nothing reads as "no such pages exist" and gets run again, differently worded,
  until the budget is gone. Its own spec pins that.

Note the compression stage's prompt is the counter-intuitive one worth keeping:
it says to REPEAT the relevant text rather than summarize it, because a summary
of a summary is how a long research pass ends in a confident, sourceless
paragraph.

Its spec stubs `ctx.workflows` for the TOOLS rather than driving a real client,
which is the only honest option there: the real client needs a WDK world, and the
bodies are only durable after the build has transformed them. The STEPS are
driven directly against a stubbed `fetch`, because imported through vitest with
no bundler in the path a `"use step"` function is an ordinary async function.

That is also why **`workflow()` does not check for the compiler's
`workflowId`** — `templates.test.ts` imports every
`agent.ts` through vitest with no bundler in the path, so a declaration-time
throw made this template unimportable by its own spec. The check lives at
`ctx.workflows.start`, where the id is actually needed.

Note the template needs `workflow` as a devDependency of THIS package to
resolve at test time; a scaffolded project gets it as a real dependency.

**A search that was REFUSED is not a web with nothing in it, and both templates
that search got that wrong.** `webSearch`/`visitWebpage`/`fetchJson`
(`@alexkroman1/aai/tools`) ANSWER with `{ error }` rather than throwing — the
model-facing contract, so a tool hands something useful back instead of failing
the turn — and they used to be typed `Promise<T>`, which made that invisible.
`research-workflow` wrote `(results.results ?? [])` under a `catch` written for
exactly this failure, and a `catch` cannot see a returned value; `plan-and-execute`
wrote the same line with no failure path at all. Measured 2026-08-13: DuckDuckGo
answered `403` to both its endpoints, so every search in both templates reported
"No results." with the refusal nowhere. The type is `T | ToolFailure` now and
both narrow with `isToolFailure` — and `aai:builtins` epoch 1 was DROPPED over
it, which is the gate recording that a caller who named a shape has to handle the
failure it was already receiving.

**A step's HTTP goes through `stepFetch`, never `fetch`, and that came out of a
load test rather than review.** `transcription-workflow` used `fetch` with a
`FormData`, which is the obvious spelling and fails under exactly the concurrency
the template exists to demonstrate: Node's `fetch` offers `h2` in ALPN and the
sync endpoint takes it, so a `mapConcurrent` window of 17.66 MB uploads multiplexes
onto ONE connection. Measured at 8 in flight, `fetch` landed 14 of 16 at p50
8094ms against HTTP/1.1's 16 of 16 at p50 3037ms — and the two it lost are the
point, because a capacity limit on h2 arrives as `NGHTTP2_ENHANCE_YOUR_CALM`, a
stream reset with no HTTP status for `isTransientStatus`/`retryAfter` to read. So
every sibling retried in lockstep into the same reset and the run died on
`TypeError: fetch failed` with the cause two hops down. Over HTTP/1.1 the same
limit is a `503` with `retry-after`, which the template already handled. The
concurrency curve that came out of it is in `SEGMENT_CONCURRENCY`'s own doc;
`sdk/step-fetch.ts` owns the rest, and a spec answers it with `stubStepFetch`
(`@alexkroman1/aai/testing`) rather than stubbing the global — the global stub
passes while testing a path production does not take.

**`transcription-workflow` is the second workflow template. It is a WORKFLOW
APP —
`workflowApp()`, no `stt`/`llm`/`tts`, no tools — and it is the one that really
calls a provider.** Its three steps are a straight line: `splitRecording` reads
the recording's WAV header and decides where to cut, `transcribeSegment` runs
once per chunk against AssemblyAI's **sync** endpoint, `mergeTranscript` stitches
the chunks back into one transcript.

**The fan-out is forced by the provider, which is what makes it a good example.**
The sync endpoint answers in the request — no job id, no polling, no callback —
and pays for that with a hard 120-second, 40 MB cap. So a two-hour recording is
not one call, it is sixty, and the desk owns the splitting, the retrying and the
reassembly that the BATCH API would have owned for it. That is the work a
journal earns its keep on: a run that dies on segment 27 of 60 resumes having
replayed 1-26 — not re-downloaded, not re-transcribed, not re-billed — and issues
only what is missing.

It used to demonstrate the batch shape instead: a run that parked on
`createWebhook()` and was resumed by the delivery. That is a real and important
mechanism, and it was demonstrated against a STUB provider that called its own
webhook back inside the submit step — i.e. the template's whole subject was
simulated. No template covers `createWebhook()` today — `aai-cli`'s
`dev-workflow.scenario.test.ts` does, against a real world and a real HTTP
delivery, which is the only tier that ever could — and a template that simulates
its own subject is worse than one that leaves the mechanism to the tier that can
actually exercise it.

Three things in it are load-bearing:

- **The recording is UPLOADED, and the run carries its id.** A workflow's input
  is journaled and replayed on every resume, so bytes may not travel in one —
  which is why this template asked for a URL for a while, and why its
  `<FileField>` before that described a file nothing ever read. The SDK owns
  both halves now: `uploads: ["recording"]` on the declaration is what makes
  `<WorkflowFields>` render a picker and `useWorkflowSubmit` store the file, and
  each step reads its own window with `readUpload`. Sixty steps therefore move
  the recording once between them, not sixty times. See "Uploads" in
  `packages/aai-ui/CLAUDE.md` for the mechanism; the template contains no upload
  code at all, which is the point. It DOES render `<UploadProgressBar>`, which is
  not upload code but the other half of the same argument: storing a two-hour
  recording is minutes long, and until the bytes are in there is no run for
  `<WorkflowProgress>` to narrate — so the page shows two bars covering two
  disjoint waits. **And one clock over both**, because the number a reader
  comparing the three modes wants is the press-to-transcript total, and no
  server-side number can be it: `output.elapsedMs` is the RUN's own wall clock,
  so in the two modes that store the file first it begins after the upload and
  misses most of the wait. `useTotalLatency` in the page is a stopwatch started
  by the submit and frozen when the run settles; `<TotalLatency>` prints it with
  the split (before the run, inside it) once the run reports its own elapsed,
  since two disagreeing durations on one screen otherwise invite the reader to
  distrust both.
- **It is linear-PCM WAV only, and it says so by name.** The cutting is
  arithmetic over byte offsets — a sample is a fixed size, so an offset IS a
  timestamp and any frame boundary is a clean cut. An MP3 or M4A frame boundary
  cannot be found that way, and finding it means shipping a decoder into a step,
  so an unsupported file fails the run with the `ffmpeg` line that fixes it.
  `workflows/wav.ts` holds all of that, with no directive in it: the builder
  scans `workflows/` and transforms only what carries one, so an ordinary module
  can sit beside the bodies — and everything in it is a pure function of a
  journaled value, which is what its spec drives.
- **Segments OVERLAP, and the merge step is what makes that free.** A cut lands
  mid-word, and the decoder on either side then hears half a word and reports
  something plausible and wrong; two seconds of overlap means both sides hear the
  whole word. `stitchTranscript` finds the longest repeated run at each seam and
  drops one copy, comparing on a punctuation-stripped key because the two passes
  punctuate their own edges differently. It prefers the LONGEST match: a missed
  seam repeats a few words, which a reader forgives, while a false one deletes
  speech.

**The DevKit correlates a journal entry to a step call by the ORDER the call was
ISSUED in**, which is why the fan-out is bounded the way it is. `createUseStep`
(`@workflow/core/dist/step.js`) stamps each invocation with
`step_${ctx.generateUlid()}` from a monotonic ULID factory seeded off the run's
`startedAt` and the VM's replay-stable `Math.random`, so the Nth step call in a
run gets the Nth id on the first execution and on every replay. The step's NAME
is only cross-checked against that id, and a mismatch is `ReplayDivergenceError`
rather than a silent re-run.

What follows is narrower than it looks, and this guide had it too wide for a
long time. The requirement is that **the SEQUENCE OF ITEMS whose calls are
issued is a pure function of the list** — not that no call may be issued after
another settles, which is what an ordinary `await`-then-call body does. So
`Promise.all(batch.map(step))` is safe, and so is a WINDOW over a shared cursor:
the cursor only ever hands out the next index, so the Nth call issued is item
N-1 however the calls settle, and what completion order decides is which slot
runs which item. This guide (and the primitive's own doc) used to say a pool
was unsafe because "the issue order tracks completion order"; it does not,
because the item choice is the cursor's and the cursor is monotonic. What is
genuinely unavailable is a caller-supplied step key — `ctx.step("chunk-3", …)`,
the one piece of the pre-DevKit engine's API that did not survive the port.

**That rule is a primitive rather than a loop in a template.** `mapConcurrent`
(`@alexkroman1/aai/step`, formerly `mapInBatches` and still exported under that
name, deprecated) is the window; its module doc carries the argument, and
`sdk/map-concurrent.test.ts` asserts the issue order directly at every width and
under reversed and shuffled settle orders. Dropping the barrier is worth real
time on a wide fan-out: a batch was only as fast as its slowest member and a run
was the sum of those, and a `503` carrying `retry-after: 1` is exactly such a
straggler (`transcription-workflow` measured max/p50 at 6.7x).

The rule that IS load-bearing whatever the shape: **the callback must issue the
same sequence of step calls for every item**, in practice one, synchronously. A
callback that awaits something first, or issues two steps in a row, interleaves
with its siblings by completion order — under a window and under batches alike,
since within one batch the second round of calls goes out as the first round
settles. A body needing two steps per item runs them as two fan-outs.

Note what makes passing a step to a helper legal at all — the WDK transform
rewrites a step's DECLARATION into a dispatcher rather than rewriting call
sites, so a `"use step"` function handed to another module as a callback still
dispatches a real step. That is a claim about the transform, so it is tested
against a real one: `aai-cli`'s `dev-workflow.scenario.test.ts` fans a fixture
flow out through `mapConcurrent`, nine items through a window of three with
shuffled durations. That tier proves the steps are REAL; it does not prove the
issue-order property, because a healthy run is not a resume — which is why the
unit spec asserts it directly.

The fan-out's WIDTH is derived from a STEP'S RESULT (the parsed header), not
re-probed by the body — the ordinary determinism rule: a replay has to produce
the same list in the same order, and a URL whose content changed underneath the
run would otherwise hand the Nth journal entry to a different call.

**Its `client.tsx` is the form layer's worked example**, and the split with
`link-digest` is deliberate: that one shows the primitives raw (a hand-written
`<form>`, its own `useState`, one `createWorkflowApi()`), and this one shows the
same page with `useWorkflowSubmit` and `<Form>` over them. There is no field
markup in it at all — `<WorkflowFields>` renders a control per SCALAR property of
the workflow's own input schema, and this workflow's input is scalars all the way
down, so the URL box and the language picker exist because `agent.ts` declares
them and the `z.enum` is what makes the second a `<SelectField>`. See "Forms" in
`packages/aai-ui/CLAUDE.md` for the mixed case.

Its spec exercises the exported STEPS and the pure helpers directly rather than
the body, which is where the honest line is: imported through vitest with no
bundler in the path, a `"use step"` function is an ordinary async function and
its retries, its `FatalError` guards and its HTTP handling are all testable,
while durability, suspension and replay are not. The spec says so in place,
because a body test that looked like a durability test would be the worse
failure. The WAV half carries its own weight there: a cut that lands mid-frame,
or an off-by-one in the RIFF chunk walk, produces audio the decoder happily
transcribes into confident nonsense rather than anything that fails.

## The authoring guide ships inside the SDK

`scaffold/CLAUDE.md` is already the one source of truth for how to write an aai
agent: `studio-prompt.ts` embeds it in the studio system prompt, and `aai init`
copies it into every scaffolded project. What it is not is **version-matched to
the SDK a project ends up resolving.** The copy in a project is frozen at the
moment `aai init` ran — correct on day one, since the CLI and the SDK release
together — and then the project runs `pnpm update @alexkroman1/aai`, the SDK
moves, and the guide does not. An agent reads guidance for a version that is no
longer installed, with nothing saying so.

So `scripts/sync-agent-guide.mjs` materializes it as
`packages/aai/AGENT_GUIDE.md`, which ships in the `aai` tarball and therefore
cannot describe a different release than the `@alexkroman1/aai` beside it. The
copy carries a generated-file banner as part of its compared content, so an edit
that stripped the banner leaves a file that looks authored.

`packages/aai/skills/aai/SKILL.md` ships beside it and deliberately carries **no
API guidance at all** — it says where the guide is and stops. A skill lives in a
user's home directory and has no version, so guidance embedded there is the same
drift one level worse.

It is a **repo-level script** rather than a build step in `aai`, because `aai`
must import no sibling package (the dependency flow above, enforced by
`konsistent.json`) and a build step reading from `aai-templates` would invert
that. A root script reads both trees, so neither package declares anything about
the other, and `check:agent-guide` is what keeps the copy honest.

## Five templates are ports of LangChain/LangGraph agents

The reference agents people already know are the best starters this repo can
ship: an author arriving with a LangGraph mental model gets a working voice
version of the thing they have already read, and the DIFFERENCES are where the
voice-specific lessons live. Each port carries its attribution and a
their-name → our-name table in the module that holds the prompts, so nothing has
to be re-derived from memory.

| Source | Template | Front door | What the port had to change |
| --- | --- | --- | --- |
| `open_deep_research` | `research-workflow` | voice, handing off to a run | a durable workflow, because five to twelve model calls cannot answer on the line (see above) |
| customer-support tutorial (Swiss Airlines) | `travel-concierge` | voice | the specialist's prompt becomes a tool RESULT; `interrupt_before` becomes a spoken confirmation |
| self-RAG + CRAG | `support-line` | voice | lexical retrieval instead of a vectorstore, and the graders are the thing that makes that fine |
| plan-and-execute | `plan-and-execute` (the one template named for the pattern it ports, because nothing about it is a "desk") | voice | the execute→replan loop is driven by the CALLER, one step per tool call |
| reflection (the essay assistant) | `redline` | **page over a durable run** (`workflowApp()`) | the loop's exit becomes a step's journaled VERDICT, so a replay takes the same branch |

**Which front door a port gets is decided by one question: can it answer
inside a turn?** A caller will hold the line for a tool call and a sentence
back; they
will not hold it for seven long-form model calls in sequence, and what a
reflection loop produces is a piece of prose to READ rather than two sentences
to hear. So `redline` is a workflow app, exactly like
`transcription-workflow`, and
the three above it are voice agents. Getting that wrong in either direction is
the expensive mistake: a voice agent that goes silent for ninety seconds, or a
page for work that a caller could simply have been told.

**`travel-concierge` — the two mechanisms, and the honest limit.** Their graph
gives each specialist node its own bound tool set and swaps the assistant's
prompt as `dialog_state` is pushed and popped. A voice session has ONE model
with ONE tool list and a system prompt fixed at connect, so the port splits the
difference: the stack is real state (`routing.ts`, projected to the sidebar), and
the specialist's brief arrives as the delegation tool's return value, which is
the last thing the model reads before it speaks. The narrowing is therefore
asked for rather than enforced, and `agent.ts` says so in place — do not "fix"
that by pretending otherwise.

The half that IS enforced is the confirmation gate, and it is the bit worth
copying into any agent that can spend someone's money. Every sensitive tool
STAGES a `PendingAction` and mutates nothing; `confirm_action` is the only code
path that applies one. That is `interrupt_before` with a better interface —
a caller cannot type "y", but asking out loud and hearing "yes" is the same
gate — and it is the reason `stageAction` is one helper rather than a pattern
each tool repeats: the next sensitive tool is otherwise the one that forgets.
Its spec asserts, per tool, that calling it changes nothing.

**`support-line` — the graders are the product.** Retrieval is idf-weighted term
overlap over `knowledge.json`, not embeddings, because the SDK has no vector
store; the argument in `shared.ts` is that this makes CRAG's corrective loop MORE
valuable rather than less, since a weaker retriever is exactly what its query
rewriter was designed for. The knowledge base is BAITED to prove it — "cancelling
your contract" and "cancelling an engineer visit" are two documents, two fees and
one word apart, and a spec pins that the neighbour ranks FIRST for a caller's
phrasing. Three decisions in the loop are not defaults:

- **An ungrounded answer is never spoken.** One regeneration, then the answer is
  withheld and the run ends `exhausted`. A grounded-but-not-useful answer, by
  contrast, IS returned, with its verdict, because it is still true.
- **`exhausted` is a reachable state with somewhere to go** — `log_ticket`. An
  agent that cannot say "I don't have that documented" will eventually say
  something worse, so the exit has to exist before the grading is worth anything.
- **There is no web-search fallback**, which CRAG has. A support line answering
  from the open web about a private product is the exact failure its grader
  exists to prevent; `plan-and-execute` is where real search lives.

**`plan-and-execute` — the loop belongs to the caller.** Their notebook runs
plan→execute→replan to completion and prints the answer. A phone line cannot go
quiet for ninety seconds, so one `work_next_step` call is exactly one
execute-then-replan turn: the desk reports, and the pause that creates is what
makes `revise_plan` reachable at all — a replanner driven by the person rather
than by a step result, which their version has no way to express. Two more
things are decisions:

- **`Act = Union[Response, Plan]` became one discriminated object.** A union is
  `anyOf` in JSON Schema and provider support for it varies; a model that emits
  `{"steps": …}` when it meant to respond leaves a plan looping forever.
  `normalizeAct` then treats every malformed act as an ANSWER, because a desk
  that never stops is the failure that matters on a call.
- **The search is real and therefore injected.** `executeStep` takes a
  `SearchFn`; the tool passes `liveSearch` (`webSearch`, DuckDuckGo-backed, no
  key) and the spec passes its own. A template spec that depended on the live web
  would be a flake with a stranger's rate limit attached.

**`redline` — a loop whose exit is data, and the mixed form.** Two things in it
are worth reading for, and neither exists elsewhere in `templates/`:

- **The `while` is legal because the verdict is journaled.** `transcription-workflow`
  derives its fan-out's WIDTH from a step's result; this derives a LOOP EXIT from
  one. `critiqueDraft` returns `ship` or `revise`, the body breaks on it, and a
  replay reads that verdict back out of the journal and takes the same branch —
  where a clock, a random draw or a re-read of anything outside the run would let
  a replay diverge into a `ReplayDivergenceError`. Their `should_continue` stops
  on a message COUNT, which spends the same money on a draft that was already
  good; letting the critic stop the loop is the one real addition, and it is
  possible only because the decision is a step result.
- **Its page is the MIXED form**, which the guide has described for a while with
  no template behind it. `<WorkflowFields>` renders the three scalars (the
  `z.enum` becoming a `<SelectField>` is the schema doing the work), and
  `mustCover` is an ARRAY, which it deliberately renders nothing for — so
  `client.tsx` writes that one field itself in the same `<Form>` and maps the
  textarea into `string[]` in one exported function. `transcription-workflow` stays
  the all-declared example.

One smaller thing it settles: neither writer step carries an empty-reply guard,
because `stepGenerate` already refuses an empty completion as a RETRYABLE
failure. The first draft of the template had both, and both were dead code
re-deriving an SDK decision — worth checking for before adding a guard to a step.

Both LLM-driven VOICE ports are tested by SCRIPTING `ctx.generate` on the
system prompt each node carries, so what a spec asserts is WHICH NODES RAN,
which is the part of a graph port that can actually regress. **`stubGenerate`
(`@alexkroman1/aai/testing`) is that fake now** — its script is keyed by system
prompt, which is the same shape both templates had reached for by hand, and it
owns the `{ text, object }` envelope. That envelope is why it is worth having:
`GenerateFn`'s schema overload declares `object` as required, so a hand-written
fake with one `{ text }`-only branch is unassignable AS A WHOLE, and both
templates carried a comment explaining that to the next reader.

What each template keeps is its own TRANSCRIPT: `support-line`'s routes push
node names (`grade_documents:D1`) into a local array, because the assertions are
about the graph rather than about the calls, while `plan-and-execute` reads
`stubGenerate`'s own `calls` — the prompt of the turn after a failed search is
exactly what its "a failed search goes back to the model" test is about.

## `recap-workflow` is where the Temporal patterns were ported

The same idea as the LangChain ports above, from the other tradition — and the
one template whose SUBJECT is the patterns rather than the work. It is
`research-workflow`'s shape (a voice agent whose tool hands off to a run) carrying
the Temporal TypeScript samples that survive translation to this engine, each
against real I/O. Both files carry the mapping table; this is the summary and
the rationale for the two judgement calls in it.

| Temporal sample | Ported as |
| --- | --- |
| `saga` (`openAccount`) | `recapFlow`'s compensation stack, unwound by `compensate` |
| `polling` (infrequent) | `awaitTranscript` — one step plus one durable `sleep`, bounded by attempts |
| `timer-examples` (`processOrderWorkflow`) | the `Promise.race` against `PATIENCE`, then the "still going" note |
| `expense` (`timeoutOrUserAction`) | the RETENTION GATE: a hook raced against a `sleep`, three outcomes, safe default |
| `signals-queries` (Signal) | `keep_transcript`, answering that gate over `ctx.workflows.signal` |
| `signals-queries` (Query + Cancellation) | `recap_status` and `cancel_recap` |
| workflow-id reuse / `mutex` | the live-run check in `request_recap` |

**The subject is real because the provider's BATCH API is real.** A polling port
needs something that genuinely takes minutes, and `POST /v2/transcript` answers
with a job id in milliseconds and finishes later — so the wait belongs to the
provider rather than to a `setTimeout` the template chose. The compensation is
the same argument: `DELETE /v2/transcript/:id` really removes the transcript,
which is what makes "a failed run leaves nothing on the account" a claim rather
than a stub. That is the line this guide draws for `transcription-workflow`'s
removed webhook demo, applied forwards — and it is also the split between the
two: `transcription-workflow` takes the SYNC endpoint (answers in the request, hard
cap, therefore a fan-out), this one takes the batch endpoint (job id, therefore
a poll).

**A phone caller cannot read a URL aloud, so the desk supplies its own.**
`SAMPLE_RECORDING` is the provider's documented public sample, and it exists so
the template transcribes something on the first call instead of asking for input
the medium cannot carry. A real desk swaps it for a lookup against its own
recording store; the tool still accepts a URL when one is somehow available.

**This template is why the SDK grew `ctx.workflows.signal()`**, and that is the
argument for porting from another engine at all: `expense` is the most
voice-native sample Temporal ships — a run that waits for a person to say yes —
and writing it here found a hole rather than a workaround. The DevKit's only
reachable waitpoint was `createWebhook()`, whose URL is minted for a THIRD PARTY
with a callback to make; the caller is not that. `wakeUp` is not it either — it
ends a `sleep`, where a signal carries a payload, and a body that races a hook
against a `sleep` needs both and means different things by them. The method's
own doc carries the token rules; `workflows/tokens.ts` is this template's one
derivation of one, and the reason it is a shared function rather than a template
literal typed twice.

**One thing still does NOT port, and saying so is the point of having ported the
rest.** Cancellation is not cooperative: Temporal delivers cancellation INTO the
workflow, so the saga's `catch` runs and the compensations fire, while
`ctx.workflows.cancel` marks the run cancelled and stops replaying it — a
cancelled recap leaves its transcript behind. `cancel_recap` says that in its own
tool result rather than implying a rollback that does not happen, and its spec
pins the sentence. The gate is what a cooperative stop would be built from (a
hook the body races alongside its work, signalled instead of cancelled); the
template deliberately stops at ONE hook, because racing a stop into every wait is
a second lesson and would cost this one its shape.

Its spec runs three tiers and is explicit about which one proves what: the tools
against a stubbed `ctx.workflows`, the steps directly, and — new here — the
body's HELPERS (`awaitTranscript`, `compensate`, `askWhetherToKeep`) with `sleep`
and `createHook` stubbed via `importActual` plus two overrides. That third tier
asserts ORDERING and BRANCHING, which is ordinary logic worth pinning (the poll's
exit conditions, the unwind's direction, that a failing undo does not strand the
ones behind it, and the gate's three outcomes with its safe default), and asserts
nothing about durability. `recapFlow` itself is still not driven, for the reason
every other workflow template gives.

Two mechanical notes on stubbing a hook, both learned by getting them wrong. The
fake is built by hanging the hook's members on a REAL promise
(`Object.assign(settled, { token, getConflict, … })`) rather than by writing a
`then` property — a `Hook` IS a thenable, and a hand-written `then` is both a
biome finding (`noThenProperty`) and a worse model of the thing. And the
window's `sleep` must NOT resolve in the tests that exercise an answer: with both
settled, which one `Promise.race` picks comes down to microtask order rather than
to the branch under test, so the mocked `sleep` returns a never-resolving promise
except in the timeout case.

## A step can authenticate now, so no template's I/O is a fixture

This guide used to say the opposite, and it was the reason all three workflow
templates returned hard-coded strings: a `"use step"` function is bundled and
dispatched separately from the agent bundle and is handed no `ToolContext`, so
nothing in one could reach a credential. Two SDK exports close it, both on
`@alexkroman1/aai/step`:

- **`stepEnv` / `requireStepEnv`** (`packages/aai/sdk/step-env.ts`) — the agent
  env, published into the process by whatever is serving the workflow (the guest
  at bundle load, `aai dev` on every rebuild). The slot is a `Symbol.for` global
  rather than a module-level `let` precisely because the step bundle carries its
  own copy of the SDK, so the publisher and the reader are two module instances.
  Two rules come with it: once an env is published there is no per-key fallback,
  so what a step can read is exactly what `.env` and `aai secret put` declare;
  and an UNPUBLISHED slot falls back to `process.env`, which is what keeps an
  exported step callable from a spec with `vi.stubEnv` — which is how every one
  of these templates tests its steps.
- **`stepGenerate`** (`packages/aai/sdk/step-generate.ts`) — `ctx.generate`'s
  counterpart for a step: one `fetch` to the AssemblyAI LLM Gateway, on the same
  key and the same default model an agent's own pipeline resolves. It exists
  because `research-workflow` and `link-digest` had each hand-rolled the same forty
  lines and had already diverged on two of them (the empty-completion case, and
  which statuses are worth a retry). It is deliberately not the AI SDK: a step
  artifact bundles everything but the DevKit, so `ai` plus a provider would be
  megabytes on every deploy for one chat completion.

- **`stepGenerateJson`** (`packages/aai/sdk/step-generate-json.ts`) — the same
  call for a stage whose reply is a SHAPE, which is what both LLM templates
  actually wanted. It unwraps the ```` ```json ```` fence, parses, rejects a
  non-object and validates against a Standard Schema, and each of those four was
  re-derived per template — with the fence stripper already DIVERGED (one
  trimmed, one did not). Taking a schema is the point rather than a convenience:
  the predecessor was `askJson<Action>()`, a value the compiler believed and
  nothing checked, so a model answering with a plausible neighbouring shape
  flowed into the step's logic as if it had obeyed. It stays on the zod-free
  `/utils` because VALIDATION is a `~standard.validate` call and only JSON Schema
  CONVERSION needs zod — hence `sdk/standard-schema.ts`, the dependency-free half
  of `sdk/schema.ts`.

**The retry decision is `@alexkroman1/aai/step-errors`, and it is the one
subpath that reaches the DevKit.** `StepGenerateError.retryable` and
`isTransientStatus`/`retryAfter` are the SDK deciding; `FatalError` and
`RetryableError` are what the DevKit READS, and they belong to `workflow`, which
`/utils` may not import (the CLI's zero-dependency startup path). So the mapping
between them was left as a snippet in two module docs — and both templates that
needed it copied the snippet out of the doc, verbatim and character-identical.
`toStepError` / `throwStepError` / `throwFatalStepError` are that snippet, on a
subpath of their own so `workflow` is only in the graph of a caller that asked
for it (and a step artifact externalizes it anyway).

Three things the templates now demonstrate rather than restate:

- **`toStepError(response, message)`** — the three-way call `transcription-workflow`
  and `link-digest` had hand-written identically. Note the third outcome is not
  "the DevKit's backoff": a bare `RetryableError` retries in ONE SECOND, which is
  that class's own default, so a fan-out that all 429s together all asks again a
  second later. Passing the far side's `Retry-After` is what drains it.
- **`toStepError` reads `StepGenerateError.retryAfter`, which THREE of the four
  templates did not.** `research-workflow`, `link-digest` and `transcription-workflow`
  re-threw the error unchanged, so a rate-limited model call fell back to the
  default with the gateway's own number sitting unread on it. `redline` is the
  exception and worked the extra line out independently — which is the argument
  for extracting rather than a reason not to: the fourth author to meet a
  problem should not have to be the first to get it right.
- **`throwFatalStepError` is for the `catch` block specifically**, and the
  reason is mechanical: `FatalError` takes only a message — no `cause` — so
  constructing one inside a `catch` trips `useErrorCause` with no way to satisfy
  it. Taking the cause as an ARGUMENT is what fixes that. A `throw new
  FatalError(…)` that is NOT in a catch block stays exactly as it was —
  `link-digest`'s no-readable-text case is the worked example, and says so in
  place.

**`ctx.db` is still out of reach**, so every `file` step still writes nothing and
carries `_`-prefixed parameters rather than naming a call it cannot make. That is
the one remaining half of a tool context a step does not get.

**`report()` was the one helper copied three times, and it is the SDK's now** —
`@alexkroman1/aai/step`, used by every workflow template. The objection recorded
here (it imports `getWritable` from `workflow`, which that subpath may not) was
answered by the same `Symbol.for` slot `stepEnv` uses: `createServer` publishes
a reporter and the helper stays dependency-free. What forced the question was
not the duplication but the second reader — a step's narration now also reaches
the SERVER LOG, with the attempt number appended past the first, so a retrying
fan-out is legible without a page open. `packages/aai-ui/CLAUDE.md` carries the
argument.

The same sweep took two more copies with it: `isTransientStatus` (the
408/429/5xx split each template had spelled out) and `retryAfter`, which is what
lets a rate-limited step throw `RetryableError` with the delay the provider
asked for instead of the DevKit's default backoff. `transcription-workflow` and
`link-digest` are the worked examples. Both are now reached THROUGH
`toStepError` above — the extraction that stopped one function short.

**And the fake LLM gateway is the SDK's too** — `stubGateway`
(`@alexkroman1/aai/testing`), which `research-workflow` and `link-digest` had each
written: record the call, answer `{choices:[{message:{content}}]}`, switch on a
status. It records the `prompt` and `system` separately, which is what the
hand-rolled `promptOf(calls, n)` reach into `body.messages[n].content` was for.

**The INSTALLATION came out too, and it is what the leftover half taught.** This
guide used to say the three-line `vi.stubGlobal` wrapper was "the right half to
leave behind", on the rule that `sdk/testing.ts` carries no test-runner
dependency. That rule is right and the conclusion was not: four templates then
wrote the same wrapper, each with the same paragraph explaining why the SDK had
not. `installStubGateway` lives on **`@alexkroman1/aai/testing/vitest`**, a
subpath with `vitest` as an OPTIONAL peer, so importing it is what pulls the
runner. The rule that replaced the precedent — anything that INSTALLS and
anything that RESTORES belongs on that subpath — is in the root `AGENTS.md`.

**`link-digest` is the same mechanism at its smallest, and it is the FRONT DOOR
that separates both of these from `research-workflow`.** That one is a voice agent
that HANDS OFF to a run (a caller is on the line, so a tool starts one and
answers the turn); `link-digest` and `transcription-workflow` are declared with
`workflowApp()` and the workflow IS the product — no `stt`/`llm`/`tts`, no
tools, and a `client.tsx` that mounts with `page()` rather than `client()`.
Those fields are not merely omitted there: `StaticAgentParams` refuses them, so
a `systemPrompt` addressed to a model that never runs — which `link-digest`
shipped — no longer type-checks.

**`link-digest` really reads the page too.** `fetchArticle` fetches the URL and
reduces the HTML to text — crudely, on purpose, since a real extractor is a
readability implementation and a dependency; what it MUST do is drop `<script>`
and `<style>` CONTENT rather than just their tags, because stripping tags alone
leaves a page's JavaScript in the prompt, which is both expensive and a way to
smuggle instructions past the reader. `summarize` then asks for JSON and
validates the shape, and a reply that ignored the format throws PLAINLY where a
401 is fatal — a model may well obey on the next attempt.

The two steps are split because they fail differently: a rate-limited model call
replays the fetch from the journal instead of hammering a stranger's server
again. That is also why the article text is CAPPED — it is the rare case where
the payload really does have to cross the queue.

`link-digest`'s spec asserts the DECLARATION as well as those steps, and the
declaration half is what carries the template's shape: the `page` field, the
workflow's NAME (the page starts a run by that string, so a rename is a runtime
400 rather than a compile error), the input schema (both the call-site validation
and the JSON Schema `GET /workflows` serves), and `requiredEnv` — which is
load-bearing here in a way it is not for a voice agent, since a workflow app
declares no providers and so nothing else in its config names a credential.

**`template-page-mount.test.ts` correlates BOTH ends of the front door with the
agent that declares it** — the helper (`agent()` vs `workflowApp()`) and the
mount (`client()` vs `page()`). konsistent asserts only what every template
shares (a default export from `agent.ts`, the stylesheet import in
`client.tsx`): its predicates are "must import X" with no "one of", and no way
to read a value out of a SIBLING file to decide which — and a rule that merely
accepted either would pass the exact mistake worth catching, since a static
agent mounted with `client()` renders fine and then opens a `/websocket` the
server declines. `agent-default-export` used to require an `agent` import for
that reason and no longer can, the workflow-app templates calling `workflowApp`
instead.

**A `tools/` file IS the tool: it default-exports it, nothing imports it, and
`agent()` takes no `tools` field at all.** Discovery happens where
the bundle is assembled (`aai-cli/worker-bundler.ts` enumerates `tools/*.ts` and
emits static imports), because the guest sandbox is handed one ESM string and has
no directory to scan — the same lowering eve does. `toolRegistry` /`withTools`
(`@alexkroman1/aai/manifest`) own the rules, so the name grammar, the
default-export requirement, the flat-only rule and a duplicate name are one
implementation and each is a build error naming the file.

**All thirteen tool-declaring templates are files now, and the param is GONE.**
For a while six were not — `health-assistant`, `embedded-assets`,
`infocom-adventure`, `night-owl`, `recap-workflow` and `research-workflow`
declared theirs
inline, and this guide's own measurement missed them because it counted only the
templates that already had a `tools/` directory. That is what made the rule
conventional: `agent({ tools })` still worked, so "a tool is a file" was true of
seven templates and of nothing enforcing it. `tools` is now the
`InlineToolsMisuse` message on the parameter shape (a compile error naming the
file to create) AND a throw inside `agent()` — the second half is not belt-and-braces,
it is the only half a user's project ever runs, since neither bundler
type-checks user code.

Three things the conversion taught, each worth copying into the next one:

- **A slot-backed tool gets SHORTER in its own file.** A standalone tool file
  cannot annotate its context with a state shape, which is why session state
  belongs to the SLOT — so `infocom-adventure`'s eight tools are
  `gameSlot.tool()`/`gameSlot.updateTool()` calls with no annotation and no
  opening `slot.get`. That is the case those two were built for, and moving a
  tool out of `agent.ts` is what makes it visible.
- **Module state shared by two tools needs a module.** `health-assistant`'s two
  tools share one memoizing FDA-label cache; a cache per tool file would halve
  the memoization silently, so it moved to `fda.ts` and says so there. Same shape
  as `embedded-assets`'s search index and `infocom-adventure`'s
  `REPORTED_HISTORY` — a `-5` that two files answered with.
- **A workflow DECLARATION needs a home that is neither half.** `research-workflow`
  and `recap-workflow` reach a run by passing the definition rather than its name
  (which is what types the input), and four or five tool files each name it, so
  `workflow({ … })` moved from `agent.ts` into `shared.ts`. The `"use workflow"`
  BODY stays in `workflows/` — the WDK builder scans that directory.

It replaced 62 map entries whose whole content was
`snake_case_name: camelCaseImport`, and the reason was the silent failure rather
than the line count: add `tools/incident_close.ts`, forget the map line, and the
file compiled, lint passed, every gate was green, and the tool never reached the
model.

**A spec has no bundler in its path, so it does the same lowering with
`import.meta.glob`** and hands it to the same `toolRegistry`. The SDK ships that
call as **`withDiscoveredTools`** (`@alexkroman1/aai/testing`), and each affected
template's spec writes its own glob:

```ts no-check
const agentDef = withDiscoveredTools(authored, import.meta.glob("./tools/*.ts", { eager: true }));
```

**The glob is written in the template and not reached for from a shared helper,
and that is the whole lesson of the bug it replaced.** Five specs imported
`../../_discovery.ts` — this package's own helper — which resolves in-tree
and **does not exist in a scaffolded project**, so `aai test`, `aai build` (it
type-checks) and `npm start` were all broken for anyone who scaffolded
`pizza-ordering`, `plan-and-execute`, `retail`, `support-line` or `travel-concierge`,
while `check:template-types`, `templates.test.ts` and each template's own spec
stayed green — every gate in the repo runs IN the repo. `guard-invariants.mjs`
**rule 13** closes it: a template file may not import a path that escapes its own
template directory, resolved rather than pattern-matched (`../shared.ts` from
`tools/a.ts` is fine, `../../shared.ts` from the same file is not, and both spell
the same number of dots as a legal import one level up). Anything shared has to
be IN the template or on a published subpath.

`_discovery.ts` survives for `templates.test.ts` alone, which needs every
template at once and so needs a repo-wide literal pattern — `import.meta.glob`
is expanded at transform time and cannot take a variable. That file never ships,
so it is the one place the helper shape is still right.

It is deliberately not a `readdir` + `import()` either way — that would load the
tools through NODE's resolver instead of the test runner's, giving them a second
copy of the SDK, so a slot's module state would differ between the tool under
test and the agent holding it.

**Those are the only two ways in, and there are exactly two.** The other loader
with no bundler was `scaffold/server.mjs`, which now boots the BUILT worker — so
every path to a tool goes through a bundler or through a glob, and there is no
runtime directory scan in the repo (see "Self-hosting is the scaffold's default"
below).

Note what this DROPS: a `tools:` map checked each tool's assignability against
the agent's state type, so a tool whose state shape disagreed was a compile error
at the map. `toolRegistry` checks shape at build time and no state type at all —
the slot is what carries that guarantee now, which is most of why `sessionSlot()`
exists, and there is no per-agent state type left for a map to have checked.

The one thing a template may still hand-roll here is a **fallback that would
cost the browser bundle**: `retail`'s client builds its empty view from a
seedless `emptyRetailState()` rather than from the projection, because the
slot's factory pulls a 107 KB `seed.json` and importing it would ship the whole
catalog to the browser. It says so in place.

That is now the ONE exception to the rule the other six follow: **compose the
projection in the module that declares the slot, and import it at both ends** —
`syncState: cartProjection` on the agent, `useAgentState(cartProjection)` in
the client. It used to be composed twice, once per end, with the client
deriving its empty frame by calling it with `undefined` and restating the view's
type a third time on the hook. Nothing checked that the two compositions named
the same view. Note the LINE COUNT barely moved (measured: net +4 code lines
across the six, most of that a Biome import reflow) — this is a
single-source-of-truth change and a memoization fix, not a volume one, which is
the honest shape of most remaining wins at this seam.

## `system-prompt.md` IS the system prompt

The same rule as `tools/`, applied to the one part of an agent that is a
DOCUMENT rather than a value. Fourteen templates keep a `system-prompt.md`; not
one imports it, and only `pizza-ordering` declares a `systemPrompt` at all —
because it composes (the file plus `menuText()`). `night-owl/agent.ts` is three
fields.

`withSystemPrompt` (`@alexkroman1/aai/manifest`) owns the rules, and the reason
it is worth a function rather than an assignment is the third one:

- The def carries the framework default → the file becomes the prompt.
- The def's prompt CONTAINS the file's text → the author imported and composed
  it; left exactly as built.
- Neither → a `system-prompt.md` exists and nothing reads it. **Build error.**

**That error exists because "I edited the prompt and nothing changed" is the
silent-absence failure tool discovery was built to kill, pointing the other
way** — and it is worse here: a prompt is edited far more often than a tool is
added, and a prompt that is quietly ignored produces an agent that behaves
plausibly and wrongly rather than one that visibly cannot do something. An empty
file is an error too, for the same reason.

**The check compares VALUES, and that is what makes it possible at all.**
The plan for it expected to ask rollup's AST whether
`agent.ts` imports the file — the entry is generated BEFORE the build, so there
is no module graph to ask, and a source scrape is fragile. The resolved prompt
answers it directly and answers a better question: an AST can only see that a
file was IMPORTED, while an import whose value never reaches `systemPrompt` is
exactly the bug. Composition then needs no special case.

`greeting` stays a field, and `sttPrompt` too: one sentence with no structure to
lose, crossing the wire in `/client-config` beside `name` and `page`. The line is
**a document goes in a file, a value stays in the call**.

`_discovery.ts` resolves the prompt for `templates.test.ts` the way it resolves
tools, so an empty or orphaned prompt file fails for every template at once. Its
non-vacuity guard is worth copying: the first version derived "which templates
have a file" from the SAME glob it was checking, so breaking the pattern changed
nothing — verified by A/B. It reads the filesystem instead.

**There is deliberately no TEXT-mode template, and the allowlist records
it.** A template is a starter the platform DEPLOYS — `templates.test.ts` loads
each `agent.ts` and validates the config a voice session is built from, and the
studio's `use_template` copies one into a workspace that gets deployed next.
`agent({ text: true })` has no session to deploy (`createRuntime` refuses it by
name), so a text template would be a starter nothing downstream can run.
`TextAgentParams` therefore sits in `template-api-allowlist.json` beside
`PipelineAgentParams` and `S2sAgentParams`, which are unexercised for a
narrower reason — they are the union arms `agent()` derives from, and an author
never names one. `createTextAgent`'s worked example is the studio's own coding
agent (`packages/aai-guest/CLAUDE.md`), which is a better one than a template
could be: it is a real agent doing real work, on the same SDK it builds with.

## A gate spec's SOURCES are shared; its assertions are not

`_gate-support.ts` holds what every gate spec here reads and none of them owns:
`GATE_WIRING` (the three files a gate must be NAMED in — `package.json`,
`scripts/check.sh`, `.github/workflows/check.yml`), `ERE_UNSUPPORTED` (the regex
constructs POSIX ERE has no answer for, banned by both pattern-shipping gates),
`repoPathOf` (a Vite glob key as a repo-relative path), `sole` (the one value a
single-file glob resolved to), `byCodeUnit` (the explicit comparator the repo
requires of anything a gate reads) and `numericConstant` (a cap read out of a
gate script's source rather than restated). The wiring block alone stood in FIVE
specs at seventeen lines each, differing only in the gate name the caller then
asserts; `sole` replaced two dozen reads that spelled the globbed path TWICE,
once for the transform and once to index the result — a pair that drifted would
have read `undefined`, i.e. a gate checking an empty string.

Sharing them is safe precisely because none of it is an assertion: each spec
still makes its own, over its own gate, and a glob that stopped resolving leaves
`GATE_WIRING`'s values `undefined` so every caller's `toBeTypeOf("string")`
fails. What must NOT move here is a positive/negative sample or a floor — the
per-gate discipline is the whole point of these files, and one spec asserting
another's samples is the vacuous-guard failure they exist to prevent.

`import.meta.glob` is a compile-time transform, so a caller cannot hoist the
pattern OR the options object into a constant. It can import the result, which
is the only reason this module works — and it is why the glob-per-source shape
stays wherever a spec reads a source only it cares about.

It never ships (nothing under `templates/` or `scaffold/` may import it, and
`guard-invariants` rule 13 enforces that), so it is in the same position as
`_discovery.ts`: the shared-helper shape is right here and wrong inside a
template.

## A new guard-invariants rule, and what the linter cannot do for you

Two things any new rule must respect, and `guard-invariants-gate.test.ts` is
where both are asserted.

**A pattern that matches nothing prints the same checkmark as a rule being
upheld**, so the spec feeds every rule a positive sample it must catch and a
negative twin it must spare, importing the rules as real values rather than
scraping them out of the source. Rule 4 shipped its first draft with `[^)]*`
between `new Promise(` and `setTimeout(`, which cannot cross the arrow's own
parameter list — 0 reported against five real occurrences, the same
silently-dead-pattern shape as the `\b` bug in `check-escape-hatches.mjs`. And
**the rules module matches most of its own rules**, since every `label` and `re`
describes what it bans; it, the gate, the baseline and the gate's spec are all in
the script's `SELF_REFERENTIAL` set. That is the third and fourth time this trap
has been paid for.

### `vitest-setup-wiring.test.ts` — a gate is only as wide as its rollout

`scripts/fail-on-process-warning.mjs` re-raises `MaxListenersExceededWarning` as
an unhandled error, turning Node's only built-in leak detector into a failure.
Measured before it existed: a test attaching 25 listeners to one emitter PASSED
while printing the warning into a scrollback CI's `dot` reporter buries.

**The signal was already trusted twice, which is the argument FOR enforcing it in
tests.** `aai-guest/harness-leak-watch.ts` watches it at RUNTIME in the guest,
written because Node warns exactly once per emitter (measured there: 500
listeners, one warning, at 11) — which is what made the `streamTail` leak of
\#1203 expensive to diagnose from a log. And `aai/host/transports/
pipeline-transport.ts` raises the threshold with `setMaxListeners` under a
comment calling it "A LEAK threshold, not a capacity one". So a leak reaching
production is watched; a leak a suite already provokes is what this closes.

Measured over the whole unit run (536 files, 7998 tests): **nine occurrences,
all nine in `aai-guest/harness-leak-watch.test.ts`**, whose subject IS the
warning — it synthesizes them through `process.emit` and attaches 88 real
listeners to a real emitter. That suite sets
`globalThis[Symbol.for("aai.expectsProcessWarnings")]` at module scope, which is
the one legitimate opt-out; every other suite is clean, so the rule is absolute
rather than baselined. `vitest-setup-wiring.test.ts` asserts the opt-out has
exactly ONE user, because an exemption nobody counts is how a gate narrows with
no diff saying so.

**Only `MaxListenersExceededWarning` fails a run.** Failing on every
`process.on("warning")` would fold in `DeprecationWarning` /
`ExperimentalWarning` from dependencies we do not control, which is how a gate
gets muted rather than fixed.

**What this spec guards is the ROLLOUT, because a partial one looks identical to
a complete one.** `setupFiles` is an ARRAY, so a package config writing
`setupFiles: ["./_jsdom-setup.ts"]` after `...sharedConfig.test` REPLACES the
shared list rather than extending it — no error, no warning, that package simply
stops being gated. FOUR of the nine packages declare their own — plus
`vitest.slow.config.ts`, a fifth config — so that is five chances to opt out
silently, and the tenth package added will be a sixth. It is
the same trap the root guide records for `test` itself, where it cost every
package its `reporters`; that one was found by reading, this one is mechanical.
The spec asserts against config SOURCE rather than a loaded config object
deliberately: a resolved array is what is right today and silently regresses on
the next edit — the spread is the invariant.

Two mechanical notes on the script, both load-bearing. The listener installs
once per PROCESS via a marker property read off `process.listeners("warning")`:
`setupFiles` runs per test FILE and `process` is itself an EventEmitter capped
at 10, so a plain `process.on` here would trip the gate on ITSELF around the
eleventh file in a worker — correct code reported as a leak, by the leak
detector. And it throws from a `queueMicrotask` rather than from the listener,
so the failure does not unwind whichever call site happened to add the listener.

### Rule 23 exists because Biome cannot see a `node:` builtin

Biome's `noFloatingPromises` / `noMisusedPromises` are ON, so a rule duplicating
them would be noise. Measured against Biome 2.5, what they DO catch: a floating
call in local or relatively-imported source, from a third-party package
(`p-timeout`, `zod`), from a global (`fetch`), a `.then` chain with no rejection
handler, `Promise.all`, a promise in a boolean position, and an async callback
passed to a **locally-declared** `() => void` parameter.

What they report NOTHING for is every promise whose type comes from a `node:`
module: `writeFile` (node:fs/promises), `pipeline` / `finished`
(node:stream/promises), `setTimeout` (node:timers/promises), `resolve4`
(node:dns/promises), `once` (node:events) — and the two that matter most here,
`EventEmitter.on(…, async …)` and `AbortSignal.addEventListener(…, async …)`.

Three hypotheses were tested and all three are wrong, which is worth recording
so nobody re-tests them: it is not a resolution failure (`@types/node` resolves
from the package), not a `Promise<void>` exemption (both are caught when declared
locally), and **not fixable by re-exporting** — routing the import through a
local `export { writeFile } from "node:fs/promises"` restores nothing, because
the blindness follows the type's ORIGIN rather than the import path.

**typescript-eslint cannot close it.** Its type-aware rules need
`ts.createProgram` and a `TypeChecker`; `typescript@7.0.2` exports only
`lib/version.cjs` plus the `unstable/*` subpaths, which is the same constraint
that makes `docs/` pin `typescript@~6`. Linting with a second compiler the repo
does not build with is a worse trade than the gap — so if that pin ever moves,
re-measure the list above before retiring rule 23.

**The floating half is deliberately NOT a rule.** `readFile(…)` written as an
arrow expression body that legitimately RETURNS the promise is indistinguishable,
line-wise, from a floating statement, and three of the tree's occurrences are
exactly that — a rule flagging correct code is one that gets muted rather than
fixed. The listener half has no such twin, which is why it is rule 23.

## `check.yml`'s push list and concurrency group are specced here

`ci-gate-job.test.ts` guards the `ci` job — the single required check — and it
also owns the two facts about WHEN that workflow runs, because both are the
shape this package's gates exist for: config that looks live while checking
nothing.

**The push list is `main` and nothing else.** `changeset-release/main` sat beside
it and was a straight duplicate: a Version Packages PR targets main, so the
`pull_request` arm already covers that branch, the two runs land in different
concurrency groups (`check-<number>` vs `check-<sha>`), and nothing dedupes
them — every push to a version PR ran the whole matrix twice. 97 such push runs
are in the history, and they stopped on 2026-08-07 when `RELEASE_TOKEN` went
dead: `GITHUB_TOKEN` cannot trigger a workflow, which `release.yml` warns about
itself. So the entry fired nothing, was invisible in a diff AND in the run list,
and would have silently resumed double-running the moment the token was rotated.

**The push concurrency group is per-SHA, and that is what makes
`cancel-in-progress: false` mean anything.** GitHub keeps at most ONE pending run
per group and cancels it when a newer run joins, so declining to cancel the
IN-FLIGHT run does not save the QUEUED one. With every commit on main sharing a
single `github.ref` group, each main run died at the exact second the next merge
arrived — measured over 28 consecutive main pushes: 5 cancelled, every one's
`updated_at` equal to the next run's `created_at`, and nothing reaching a verdict
on main across five merges between 16:00 and 21:57 on 2026-08-18. That is
precisely the "gap in its history exactly where it is merging fastest" the
workflow's own comment says the setting prevents. The pull-request side stays
keyed on the PR NUMBER: a PR's `github.sha` is the merge ref and changes on every
push, so a bare per-SHA group there would supersede nothing.

Both specs were A/B'd against the old config before landing — the non-vacuity
rule every gate in this package carries.

## What `tsconfig.json` includes is what gets type-checked

A test file is imported by nothing, so tsc only sees it if `include` names
it — a package guide's worth of files can be silently unchecked. This one had
three: `escape-hatch-scope.test.ts`, `template-api-coverage.test.ts` and
`test-assertion-gate.test.ts` were listed nowhere and type-checked by nothing,
under a comment that describes exactly that failure mode. `include` now globs
`*.ts` (this directory only — `scaffold/` is checked separately by
`check:template-types`, under the scaffold's own looser tsconfig). Verify with
`tsc --noEmit --listFiles`, which prints the program's real file list, or by
injecting a type error into a file you expect to be covered.

## Self-hosting is the scaffold's default

`scaffold/server.mjs` plus the `prestart`/`start` pair ship in every project, so
**any** project runs on its own with `npm start` — no platform account, nothing
managed. Every mechanism in it is the CLI's (`aai build --skip-tests` produces
the `.aai/worker.mjs` the server imports, `aai eject` back-fills the file into
older projects, and `aai-cli`'s e2e leg is the only tier that can prove any of
it), so **the account lives in `packages/aai-cli/CLAUDE.md`, "Self-hosting is
the scaffold's default, and it runs the BUILT worker"** — including why there is
no runtime `tools/` scan anywhere, and why `ctx.env` and provider credentials
come from different places.
