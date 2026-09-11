# packages/aai — SDK guide

The shared core SDK (`@alexkroman1/aai`). Repo-wide commands, conventions,
testing rules, and the changeset/PR workflow live in `AGENTS.md`;
platform behaviour lives in `packages/aai-server/CLAUDE.md`.

## SDK structure

The SDK is organized into two directories with a **hard dependency boundary** —
this split is critical for sandbox security:

- **`sdk/`** — shared modules with **zero Node.js dependencies**. Safe to run in
  browsers, Deno, and sandboxed environments: the types, the wire protocol, the
  canonical serializable config (`agent-config.ts` + `toAgentConfig`), Standard
  Schema acceptance (`schema.ts`), the `agent()`/`tool()`/`sessionSlot()`
  authoring helpers (`define.ts`, `session-slot.ts`), the provider DESCRIPTOR
  factories, and the concurrency primitives above.
- **`host/`** — host-only modules that **require Node.js APIs**
  (`node:child_process`, `node:fs/promises`, `node:dns/promises`, `node:net`,
  …). Only runs on the platform server and CLI, never inside a
  guest sandbox: `server.ts`, `runtime*.ts`, `session-core.ts`, `s2s.ts`,
  `ws-handler.ts`, `tool-executor.ts`, `builtin-tools.ts`, `postgres-db.ts`,
  `telephony/`, `providers/` (the STT/TTS openers and the descriptor→instance
  resolvers), and `transports/` — the S2S / pipeline / OpenAI Realtime
  `Transport` implementations, including `pipeline-turn-outcome.ts` (the three
  ways a pipeline turn ends: interrupted by barge-in, failed, or spoken) and
  `pipeline-transport-lifecycle.ts`, the once-per-CALL half of pipeline mode
  split from the turn orchestration on exactly the line "a failing TURN is not a
  failing SESSION" draws.

**Rule**: When adding new SDK code, place it in `sdk/` if it has no `node:`
dependencies. Moving code from `sdk/` → `host/` is safe; moving `host/` →
`sdk/` requires removing all Node.js imports first.

The guest harness (`packages/aai-guest/src/harness.ts`) runs **Node** inside each
Modal Sandbox — the same runtime as the host and `aai dev` — loading the agent's
ESM bundle directly; the Modal sandbox (not a language runtime permission model)
is the security boundary.

## Package exports

Twenty-two subpaths, nineteen of them mapped below. What decides which
one a symbol lives on:

### The root barrel is CURATED, and `export *` is what broke it

`index.ts` used to re-export `sdk/constants.ts` and `sdk/utils.ts` wholesale —
the repo's SHARED modules (every magic number; the zod-free helpers the CLI
loads on every invocation) — so a wildcard put a jitter-buffer depth, a
WebSocket close code and the platform's slug regex in an agent author's
autocomplete beside `greeting`. Measured before the split: **175 exports, 71 of
them `@internal`, and 160 unused by any of the fourteen templates** — eleven
symbols covered every one. It is 98 now (count it in `API-EXPORTS.json`) and
**none is `@internal`**, the property to preserve. `sdk/utils.ts` came back
WHOLE (`safeJsonParse` was here and `isRecord`, its result's guard, was not);
`sdk/constants.ts` is gone entirely.

The membership test: **a symbol belongs here if an `agent.ts`, a tool module,
or a `workflow()` would NAME it.** Two corollaries. A budget the framework
enforces on its own does not qualify however public it is (`PLAYBACK_FILL_MS`,
no field sets it) — and neither does a value whose only use is READING BACK what
the framework already did, which is what finished the constants off. Twenty-one
`DEFAULT_*`/`MAX_*` names survived the first cut because each documents an
`agent()` field — which the field's own JSDoc already does, with the value. No
template, scaffold or line of the shipped authoring guide named one, and the
readers who do (a client sizing a buffer, a harness matching the host's
endpointing, a test asserting a shipped value) are framework code.
`DEFAULT_SYSTEM_PROMPT` is the single survivor, and it passes the test for a
different reason than the one recorded here for a long time. **`agent({
systemPrompt })` does NOT replace the prompt** — `buildSystemPrompt` always
emits the voice sections and APPENDS the author's rules under a precedence
header, so the "compose against the constant" recipe this guide and the
constant's own `@example` taught emitted ~10,000 characters TWICE, under two
precedence headers arguing with each other. The constant is exported to be READ
(printed while tuning, diffed across versions, asserted on), and
`buildSystemPrompt` now STRIPS a leading verbatim copy, so a prompt that still
interpolates it is byte-identical to one stating only the domain rules.

Nothing was deleted: budgets and defaults went to `./internal`, the slug/CLI
contracts and wire helpers to `./utils`. **`index.ts`'s module doc holds the
test in full and is the only thing enforcing membership — keep it accurate.**

## One epoch classification the tool cannot make

A worked example for the epoch rules in the root `AGENTS.md`. **`aai:defaults`**
cannot be bumped at all — the hash reads the rolled-up declaration with doc
comments stripped, so `DEFAULT_SYSTEM_PROMPT`'s CONTENT and the documented recipe
for composing against it can both change while `--bump` refuses ("still matches
epoch N"). That change is a changeset-and-review matter, not a gated one.

The other shape — a signature change breaking frozen examples at several
superseded epochs, which `--bump --drop` cannot reach because it classifies only
the current one — cannot arise today, and now by construction: every capability
was reset to epoch 1 and nothing is retained, so there is no frozen example to
break. See "Every capability restarts at epoch 1" in `docs/CLAUDE.md` for why
the history went, and for the one condition that makes it wrong to do again.

## Subpath export → file mapping

Tracing imports through barrel files can be confusing. Here's the map
of subpath exports in `aai/package.json`:

| Import path | Resolves to | What it contains |
| --- | --- | --- |
| `@alexkroman1/aai` | `packages/aai/src/index.ts` | The AUTHORING surface, and only that: `agent()`/`tool()`/`sessionSlot()`/`workflow()`, the types they take and return, and `assemblyAIPipeline()`/`assemblyAIS2s()`. One constant, `DEFAULT_SYSTEM_PROMPT`, because an author READS it. See "The root barrel is CURATED" above |
| `@alexkroman1/aai/testing` | `sdk/testing.ts` (direct) | Test helpers for an agent author's OWN project, which is why they are published. `createToolContext(overrides?)` builds a full `ToolContext` with inert defaults, a recording `send` (`ctx.sent`) and a distinct `sessionId` per call; `createStubWorkflows()` is the rejecting `ctx.workflows` it defaults to (the rejecting `db` is internal now). Then the fakes a tool's COLLABORATORS are driven by — `stubGenerate`, `stubGateway`/`stubUploads`, `createRunSnapshot`/`createProgressStream`, and `toolOf`/`runTool` for reaching a tool by the name the model calls it by. **`deployedAgent(def, { tools, systemPrompt })`** is the one a project whose tools are FILES cannot do without: `agent.ts`'s default export carries only the INLINE tools, so a spec passes `import.meta.glob("./tools/*.ts", { eager: true })` and gets the def a DEPLOYED agent runs, system prompt included. It takes the glob's RESULT (`import.meta.glob` cannot take a variable), and a `readdir` + `import()` is refused: that resolves the tools through Node and hands them a second copy of this SDK. Generic over `ToolBearingAgent`, which keeps `AgentDef` and the sixteen declarations behind it off this subpath's contract. Four more shipped for the templates (a spec cannot import from a sibling): **`expectToolOk`/`expectDialogOk`** unwrap a dialog tool's envelope and FAIL at the call quoting the refusal, where the cast they replace reads `undefined` off a `ToolFailure` and dies several assertions later; **`parseToolInput`/`toolInputIssues`** (plus `parseSchemaInput`/`schemaInputIssues` under them, for a WORKFLOW's input) replace reaching through `["~standard"].validate`, which may be sync or async, so a missing `await` leaves `.issues` undefined and the negative test passes for the wrong reason; and **`stubTranscribe`**, staging a refusal as an HTTP STATUS so the SDK's own `transcribeFailure` sets `retryable`/`retryAfter` — a fake minting that error would assert the classification the spec is testing. **`expectDialogRefused`/`dialogRefusalPattern`** are the unwrap's mirror; `_dialog-refusal.ts` owns the sentence both read. **`dialogResultSchema`** is that envelope as a zod schema, for an eval reading a serialized result through `toolResultIn`. `createToolContext` takes `ToolContextOverrides` (each field also accepting `undefined`, run through `omitUndefined`), because `Partial<ToolContext>` under `exactOptionalPropertyTypes` forced specs into the conditional spread rule 22 counts as debt; `runTool`'s args and ctx are optional, told apart by SHAPE, an omitted context being a DISTINCT session. `stubUploads` answers `{ restore, writes, read }` like its three siblings rather than a bare thunk — the breaking change that dropped the `aai:testing` epoch. **`createToolContext`'s `generate`/`delegate` also take a SCRIPT**, not only a function — the fake is built for you and exposed as `ctx.model`/`ctx.desk`, so the `stubGenerate` → destructure → `createToolContext` three-step is one call. A FUNCTION in either position is always the seam itself, since a `GenerateFn` and a top-level route function are indistinguishable at runtime. `ctx.model`/`ctx.desk` are always present and simply unwired (empty `calls`) when the caller brought its own function, the rule `sent` already follows for `send`. **`scriptedToolContext({ generate?, delegate?, …overrides })`** predates that and still answers `{ ctx, model, desk }` — three template specs had hand-rolled it — but `createToolContext` is the way in now. A `{ text }`-only script is refused at COMPILE time and at bind: it used to type-check and then read as a route table keyed by the system prompt `"text"`, rejecting every call. The compile refusal is NOT the misuse arm speaking — see "A misuse arm is defeated by a shape-competing sibling" below. **`runGuardrail(def, text, answer?)`** calls a subagent's guardrail the way the runtime does and THROWS on a def with none or a verdict that is a promise, so a spec asserts on `true \| string` rather than a union with `Promise`. Each helper's own doc carries the rest |
| `@alexkroman1/aai/testing/vitest` | `sdk/testing-vitest.ts` (direct) | `installStubGateway(replies, opts?)` — the fake above, installed as the global `fetch`, returning its call log. A helper belongs here only when its remaining content is the installation — the fake itself stays framework-agnostic next door |
| `@alexkroman1/aai/utils` | `sdk/utils.ts` (direct, not a barrel) | The zero-dependency helpers a TOOL body reaches for, and nothing else: `errorMessage`/`errorDetail`, `responseErrorMessage`, `safeJsonParse`, `toolFailure`/`isToolFailure`, `pushCapped`, `isRecord`, `omitUndefined`, `createKeyedLock`/`withLock`, and the four narration formatters `formatBytes`/`formatDuration`/`countWords`/`plural` (`sdk/format.ts`), plus `decodeHtmlEntities`. Twenty exports. The fifteen helpers are on the ROOT too, so this is the path for a tool body that wants one without naming the root; **the four formatters and `decodeHtmlEntities` are reachable only here**, and deliberately — their reader is BOTH a `workflows/*.ts` step and a `client.tsx` (a run narrates itself, a page renders the same run), and `/utils` is the path a browser bundle takes without pulling zod's graph. Non-localized permanently, each output pinned to the character in `format.test.ts`: `Intl` answers to the host's ICU default, so one run would render differently on a laptop and in a sandbox. The duplication they replace was a live bug — `call-audit-workflow` printed one recording as `1:04:09` from a step and `64:09` from `client.tsx`. `plural(n, one, many?)` returns the WORD, not the count. **It was 79**: the membership rule was a BUILD property (zod-free), a fact about its graph rather than an audience. The STEP vocabulary is `/step` now, the platform contracts and wire helpers `/internal`. `createKeyedLock`'s `p-timeout` is the one exception to zero-dependency; its module doc owns it |
| `@alexkroman1/aai/step` | `sdk/step-barrel.ts` | The vocabulary a step is written against, from one import path — the half of `/utils` that has an AUDIENCE rather than a build property. `mapConcurrent` (a WINDOW over a cursor) and `mapSettled`/`partitionSettled` (the same window settling each item into a `Settled<T, R>` beside it, for a tool on a live call; `Infinity` is the `allSettled` width), `stepEnv`/`requireStepEnv` (a step body has no `ToolContext`), **`stepDelegate`** (a whole tool LOOP — `ctx.delegate` for a body, on a published slot), **`stepFetch`** + `multipartBody` (HTTP/1.1-pinned), `stepReport`/`stepEmit` (what a page's progress stream renders), `stepGenerate` (one `fetch` to the LLM gateway on the agent's own key) and `stepGenerateJson`/`stripJsonFence`, and the audio round trip both ways — **`stepWriteUpload`**/`stepReadUpload`/`stepUploadInfo`/`stepRequireCompleteUpload`, **`stepSpeak`** + `encodeWav`, and `stepTranscribe`{`Upload`,`Submit`,`Poll`} for the async job API or `stepTranscribeSync` for the one-request one. Plus `isTransientStatus`/`retryAfter`. **The module doc owns the rest** |
| `@alexkroman1/aai/step-errors` | `sdk/step-errors.ts` (direct) | `toStepError`/`throwStepError`/`throwFatalStepError`/`stepFetchOrFail` — the failure a step throws, classified into this repo's own `FatalError`/`RetryableError` (`sdk/step-error-classes.ts`, published here too); **`throwFfmpegStepError`**, the one arm whose default is INVERTED (anything it does not recognise as `timeout`/`aborted` is fatal, where `toStepError`'s default for an unclassified cause is retryable pass-through — a separate name is what keeps that polarity visible); and the seven **`*OrFail`** callers (`stepGenerate`/`stepGenerateJson`, the four transcription entry points, and `sendToChannel`), each being the underlying call and `throwStepError` and nothing else. The raw calls stay: importing from HERE is the opt-in, because whether a terminal failure burns a step's remaining attempts is the caller's call. Its own subpath because it is the one authoring module that OWNS the retry vocabulary — the two error classes the engine reads — which `/utils` may not carry. **The ffmpeg guard is STRUCTURAL, not `instanceof`, and `sdk/tsconfig.json` is why**: that second program compiles with `types: []`, so a module reachable from `sdk/` may not import a `node:` builtin *and may not name a Node TYPE either* — `FfmpegError.signal` is `NodeJS.Signals \| null`, and a node-free split reports `TS2503: Cannot find namespace 'NodeJS'` against the HOST file rather than the sdk file that pulled it in. |
| `@alexkroman1/aai/channels` | `sdk/channels-barrel.ts` | Where a run's output GOES: `slackChannel({ webhookUrl })` names a destination, `sendToChannel` posts a `ChannelMessage` to it. A descriptor is serializable `{ kind, options }`, like a provider's. Slack's two webhook URLs take DIFFERENT bodies, so `text` is required; `isSlackWebhookUrl` is a SECURITY boundary. The barrel's doc owns the rest |
| `@alexkroman1/aai/slugify` | `host/slugify.ts` (direct) | `slugifyName` — how a human name BECOMES a slug (transliterating, `decamelize: false`), for the CLI, the platform server, and the studio. Separate from the contract in `sdk/slug.ts` on purpose: that one is dependency-free and rides every agent bundle, this one pulls the transliteration tables. Nothing on the SDK hot path may import it |
| `@alexkroman1/aai-runtime` | `host/runtime-barrel.ts` → 11 modules | Full Node.js runtime: session, S2S, server, tools, WS handler |
| `@alexkroman1/aai/workflow-api` | `sdk/workflow-api-barrel.ts` → 4 modules | The CLIENT of everything a deployed agent answers — the surface for a caller OUTSIDE the agent (a page, a script, a cron job). **`createAgentClient` is the one to reach for**: one object over `config()` and every workflow route. The page that bundles it is why `sdk/client-config-path.ts` exists. **The SERVER's half left for `/internal`** (`clampWorkflowWait`, `MAX_WORKFLOW_WAIT_MS`, `TERMINAL_WORKFLOW_STATUSES`, `WORKFLOW_API_PREFIX`) — nothing a caller writes. **A lone in-repo importer is NOT the test**: six more names have only `aai-runtime` too and stay, being the parameter and member types of `WorkflowClient`/`WorkflowDef`, so moving them fails the docs build. The barrel's doc argues it — read that before trimming further. `aai-ui`'s guide owns the HTTP surface and the iterators over it; each module's doc carries why |
| `@alexkroman1/aai/protocol` | `sdk/protocol.ts` (direct, not a barrel) | Wire-format Zod schemas, `lenientParse()`, `SessionCommand`, `SessionEvent` |
| `@alexkroman1/aai/manifest` | `sdk/manifest-barrel.ts` → 3 modules | `toAgentConfig()`, `agentToolsToSchemas()`, `AgentConfig`/`ToolSchema` + their Zod schemas, config-rule asserts. (The subpath name is historical — the old `parseManifest()`/`Manifest` layer was deleted; renaming the published subpath wasn't worth the break.) |
| `@alexkroman1/aai/stt` | `sdk/providers/stt-barrel.ts` | STT provider factories + options (`assemblyAIStt`, `deepgramStt`, `elevenLabsStt`, `sonioxStt`) |
| `@alexkroman1/aai/llm` | `sdk/providers/llm-barrel.ts` | LLM provider factories (`anthropicLlm`, `openAILlm`, `googleLlm`, `mistralLlm`, `xAILlm`, `groqLlm`, `openRouterLlm`, `gatewayLlm`, `assemblyAILlm`); eight of the nine take one shared `ModelOptions` rather than eight byte-identical `{ model: string }` interfaces |
| `@alexkroman1/aai/tts` | `sdk/providers/tts-barrel.ts` | TTS provider factories + options (`cartesiaTts`, `rimeTts`, `assemblyAITts`), the voice catalog, and `ttsVoiceIds(language?)` — the catalog as the non-empty tuple `z.enum` takes, falling back to the default voice on an empty filter |
| `@alexkroman1/aai/s2s` | `sdk/providers/s2s-barrel.ts` | S2S provider factories + their options (`openAIS2s`; the root re-exports `assemblyAIS2s`) |
| `@alexkroman1/aai/tools` | `host/agent-tools.ts` (direct, not a barrel) | Keyless network builtins callable from user tool code: `fetchJson`, `visitWebpage`, `webSearch`. All three ANSWER `T \| ToolFailure` — a builtin's failure is its result, not a throw — so a caller that names a shape narrows with `isToolFailure`. Typed as a bare `T`, all three callers in this repo turned a live DuckDuckGo 403 into "the web has nothing" |
| `@alexkroman1/aai/coding-tools` | `host/coding-tools-barrel.ts` | The workspace tool set for an agent that edits CODE: `createCodingTools({ dir })` answers the nine tools such an agent turns out to need — `read_file`, `write_file`, `edit_file` (a surgical replace, with a diff), `delete_file`, `list_files`, `glob`, `grep`, `bash`, `todo_write` — keyed by the names the model calls, over ONE directory and reaching nothing outside it. It was the studio coding agent's, in a private package, tangled with a type check and an npm reifier; what survives deleting those is most of it. Three seams a host fills: `validate` refuses a write BEFORE it lands (the studio parses the file — one that does not parse cannot be edited back into shape by text matching, so writing it strands the turn), `afterWrite` appends to a write that SUCCEEDED (diagnostics, inside the result that caused them), and `env` is `bash`'s child environment, defaulting to this process's — right for a CLI, wrong for a sandbox, which hands it an allow-list. `CODING_TOOL_DESCRIPTIONS` plus the four limits ride along because an override has to quote the number the code enforces. The machinery UNDER them — the edit matcher, the grep, the capped spawn — is `/host-internal`, whose reader is the framework. **Node-only**, and the worked example is `templates/coding-agent` |
| `@alexkroman1/aai/ffmpeg` | `host/ffmpeg.ts` (direct) | ffmpeg from a step — `runFfmpeg`/`probeMedia`/`transcodeToWav`/`describeMedia`; why, in `aai-guest/CLAUDE.md`. **Node-only** — see the note below the table |
| `@alexkroman1/aai/html` | `host/html.ts` (direct) | Somebody else's markup, from a step: `htmlToText`, `parseFeed` (RSS/Atom/RDF), `pageMetadata`. Delegates to `htmlparser2`/`html-to-text`, already carried here for `page-design.ts`/`web-search.ts`/`builtin-tools.ts` and exposed by no subpath — so both scraping templates had written ~65 lines of parser. **Node-only** — see below. Three functions, not a toolkit: a step wanting the DOM adds `htmlparser2` itself. `decodeHtmlEntities` stays on `/utils`, unsuperseded — six entities, no dependency, for a `client.tsx` |
| `@alexkroman1/aai/step-files` | `host/step-files.ts` (direct) | The upload ↔ local-FILE plumbing an ffmpeg step spends most of its lines on (ffmpeg needs a real path: a pipe cannot seek an m4a's trailing `moov` atom, and piped output is capped at 64 MiB). `withTempDir` (a temp directory whose lifetime is a lexical scope), `readUploadToFile` (windowed `stepReadUpload` → a path; with no `size` the file must be COMPLETE — see `stepRequireCompleteUpload`), `writeUploadFromFile` (a path → `stepWriteUpload`, streamed) and `STEP_FILE_WINDOW_BYTES`. **A subpath of its own, not `/step`**: `/step` is an `sdk/` barrel — 28 modules, zero `node:` builtins — and `sdk/` must stay runnable in a browser and in Deno, which `sdk/tsconfig.json`'s `types: []` makes a compile error rather than a convention. This module lives in `host/` and reaches exactly three builtins; `host/step-files.import-graph.test.ts` pins both halves. `writeUploadFromFile` absorbs the COMPOSITION rather than exporting a `fileChunks` generator, so the reused-read-buffer aliasing trap two templates each warned about in prose has one home and one spec (A/B-verified: deleting the `.slice()` fails the round trip). `readUploadToFile` advances by what was actually READ and stops short, where both templates strode by the window size and would leave a hole mid-file on a streamed upload |
| `@alexkroman1/aai/internal` | `internal.ts` | Cross-package infrastructure (`createEpoch`, `createOwnedMap`, `createCoalescingRunner`, `parseWsUpgradeParams`, `formatSchemaIssues`, `sleep`) plus every framework BUDGET and DOCUMENTED DEFAULT (the client-audio constants, `AGENT_CSP`, `WS_OPEN`, and the 21 `DEFAULT_*`/`MAX_*` names that were on the root), the workflow API's server half, the two platform contracts BOTH ends must derive identically (the slug shape — `VALID_SLUG_RE`, `RESERVED_SLUGS`, `MAX_SLUG_LENGTH`, `PREVIEW_SLUG_SUFFIX` — and the `aai login` confirmation code), and the framework's own wire helpers (`capToolResult`, `toArgsRecord`, `isTextAssetPath`, `normalizeSpeechText`; `sdk/_wire-helpers.ts`). Not public API, not semver-covered, excluded from the docs. **It is ZOD-FREE, and that is a rule** — it used to reach `formatSchemaIssues` through `sdk/schema.ts`, which imports zod, so importing anything here pulled zod's graph onto the CLI's path; the function lives in the zod-free `sdk/standard-schema.ts`. The env brands live on `./runtime` instead — they appear in its public signatures (`RuntimeOptions`, `withHostCredentialFallback`) |

**Four subpaths are NODE-ONLY — `/ffmpeg`, `/step-files`, `/html` and
`/coding-tools`** — because each pulls something `sdk/` may not (`node:`
builtins for the first two and the last, two parsers for the third), which is
why they live in `host/` and are reached by subpaths of their own rather than
joining `@alexkroman1/aai/step`. They are nonetheless CONTRACTED rather than
deny-listed — `NON_AUTHORING_SUBPATHS` is for surfaces whose reader is the
framework, and a step, or an agent that edits code, is an author writing code.

**They used to be BODY-USE ONLY, and that rule is retired** with the Workflow
DevKit builder that compiled a `workflows/*.ts` module's remainder as a
`node:vm` Script. The replay engine compiles no separate workflow bundle, so a
`workflows/*.ts` module may name either subpath at module scope.
`packages/aai-templates/CLAUDE.md` carries the two templates that paid for
getting the old rule wrong.

**Not on those four subpaths**, each barrel's doc saying why: the eighteen
`*_KIND`/`*_API_KEY_ENV` pairs (`/host-internal`, beside the `resolve*Settings`
helpers reading them), the eighteen narrowed `*Provider` aliases (gone), and
`ProviderDescriptor` (the root alone).

## Four groups of `AgentDef` fields, four modules, one rule each

`sdk/types.ts` sits at the source-length cap, so a group of fields that shares
ONE rule is declared on its own interface and `AgentDef` extends it. That is not
tidying: each rule is DERIVED from the declaration, so a field added to the
group cannot skip the gate.

| Interface | Module | The rule |
| --- | --- | --- |
| `PipelineVoiceTuning` | `agent-voice-tuning.ts` | pipeline transport or nothing |
| `AgentModelTuning` | `agent-model-tuning.ts` | THIS runtime assembles the request, so **s2s refuses all five** |
| `AgentGuardrails` | `agent-guardrails.ts` | the only declarations that may STOP a turn |
| `AgentObservation` | `agent-observation.ts` | the two that deliberately may not |

`assertSamplingScope` reads `MODEL_TUNING_FIELDS`, whose `satisfies` makes it
total over `AgentModelTuning`, so a sixth knob that skips the table fails to
compile. `resetToolChoice` defaults **true** (OpenAI's `reset_tool_choice`) and
is inert unless `toolChoice` demands a call.

**A guardrail is pipeline-only, and the two refusals are different claims** —
s2s has already spoken the sentence, text mode hands its caller the model stream
and owns no funnel. `assertGuardrailScope` refuses both by name;
`agent-guardrails.ts` carries what the pipeline one does and does not prevent.

**`systemPrompt` takes a RESOLVER**, `(ctx: AgentSessionContext) => string`,
called per model request and landing under the same precedence header a string
does — `agent-instructions.ts` owns the rest.

## Session modes

Each agent runs in one of three session modes, selected by `toAgentConfig()`
(run in the generated bundle entry) based on which top-level fields are
present in the `agent()` config:

- **Text mode** (explicit opt-in — `text: true`) has no audio path at all: an
  LLM, a system prompt and the agent's tools, run over a message list by
  `createTextAgent` rather than by a transport over a socket. Explicit for the
  same reason `s2s` is, and the two modes refuse each other by name. **See
  `host/text-agent.ts`'s module doc**; this guide is at its cap and the rest
  of the rule lives there.
- **Pipeline mode** (the DEFAULT — all three of `stt`, `llm`, and `tts`
  set, or none of the four provider fields set, in which case the
  all-AssemblyAI pipeline (`assemblyAIPipeline()`) is injected by
  `defaultProviders` in `sdk/providers/_default-providers.ts`) uses
  `createPipelineTransport()` in
  `packages/aai/src/host/transports/pipeline-transport.ts`. Here the host
  drives the LLM loop itself via the Vercel AI SDK's `streamText`, and STT
  and TTS are pluggable providers imported from the `@alexkroman1/aai/stt`
  and `@alexkroman1/aai/tts` subpath exports.

  **A failing TURN is not a failing SESSION.** `onError` defaults to
  `fatal: true`, and aai-ui answers a fatal frame by releasing the microphone
  and ending the call — so only the two paths that really terminate may report
  that way, and every turn-level reporter passes `{ fatal: false }`.
  **`transports/pipeline-error.ts`'s module doc owns the rule**, both
  terminating paths, all three turn-level reporters, why reporting the LLM ones
  as fatal was especially perverse, and which of them the pipeline fuzz covers
  against the one that needs a deterministic spec.

- **S2S mode** (explicit opt-in — `s2s: assemblyAIS2s()` from the main
  export, or `openAIS2s()` from `@alexkroman1/aai/s2s`) uses
  `createS2sTransport()` in `host/transports/s2s-transport.ts`. The host opens a
  single WebSocket to the provider; STT, the LLM loop, and TTS all run
  service-side and audio/events relay through that one socket. There is no way
  to reach S2S by omission — only the `s2s` descriptor selects it.

  **[`S2S-CLAUDE.md`](S2S-CLAUDE.md) owns the rest**, and it is all
  wire-level: the ONE sample rate the Voice Agent API accepts (24 kHz both
  ways, why relabelled 16 kHz audio has no symptom, and where the pin lives),
  why a tool-call turn has no agent captions and what `transcript.agent.delta`
  does about it, the Voice Focus / `sttPrompt` / descriptor-option forwarding
  and the config-drop bug family behind it, why an in-band service error is NOT
  the end of a session, why retiring one must also DROP THE LINK, and why
  `stop()` has to be able to abandon an incomplete handshake. Read it before
  changing anything in either S2S transport.

The default injection runs at every mode-derivation site — `toAgentConfig`
(so it is baked into deployed configs at build time) and `createRuntime`'s
provider resolution — before `assertProviderTriple`.
Partial provider configs are FILLED, not rejected: `defaultProviders`
supplies the AssemblyAI default for each unset stage of `stt`/`llm`/`tts`
(when `s2s` is unset), so `agent({ llm: anthropicLlm(...) })` means "the
default pipeline with that LLM". The compile-time union (`AgentParams` in
`sdk/define.ts`) matches: any subset of the triple is legal, while `s2s`
combined with a pipeline provider or a pipeline-only tuning field still
fails `tsc` with a message naming the rule (`PipelineOnlyMisuse`) instead
of silently no-opping. `assertProviderTriple`'s partial-triple error now
only guards raw wire shapes that skipped the fill.

- **A misuse arm is defeated by a shape-competing SIBLING arm.** The pattern —
  a union arm typed as a string literal nothing satisfies, so `tsc` prints the
  RULE — only works when no other arm of that union scores as a closer match
  for the offending literal. `StubGenerateRoutes.text`
  (`sdk/testing-generate.ts`) is the case where it does not: the sibling
  `StubGenerateReply` is `string | { text?: string; object: unknown }`, and
  that OPTIONAL `text` makes it the closer match for `{ text: "…" }`, so
  TypeScript elaborates against it and prints "Property 'object' is missing"
  — the wrong remedy, since the author wanted a bare string. The literal never
  reaches the output. Measured against the real declarations, and three
  repairs do not help (an extra `{ text: Misuse; object?: never }` arm,
  splitting the object arm, both): TS picks any arm requiring `object`. The
  only shape that surfaces the literal drops the legal `{ text, object }`
  reply, which is breaking. So before reaching for a misuse arm, check what
  else in the union can absorb the same literal — and where one is already
  load-bearing in the docs, verify the message with a real `tsc` run rather
  than assuming the arm speaks. `PipelineOnlyMisuse` and `AgentParams`' arms
  do print, because nothing competes with them.

- **Tool-call args must be coerced before they hit a wire schema.** The AI
  SDK surfaces an unparsable/unknown tool call as a `tool-call` stream part
  whose `input` is the *raw argument string*, not a parsed object. The
  WebSocket `tool_call` event requires a record for `args`, so every emitter
  routes args through `toArgsRecord` (`sdk/utils.ts`; non-records become
  `{}`), and a failed/invalid call is recorded with an error `result` rather
  than left dangling.

- **Pre-connection client config**: the default client page is byte-identical
  for every agent and the CSP bars inline scripts, so the agent's display name
  and greeting reach the browser via a pre-connection endpoint —
  `GET /client-config` (dev server) / `GET /:slug/client-config` (platform,
  unauthenticated, for parity with the page and the WebSocket) returning
  `{ name, greeting }` (`sdk/client-config.ts`, re-exported from `/protocol`).
  **Every server builds the body through one helper**, `buildClientConfig`; on
  the platform (`aai-server/client-config-handler.ts`) name and greeting are
  PROXIED from the GUEST'S own `/client-config` — the bundle's live agent
  definition — never read from the stored config, which is fully opaque to the
  host. A guest that can't answer degrades to `{ sessionUrl }` only, and the
  `aai dev` Vite proxy forwards `/client-config` to the backend.
- **What the BROWSER client does with all of that** — the `DefaultRoot`
  config tier, the `serverIsBroker` latch that must only be set by an
  ANSWERED lookup, and why `ApiUrlChip` shows the long-living platform
  endpoint rather than the sandbox tunnel — is in
  `packages/aai-ui/CLAUDE.md`, "Consuming the client config".

Reference providers shipped today:

- **STT**: one of
  - `assemblyAIStt({ model: "universal-3-5-pro" })` — `ASSEMBLYAI_API_KEY`
  - `deepgramStt({ model: "nova-3" })` — `DEEPGRAM_API_KEY`
  - `elevenLabsStt({ model: "scribe_v2_realtime" })` — `ELEVENLABS_API_KEY`;
    stage-suffixed like `assemblyAIStt`, so the bare name is free for the TTS
    stage ElevenLabs is better known for
  - `sonioxStt({ model: "stt-rt-v3" })` — `SONIOX_API_KEY`

  **Never inherit the `assemblyai` SDK's connect deadline.** Its default
  `connectTimeout` is 1000 ms and covers far more than a socket open, so a
  healthy link still blows it and the session dies on a fatal
  `stt_connect_failed` that reads as a provider outage.
  `host/providers/stt/assemblyai.ts` therefore always sets
  `connectTimeout`/`maxConnectionRetries`/`connectionRetryDelay` from
  `STT_CONNECT_*`, overridable per agent via
  `assemblyAIStt({ connectTimeoutMs, maxConnectRetries })`. **Those three
  constants' shared doc in `sdk/pipeline-tuning-constants.ts` carries the
  argument**, including the 8500 ms < 10000 ms arithmetic against
  `DEFAULT_SESSION_START_TIMEOUT_MS` that `assemblyai.test.ts` asserts —
  re-check that sum before raising any of them.

  Two descriptor options carry their own rules (`AssemblyAISttOptions` in
  `sdk/providers/stt/assemblyai.ts`): **`streamingUrl`**, which overrides the
  endpoint and WINS over `region`, and **`languages`, whose unset value is
  "detect per turn", NOT "English"** — read that one before changing it.
- **LLM**: one of the typed factories below — each returns a pure
  descriptor; the `@ai-sdk/*` package is only imported by the host-side
  resolver (`host/providers/resolve.ts`), never by the agent bundle:
  - `anthropicLlm({ model })` — `ANTHROPIC_API_KEY`
  - `openAILlm({ model })` — `OPENAI_API_KEY`
  - `googleLlm({ model })` — `GOOGLE_GENERATIVE_AI_API_KEY`
  - `mistralLlm({ model })` — `MISTRAL_API_KEY`
  - `xAILlm({ model })` — `XAI_API_KEY`
  - `groqLlm({ model })` — `GROQ_API_KEY`
  - `openRouterLlm({ model })` — `OPENROUTER_API_KEY`; and
  - `gatewayLlm({ model })` — `AI_GATEWAY_API_KEY`. Both are AGGREGATORS
    addressed as `"creator/model"`, and neither needs an extra `@ai-sdk/*`
    dependency (`@ai-sdk/openai`'s `.chat()` client repointed, and
    `createGateway` from `ai`). Each module's doc carries the rest.
  - `assemblyAILlm({ model, region? })` — `ASSEMBLYAI_API_KEY`; routes through
    the [AssemblyAI LLM Gateway](https://www.assemblyai.com/docs/llm-gateway)
    (OpenAI-compatible chat-completions endpoint fronting 25+ models) via
    `@ai-sdk/openai`'s `.chat()` client. `region: "eu"` selects the EU
    endpoint. The client is built with a `fetch` wrapper,
    `repairOpenAiStream` — the gateway documents streamed responses for OpenAI
    models only, and its Claude streams break two AI SDK expectations, each
    fatal to a turn. **Both defects, and why bytes are the only place they can
    be caught (so this is a `fetch` wrapper rather than middleware), are in
    `host/providers/_openai-stream-repair.ts`'s module doc.** A THIRD defect is
    a REQUEST one (Gemini 500s on the `$schema`/`propertyNames` zod conversion
    emits) and is `transformParams` middleware instead —
    `_gateway-tool-schema.ts` carries why. Remove each once the gateway
    conforms.

    **The default model is `qwen3-next-80b-a3b`, and check the constant before
    trusting this line** — it has named the wrong model before, when an id was
    reverted in code and not here. `ASSEMBLYAI_LLM_DEFAULT_MODEL` in
    `sdk/providers/llm/assemblyai.ts` is the answer; a prose default is only a
    claim about it. Changing the id moves WHERE reasoning gets turned off,
    because `TOOLS_REQUIRE_NO_REASONING` in that same module is keyed by model
    id: **on the `gpt-5.6` family `reasoning_effort: "none"` is REQUIRED for
    tool use, not a tuning knob**, and the factory fills it in for those ids
    only. **That constant's doc carries the gateway's own rejection message,
    the 4/4 measurement behind it, why the streaming path sees a bare 500
    instead, and why an explicit `reasoningEffort` is left alone.** Read it
    before changing the default. One thing it does not say: the generated
    catalog (`gateway-models.ts`) cannot carry the flag — its flags come from
    `supported_parameters`, which does not list `reasoning_effort` for ANY
    model, including ones that plainly honour it (a bogus value 400s naming the
    supported ones). `gpt-5.5` and `qwen3-next-80b-a3b` are both unaffected,
    measured 2026-08-06: `"none"`, `"low"`, and no `reasoning_effort` at all
    each return a normal tool-calling completion, streaming included.

    **`assemblyAIPipeline()`'s explicit `reasoningEffort: "none"` is, on the
    current default, the ONLY thing turning reasoning off.** Because
    `qwen3-next-80b-a3b` is OUTSIDE `TOOLS_REQUIRE_NO_REASONING`, the factory
    fills in nothing and the whole weight sits on the preset's argument
    (`sdk/providers/assemblyai-pipeline.ts`); under `gpt-5.6-luna` or
    `gpt-5.6-terra` the factory fills the same value and the argument merely
    agrees with it. That agreement is a property of the id, not of
    the pipeline, which is why the argument stays under either: deleting it as
    redundant costs every
    default pipeline **1786ms p50 time-to-first-token against 999ms with
    reasoning off**, with seconds of pre-first-token silence rather than a
    failure as the symptom. So the two settings are pinned TOGETHER in
    `define.test.ts` (effort and model id in one test): the preset's `"none"`
    is what makes the next id change safe, and the pin is what makes an id
    change that needs a second look fail loudly.

    **The measured case is for `gpt-5.6-luna`, and it does not transfer to
    either the current default or terra.** What is known about
    `qwen3-next-80b-a3b` directly: the gateway advertises it with tools,
    streaming, 200k context and a live probe (`gateway-models.ts`), it accepts
    `reasoning_effort` as a hybrid-thinking model (`"none"` and `"low"` both
    verified 2026-08-06), and it has **no paired latency numbers and no price
    comparison here at all** — the same gap terra had. Luna's numbers, kept
    because they bound the gpt-5.6 family: $1/$6 per M against `gpt-5.5`'s
    $5/$30, and time-to-first-token (2026-08-06, 18 paired tool-calling turns,
    `reasoning_effort: "none"` on both) p50 **832ms vs 999ms** — ~17%, against
    `claude-opus-4-8`'s 1217ms and `claude-sonnet-5`'s 1568ms. The 5x-looking
    gaps in the first measurements were an ARTIFACT of comparing
    luna-with-`none` against `gpt-5.5` on its reasoning DEFAULT (1786ms): most
    of what looked like a model difference was the reasoning setting, which
    this pipeline turns off regardless of model.

    **No default here has been chosen on answer quality**, which is the axis
    that should decide one — a tau2 run is what would settle it. The current
    default has neither paired latency numbers nor a quality run, and neither
    did terra. Treat it as unverified on both axes.
- **TTS**: one of
  - `cartesiaTts({ voice })` — `CARTESIA_API_KEY`
  - `rimeTts({ voice })` — `RIME_API_KEY`
  - `assemblyAITts({ voice, language? })` — `ASSEMBLYAI_API_KEY`; AssemblyAI's
    streaming TTS over `wss://streaming-tts.assemblyai.com/v1/ws/`. Sharing one
    key with STT and the gateway means an all-AssemblyAI pipeline needs exactly
    one secret. **`host/providers/tts/assemblyai.ts`'s module doc owns the
    protocol** — the raw-key (not `Bearer`) auth and why a rejected key surfaces
    as `tts_stream_error`, why the adapter must not block waiting for `Begin`,
    the frame vocabulary, and the measurement behind the one thing that decides
    whether the agent feels responsive: **`Generate` only buffers — `Flush` is
    what starts synthesis.** Relaying LLM deltas and flushing once makes
    time-to-first-audio the length of the whole turn, since the pipeline's only
    provider-level flush is the end-of-turn drain (`flushTtsAndWait`, once per
    reply); a tool-chaining reply was silent for its entire duration, the
    dead-air cover included, as filler is just more buffered text. The adapter
    therefore buffers host-side and emits `Generate`+`Flush` **per segment** — a
    sentence end, or **40 characters** when no sentence end is in sight
    (`splitSegment` in `host/providers/tts/assemblyai-segment.ts`).

    **Segment LENGTH is the knob, not flush count, and it has a cliff on both
    sides** — "stream continuously" is not available on this protocol at any
    useful quality. **`host/providers/tts/assemblyai-segment.ts`'s module doc
    owns the whole curve**: the three measured segmentations, the per-3-word
    collapse, the `WordBoundaries` frames that name the ~800ms padding slot
    behind it, why the budget is a floor-BREAKER rather than a cap, and why the
    two-word floor exists. Read it before touching either constant.

    Two invariants come with segmenting — only the
    turn's **last** acknowledgement may emit `done` (`flushTtsAndWait` resolves
    on it, so a segment's `FlushDone` leaking through advances the orchestrator
    mid-reply), and the end-of-turn flush is never sent empty, so `done` never
    depends on the service acking a contentless `Flush`. A third is local to
    segmentation: `sendText` must drain **every** segment a delta carries, since
    a budget split consumes only its own — emitting one and waiting for the next
    delta reintroduces the whole-turn lag whenever no next delta comes.

`host-internal.ts` publishes a provider's `KIND` tag and
`<PROVIDER>_API_KEY_ENV` constant, never a stage subpath. Adding a provider
means: descriptor factory in its `sdk/providers/{stt,tts,llm,s2s}/<name>.ts`
module, its two constants in `host-internal.ts`, an opener in
`aai-runtime`'s `providers/{stt,tts}/` (built on the shared session shell in
`providers/_utils.ts`), and one entry in the matching registry in
`providers/resolve.ts`.

**Reach for `createSttSessionShell` / `createTtsSessionShell`, not
`createSessionShell` directly.** The raw factory also takes `cleanCloseIsFatal`,
which is a per-STAGE invariant rather than a per-provider choice (see its doc:
fatal for a continuous INPUT stream, normal completion for an output one). Seven
openers restated the same three lines, which made a session-deafening default
one copy-paste away. Two more rules the openers must not re-derive:
**`shell.emit` / `shell.on` are the ONLY path to an opener's emitter**
(`host/providers/_utils.ts`) — the shell owns the closed latch and the try/catch,
because these fire from inside a raw socket handler where a throw from a
downstream listener escapes into Node's `EventEmitter` as an uncaughtException
and takes down a multi-tenant host; it was `safeEmit(...)` applied in two openers
of seven. And **`openGuardedWs` (`host/providers/_socket.ts`) is the only way to
open a raw provider WebSocket**, carrying the connect deadline
(`WS_OPEN_TIMEOUT_MS`, 8000, kept under `DEFAULT_SESSION_START_TIMEOUT_MS` so the
failure names the provider) and the pre-connect zero-listener `error` guard —
without it a black-holed connect leaves `providers.open()` pending forever on a
socket with no owner, and a later socket `error` with no listener bound crashes
the host. Both module docs carry the rest.

**All four stages are registries, S2S included.** For a long time only
STT/TTS/LLM were: S2S was three hand-written kind comparisons, and they
had drifted apart on the failure mode. `buildTransport` THREW on an
unrecognized kind, while `requiredProviderEnvVars` FELL THROUGH to
`ASSEMBLYAI_API_KEY` and `ALL_PROVIDER_ENV_VARS` listed the two vendor
keys by hand. A third S2S vendor would therefore have made both credential
preflights — the platform's deploy boundary (`aai-server/deploy.ts`) and
`aai dev`'s — reject the deploy while naming a key the agent does not use
and never naming the one it does, which is exactly the silently-wrong-vendor
failure the STT/TTS registries were built to prevent. `S2S_REGISTRY` closes
it: `S2sKind` is the closed union of its keys, `isS2sKind` narrows to it,
and the dispatch in `runtime-transport.ts` is an exhaustiveness switch over
that union — so a registry entry with no transport builder is a compile
error rather than a first-session throw. S2S credentials also honour a
descriptor's `apiKeyEnv` now, like every other stage; they resolve through
`resolveS2sEnvVar`, so the key a session reads is by construction the key
the preflight asked for.

## An upload's bytes are OBJECTS, and its record has two homes

The store, its two interfaces, and why the record and the bytes are paired off
the same `DATABASE_URL` are `aai-runtime`'s — see the section of this name in
`packages/aai-runtime/CLAUDE.md`. The SDK owns the CLIENT half below.

## An upload can be read while it is still arriving

`POST /workflows/uploads` answers with an id once the last byte is stored — the
store writes an upload's record LAST, so "incomplete" and "no such upload" are
one answer and a run needing that id waits for the whole file. `PUT
/workflows/uploads/:id` is the other shape: the CALLER names the upload, so the
id is valid before the bytes are sent, the record exists from the first byte
with `complete: false` and a growing `size`, and `stepReadUpload` — which already
clamped its window to what is stored — is what a run reads it with.

**`complete` is the only field a body may exit on.** A `size` that stopped
growing is what a slow link and a dead client both look like.

`host/workflow-uploads.ts` carries what that relaxation costs and how it is paid
for; `sdk/step-uploads.ts` owns the reader's half and the polling shape; the
author-facing half (`useWorkflowStream`) is in `packages/aai-ui/CLAUDE.md`.

## An upload can also arrive over SEVERAL connections

Both writes above carry the whole file in ONE request, so an upload runs at one
connection's throughput — a fraction of the link over any distance. `POST
/workflows/uploads/:id/parts?total=` declares an upload and `PUT
…/parts?offset=` fills in a window of it, so a browser sends eight at once. **It
is the DEFAULT** — `api.upload(file)` and every form hook take it unless a caller
passes `parallel: false`.

**Two rules make it invisible downstream**, which is why no reader, no step and
no range route changed: a part starts on an `UPLOAD_CHUNK_BYTES` boundary, so its
offset — which IS its object's name — is on a grid nothing can scatter; and
**`size` is the CONTIGUOUS prefix, never the sum of what has arrived** — parts
land out of order, so a size that counted bytes would tell a reader it may
read a hole. `complete` becomes true when that prefix reaches the DECLARED
total, which is the only observable moment every byte is present.

**On the platform the bytes do not come to the agent at all.** A deployed guest
holds no bucket credential, so each window goes to a route the PLATFORM serves
and a bodyless `PUT …/parts?offset=…&stored=1` tells the agent which landed —
whose size the store asks the BUCKET for rather than taking from the caller,
which is what stops a claimed part becoming a readable hole. The CLAIM decides
which path a client takes (`directParts`), because `aai dev`, a self-hosted
server and an agent deployed before this all answer the same way — see
`host/_upload-blobs.ts` and `aai-server/upload-handler.ts`.

That receipt is BATCHED, and only when the agent says so —
**`UPLOAD_CLAIM_BATCH` and `UploadCreated.claimBatch` own it.**

**And `info` publishes WHICH windows landed** (`UploadInfo.ranges`), for an
unfinished parts upload and nothing else — a whole-file write has no windows, and
a finished upload is covered end to end. `size` is still the only field a READER
may act on; `ranges` is for the UPLOADER, and it is what makes
`api.upload(file, { resume: true })` send the missing windows rather than the
file. An agent too old to report them answers like an empty upload, so a resume
against one re-sends everything rather than leaving a hole.

**The width is 8 and the part size 8 MiB, so 64 MiB is in flight**, because what
the platform's h2 hop meters is concurrent large BODIES.
**`UPLOAD_PART_CONCURRENCY`'s own doc owns the argument** — why not wider (one
reset aborts every sibling in flight, so width is a blast radius), where the
measured shoulder is, and the table it had to DELETE for reporting a cliff its own
harness had caused. Read it, and `scripts/upload-sweep.mjs`, before moving
either number: `pnpm bench:uploads --target <base>` is believable now and still
prints no browser number.

**And the whole upload RE-ENTERS itself when the agent goes away.** The
per-request budget (~4-11s) covers a failure that happens while the agent is UP;
it cannot cover a redeploy, an idle reclaim or a `aai dev` restart, where every
part in flight burns its budget inside the outage and a 90%-stored recording is
thrown away in full. So a round failing for a reason that LOOKS like an outage is
run again with `resume: true` — reading the ranges and sending only what is
missing, which is why a budget of about a minute is affordable.
**`sdk/_upload-resume.ts` owns it**, including the three failures it refuses to
re-enter (an abort — also how a person's PAUSE arrives — a refusal status, and a
record the agent acknowledged and never wrote).

The client path DECLINES rather than fails (an
uncuttable string body, a one-part file — for `upload` only, since `uploadStream`
buys RESUMABILITY here rather than speed and re-cuts such a file at the chunk
grid — an agent answering 404 to
the declaration), which is what makes it safe as a default rather than an opt-in
— and it is also the only upload path that can RETRY, since a single-request
`POST` retried after a lost response mints a SECOND upload and a `PUT` retried
against its own id is refused as taken. `sdk/workflow-upload-parts.ts` and
`host/_upload-store.ts` carry the rest, including the backoff, the `Retry-After`
it honours, and the two bracketing requests that are retried with it.

## Workflow apps and the workflow HTTP API

`AgentDef.page` declares an agent's front door: `"voice"` (the default, and what
absent means) or `"static"` — a page over the workflow HTTP API that
`createRuntimeServer` mounts, declared with `workflowApp()` (`sdk/define.ts`,
the fourth arm of `AgentParams`), which refuses the fields such an app cannot
use. **This guide is AT its cap: the author-facing half is "Workflow apps" in
`packages/aai-ui/CLAUDE.md`.** Three authoring types on `/workflow-api` are
worth stating here, because each replaced a hazard templates were re-deriving.

**Read a run's newest progress line with `ctx.workflows.lastLine(runId)`, never
`streamTail` + `stream` composed by hand.** A progress channel is never CLOSED —
no step knows it is the last one — so `stream` on a run that has written nothing
yields nothing and **waits forever**: the tool call stops mid-turn on a voice
agent, with no error, no timeout of its own and nothing in a log. The bound that
prevents it is `streamTail() < 0`, and it has to come FIRST. Two templates
carried the same six-line comment saying exactly that above the same eight
lines; a hazard needing an identical comment at every call site is a missing
front door. `lastLine` asks for the tail before it opens anything, reads one
chunk and cancels, and resolves `undefined` for an empty channel. `streamTail`
and `stream` stay public — rendering a WHOLE log is what they are right for.
A spec stubs `lastLine` DIRECTLY: `createStubWorkflows` is a flat override map
over `rejectingWorkflows`, so stubbing the two halves does not reach it.

**A workflow body takes `WorkflowInputOf<typeof theDef>`, and `WorkflowRunOf`
is what a `*_status` tool holds.** `WorkflowBody` takes its input as a
PARAMETER, so it is contravariant: a body declaring a wider shape than the
schema produces is assignable and nothing warns — which is how `podcast-digest-workflow`
came to re-implement six schema `.default()`s with `??`, one of them already
disagreeing. `WorkflowRunOf<typeof def>` is
`WorkflowRunSnapshot<WorkflowOutputOf<typeof def>>`, still the discriminated
union, and kills a three-name import two templates composed by hand.
**The obvious spelling of the first one does NOT compile** — `workflow<P, R>()`
infers `R` from `run`, so `typeof theDef` needs the body's signature, which needs
`typeof theDef`: `TS7022`, reported against `agent.ts`. Two template groups hit
it independently, and neither the type tests (every def there uses an inline
arrow) nor `sdk/workflow.ts`'s `@example` (marked `no-check`) catches it. The
convention that works — name the schema const and ANNOTATE the def — is in
`packages/aai-templates/CLAUDE.md`. **A declared `output` schema is what makes
that annotation cheap**: `WorkflowOutputOf` reads the SCHEMA, not the body, so
the type is stated once and the value is checked where the run completes.
`sdk/workflow.ts` owns it.

## A callback URL comes from `publicWebhookUrl`

`ctx.workflows.publicWebhookUrl(token)` is what a tool hands a payment provider,
and the token is the one a body passed `ctx.waitFor`. It is the only URL that
survives the sandbox that minted it — the DevKit's guest-local `hook.url`, which
named the inside of a sandbox that had exited by the time anyone called back, is
gone with `createHook`. **A BODY and its steps reach the same URL as
`stepWebhookUrl(token)`** (`sdk/step-webhook.ts`, on `/step`), which is what a
`workflowApp()` with no tools has: a `Symbol.for` slot a host fills with a
minter that already knows the route. Its own doc carries the one-claim-per-run
rule and what `aai dev` can and cannot do. The three load-bearing properties are
in `packages/aai-runtime/CLAUDE.md` — the package where `workflow/client.ts`
lives.

## A run can tell the caller it finished

`start(def, input, { key, notify })` makes the session that started a run take
an UNPROMPTED, interruptible turn when it lands. `Transport.injectTurn` is the
primitive (pipeline only) — see `packages/aai-runtime/CLAUDE.md`.

## Voices

**`ASSEMBLYAI_TTS_VOICES` in `sdk/providers/tts/assemblyai.ts` is the list.**
Read it there; do not restate it, and do not trust a voice name absent from it.

That instruction is the whole point of the constant: two hand-maintained tables
here and in the provider's doc were both fiction, and the failure is invisible
at authoring time — a wrong id is rejected in-band after the TTS socket opens,
so the agent connects, reports ready and is permanently silent. A form that
offers the caller a voice reads `ttsVoiceIds(language?)` (`/tts`), the catalog
as the non-empty tuple `z.enum` takes.

**`AssemblyAITtsVoice` is AUTOCOMPLETE over that constant, not a guard**, and
no assert pairs with it — `assertAssemblyAITtsLanguage`, which also refuses a
listed voice against a `language` it cannot speak, says why that does not
generalize to the id itself. It and `ASSEMBLYAI_TTS_VOICES` are on the ROOT as
well as `/tts`, both having been FORGOTTEN exports there while
`agent({ voice })` is typed against them.

On the default pipeline the voice is the top-level `voice` field —
`agent({ voice: "michael" })`, desugared to `tts: assemblyAITts({ voice })` in
`normalizeAgentConveniences` and invalid alongside an explicit `tts`
descriptor, which owns its own voice. An explicit stage picks it with
`assemblyAITts({ voice })` or `assemblyAIPipeline({ voice })`. S2S mode's voice
rides on the `s2s` descriptor — `voice` is a compile error there.

## `ctx.generate` (one-shot LLM generation)

Tool `execute` code gets one-shot LLM generation via `ctx.generate` — a
**runtime capability like `ctx.generate`**. One implementation,
`createGenerateFn` (`host/generate.ts`, exported from `/runtime`), runs
wherever the runtime runs — inside the guest sandbox on the platform,
in-process under `aai dev`: descriptors resolve through the same
`resolveLlm` registry as the pipeline model, credentials from the agent env
only. Defaults to the agent's own pipeline `llm`; a per-call `llm`
descriptor (or model-id string — same shorthand as `agent({ llm })`) works
for S2S agents holding that provider's key.

`GenerateOptions.schema` accepts a Zod schema directly (or any Standard
Schema convertible to JSON Schema — `sdk/schema.ts` owns detection and
conversion), converted before the provider call; a plain JSON Schema object
also works. `GenerateFn` is generic, so a Standard Schema call returns a
typed `object`. Note zod 4.4 stamps `~standard` onto its plain
`toJSONSchema()` OUTPUT too — schema detection keys off the `_zod` instance
marker, never the `~standard` interface (`isConvertibleSchema`).

## `ctx.messages` has a THIRD arm, and it used to be dead

`Message.role` has always been `"user" | "assistant" | "tool"`, and nothing in
the repo ever produced a `"tool"`: the pipeline's tool-facing view held
transcripts only, the text agent's projection kept `text` parts (a
`ToolModelMessage` carries `tool-result` parts and never one), and the resume
walk answered `user`/`assistant`. So a tool could see every word of the call and
not one thing any tool had returned — including the tool that ran two steps
earlier in the same reply. Every peer SDK exposes this.

It is real now, in all three modes and on resume. A settled call contributes
`{ role: "tool", content, toolName?, toolCallId? }` — `content` is the result
the tool returned, capped exactly as the client's `tool.completed` frame caps it
so live and resumed histories are the same history. Read the arm by ROLE: the
two id fields are optional, and a result whose `tool.called` fell off the front
of the log has no name to give.

**It does not reach the MODEL, and that is deliberate.** In an LLM message list
a `tool` message is one half of a pair the assistant's `tool-call` message
completes, and both providers reject an orphan; the model already has the whole
pair from the step that produced it. `ctx.messages` is a tool's view, not the
model's.

`aai-runtime`'s `_tool-result-message.ts` is the one statement of the shape, and
the four producers that share it (`to-vercel-tools.ts`, `text-agent.ts`,
`session-tool-steps.ts`, `session-event-history.ts`) each carry why they are
where they are. Filters by role (`m.role === "user"`) are unaffected, which is
what made this additive.

## `ToolDef.messages` — what a tool SAYS, and the arm that skips the model

`sdk/tool-messages.ts` declares it and `sdk/tool-messages-select.ts` chooses;
both are pure, and the runtime that speaks them is `aai-runtime`'s
`tool-messages-runner.ts`. A port of Vapi's tool `messages`, with two names
moved to this repo's conventions (`timingMilliseconds` → `afterMs`,
`conditions` → `when`). Four kinds — `start`, `delayed`, `complete`, `failed` —
and three rules worth knowing before reading the module:

- **Same timing means VARIANTS; different timings mean STAGES.** Two `delayed`
  entries at `afterMs: 3000` are two phrasings of one rung and one is drawn;
  3000 and 8000 are a ladder. Grouping happens BEFORE the draw, or a
  three-variant rung would turn "both rungs" into a coin flip between them.
- **`role: "assistant"` on a `complete`/`failed` entry means the model is NOT
  CALLED.** The line is spoken verbatim and the step loop stops there, which
  removes an entire LLM round-trip from a deterministic outcome. `"system"` is
  the other arm: the content rides back with the tool's result as a hint and
  the model writes the sentence.
- **`start` and `delayed` are FILLER and never recorded** — not in
  `ctx.messages`, not in the model's view, not in a committed transcript, and
  they never count as the agent having spoken, so a caller talking over one
  does not interrupt the reply being generated behind it. The barge-in rule and
  the `blocking` bound are in `packages/aai-runtime/CLAUDE.md`, "A tool can
  SPEAK".

The field rides on `ToolSchema` (normalized by `agentToolsToSchemas`, absent
for a tool that declares nothing), which is what makes it mean the same thing
in `aai dev`, in a deployed guest and in host mode.

## `ctx.delegate` (subagents)

The sibling of `ctx.generate`, and the line between them is how many model
turns an answer takes: `generate` is one prompt, `delegate` runs a whole tool
loop — the Vercel AI SDK's `ToolLoopAgent` — with its own instructions, model,
tools and CONTEXT WINDOW, and hands back only what it concluded. `subagent()`
(`sdk/subagent.ts`) declares one; the host implementation, the reuse of
`executeToolCall` for a subagent's own tools, the one-level rule and the
isolated `ctx.messages` are in `packages/aai-runtime/CLAUDE.md`, "Subagents".

It also owns `expectedOutput`, `guardrail`/`maxRetries` and
`agent({ subagents })` — the ROSTER a MODEL routes over, where
`ctx.delegate(x, …)` is the author choosing in code.

## Concurrency primitives (use these, don't hand-roll)

`sdk/invariant.ts` (`/internal`) is the sibling seam for STATE rather than
timing — see "Runtime invariants" in `packages/aai-runtime/CLAUDE.md`.

The repo's recurring async-coordination patterns are reified as small
primitives, and almost all of them live in this package — reach for one before
re-inventing the pattern at a call site. Two that do not are stated in the root
`AGENTS.md`: `p-timeout` for timeouts (never a hand-rolled `Promise.race` with a
timer) and native `AbortSignal.any([...])` for combining signals.

**Each primitive's module doc carries the hazard it reifies and the shape it
replaced; what follows is the index plus the rule and the adopters.**

- **`createEpoch()`** (`sdk/epoch.ts`, `@alexkroman1/aai/internal`) — staleness
  guard for async continuations: capture `current()` when deferring work, check
  `isCurrent(gen)` when it settles, `bump()` to invalidate. Adopted by the
  aai-ui connection/turn generations and the pipeline turn gate. Don't hand-roll
  `let generation = 0; generation++` counters.
- **`createOwnedMap()`** (`sdk/owned-map.ts`, `/internal`) — a map whose entries
  are removed by ownership TOKEN, so an async teardown settling after the key
  was re-claimed (reconnect resume, redeploy) can't evict the successor's entry.
  `owns()` guards non-delete mutations. Adopted by the runtime's
  `sessions`/`sinkMap`, the WS handler, and the platform `SlotCache`. Don't
  write `if (map.get(k) === mine) map.delete(k)` by hand
  (`guard-invariants` rule 8).
- **`createCoalescingRunner()`** (`sdk/coalescing-runner.ts`, `/internal`) —
  serialize + coalesce repeatable async work: at most one run in flight,
  triggers during a run share ONE trailing re-run started after the current
  settles, rejections never wedge the runner. For work that reads latest state
  when it runs (workspace sync, post-write typechecks). Don't hand-roll
  `inFlight`/`trailing` flag pumps.
- **`createTurnMachine()`** (`host/transports/pipeline-turn-state.ts`) — the
  pipeline transport's turn lifecycle (in-flight reply, spoke flag, TTS audio
  gate) as a discriminated-union machine whose named transitions are the only
  mutation path. New turn-state reads/writes go through it, not new closure
  flags.
- **`createKeyedLock()`** (`sdk/keyed-lock.ts`, `/utils` and the root — the one
  primitive here that is PUBLIC) — serialize async work per key; `withLock(lock,
  key, fn)` releases in every outcome, and an optional `timeoutMs` bounds the
  ACQUIRE, which is what makes a contended mutation answerable instead of queued
  (`KeyedLockTimeoutError` → the platform's 409). It is public because the
  hazard is an agent author's as much as the platform's: **the LLM loop runs a
  step's tool calls CONCURRENTLY**, so two async mutators of one external
  resource interleave at every await. Don't write
  `tails.get(k) ?? Promise.resolve()` by hand (rule 9) — the two parts that get
  missed are dropping the drained entry BY OWNERSHIP, and resolving your own
  place in the chain when you abandon a timed-out acquire.

  **For a session-state mutation reach for `slot.update` instead** (below): its
  window is synchronous, so it has nothing to serialize. This stays the right
  answer for serialized work that is NOT a slot mutation — an external resource,
  a key that is not the session id, or `{ timeoutMs }` when a contended mutation
  must fail rather than queue. No template demonstrates it any more, recorded in
  `template-api-allowlist.json` rather than an oversight.
- **`mapConcurrent(items, width, run)`** (`sdk/map-concurrent.ts`, `/step` — the
  other PUBLIC one) — bounded fan-out inside a durable workflow body: a WINDOW
  over a cursor, so a slow item costs only itself. It was `mapInBatches`
  (sequential `Promise.all` batches) on the belief that a pool broke replay; it
  does not — the engine needs the SEQUENCE OF ITEMS issued to be a pure function
  of the list, which a monotonic cursor satisfies at any width — and the barrier
  cost 6.7x p50 on `transcription-workflow`'s fan-out. **The rule that IS
  load-bearing** — `run` issues one step call per item, synchronously — is
  unchanged by the shape; the module doc carries both halves.
- **`mapSettled(items, width, run)`** / **`partitionSettled(settled)`**
  (`sdk/map-settled.ts`, `/step`) — `mapConcurrent` with the per-item
  `try`/`catch` written once: one `Settled<T, R>` per item, in item order, so a
  TOOL on a live call keeps every sibling's result and NAMES the one that
  failed; `partitionSettled` answers two typed lists, so `failed[0]?.error`
  needs no re-narrowing (three templates had drifted on it). `Infinity` means
  every item at once (`mapConcurrent` alone floors it to 1). The issue order is
  `mapConcurrent`'s, so its replay rule holds.
- **`mapStream(source, width, run)`** (`sdk/_map-stream.ts`, internal) — the
  same bound over an ITERATOR rather than a list, for a body that does not exist
  yet and is expensive to pull: the next item is read only as a slot frees, so
  the window is the memory bound and the source's own backpressure is preserved.
  Results are yielded in SOURCE order, which the upload byte route cannot do
  without — it is writing them to a socket. Every task is wrapped so it SETTLES
  rather than rejects: a sibling's rejection sitting behind a slow head is an
  unhandled rejection and, by default, a dead process. The same wrapper is what
  lets a consumer leave early without stranding one. Adopted by the upload
  store's whole-file write and by `GET /workflows/uploads/:id`. Reach for
  `mapConcurrent` when the items are already in hand.
- **`sleep(ms, { signal?, unref? })`** (`sdk/sleep.ts`, `/internal`) — the ONE
  wait; `guard-invariants` rule 19 keeps the seventh spelling out. It replaced
  **six** spellings at 22 call sites, which split into two families differing in
  whether `vi.useFakeTimers()` can drive them. **Read the module doc** for that
  measurement, why `unref` is opt-in (it is a claim, and the shared default it
  replaced made a shutdown grace skip its own drains), and why an abort resolves
  with the listener detached. Not a timeout (`p-timeout`, rule 3), not a yield
  (`flush()`/`tick()`, rule 4).
- **`ToolFailure` / `isToolFailure()` / `toolFailure(message)`**
  (`sdk/utils.ts`, root and `/utils`) — the `{ error: string }` object a tool
  returns for a failure the MODEL should see and recover from, its guard, and
  its constructor. The guard is the point: failures propagate, so a helper
  returning `Order | ToolFailure` has a caller that forwards it unchanged, and
  `"error" in value` only works once the value is known to be an object. Five
  templates returned the shape; `retail-orders-agent` had its own
  `ErrorResult` + `isError` at ~40 sites. The constructor exists so that "how
  do I report a failure?" lands next to `isToolFailure` rather than on
  `serializeToolFailure()`, which returns the pre-serialized wire STRING the
  host emits for a tool that THREW — so `isToolFailure(serializeToolFailure(m))`
  is `false`. Under its old name (`toolError`) that was a trap; it is
  `@internal` on `/utils` now, and `utils.test.ts` pins both halves.
- **`pushCapped(list, item, max)`** (`sdk/utils.ts`, root and `/utils`) — append
  to a list holding a cap, mutating IN PLACE. **For a NESTED list only** now
  (`incident.timeline`, one per incident): a TOP-LEVEL array of a slot's value
  declares its bound on the slot —
  `sessionSlot(key, create, { caps: { log: 40 } })` — which holds whatever path
  wrote, where a wrapper caps only the paths that call it —
  `executive-inbox-agent` capped two arrays that way and pushed to three more
  directly. See the `caps` rule under "A slot OWNS its session state".
- **`omitUndefined()`** (`sdk/omit-undefined.ts`, `/utils`) — the one way to
  build the optional half of an object under `exactOptionalPropertyTypes`, which
  makes `{ name: maybeName }` an error whenever the value can be `undefined`.
  The only spelling that compiled was `...(name !== undefined ? { name } : {})`,
  hand-written 44 times and naming its key twice, so a mismatched pair
  (`x !== undefined ? { y: x }`) reads as noise rather than as the bug it is.
  Write `...omitUndefined({ name, greeting })`. `guard-invariants` rule 2 sees
  all three spellings, and its remedy names the three sites that deliberately
  keep the long form — where the GUARD IS NOT THE VALUE. Check that before
  converting a fourth. On `/utils` rather than `/internal` for the zero-zod
  reason `sdk/utils.ts`'s module doc states.
- **`sessionSlot()`** (`sdk/session-slot.ts`, the ROOT — it is authoring API,
  not infrastructure) — a typed named slot that OWNS a session's state: its key,
  its default, its reads, its writes, its `syncState` projection, and its
  STORAGE. There is no `ctx.state` bag any more. See "A slot OWNS its session
  state" below.
- **`resolveOne(candidates, spoken, opts)`** (`sdk/spoken.ts`, ROOT only) — pick
  the one thing a caller named, or fail LISTING the candidates. See "Resolving
  what a caller SAID" below for the order it applies its readings in and why
  ambiguity is an ANSWER rather than a guess.
- **`orFail(value)` / `failable(fn)`** (`sdk/tool-failure-flow.ts`, root and
  `/utils`) — the FORWARDING half of the `T | ToolFailure` union: `orFail`
  abandons the enclosing `failable` with the failure, so a chain of lookups
  needs no guard statement per step. Reach for it on a NAMED HELPER, not an
  inline `slot.update` mutator, and note that it throws.
- **`ctx.random`** (`ToolContext.random`, with `randomInt`/`pickOne`/`shuffled`/
  `createSeededRandom` in `sdk/random.ts` on the root) — a tool's randomness as
  an ARGUMENT rather than the global, so what a tool drew is something a spec
  can state. Not journaled (that is `WorkflowContext.random()`), not
  cryptographic.

  **[`AUTHORING-HELPERS-CLAUDE.md`](AUTHORING-HELPERS-CLAUDE.md) owns both**,
  including when `failable` pays and when it does not, the `slot.update` draft
  interaction, and why `createToolContext` seeds rather than uses `Math.random`.

## A session event hook WRITES state, and still cannot SPEAK

`agent({ events })` handlers were observe-only, and the omission that made them
so is unchanged in the half that matters: `SessionEventContext` still carries no
`send`, no `generate`, no `delegate` and no `messages`, so nothing on the event
stream can decide what the agent says. What it gained is `slots` — every
`sessionSlot` and `dialog` accessor now takes a `SlotHolder` (`{ slots,
sessionId }`, the two fields any of them ever read) rather than a full
`ToolContext`, which a `ToolContext` satisfies structurally, so no existing call
site moved.

**The line is "cannot change the TURN", not "cannot write".** Maintaining the
session's own state is a different act, and forbidding it made authors do
something strictly worse: `text-adventure-agent` shipped a `game_state_history`
TOOL whose `value` argument was the player's own utterance, plus a line of
system prompt telling the model to call it every turn. The framework already had
the transcript. That cost a model call per turn, desynced the counter whenever
the model forgot, and was still only advice. It is four lines of
`user-transcript.committed` now. `retail-orders-agent`'s is the other shape — a
`tool.called` hook recording the calls a dialog gate refuses, which its own tool
wrapper structurally cannot see, because a refusal short-circuits before the
body.

**Write SYNCHRONOUSLY.** A hook's write is COMMITTED after the handler returns,
so an `await` before `slot.update` still stores the value but is not durable
until a later commit. And it is not readable by the turn it happened in: the
model sees a slot through a tool result, and this runs beside that path rather
than in front of it. The commit itself, and the re-entry guard that stops a
handler for `state.updated` from emitting one forever, are wired in
`session-emitter.ts` — see "A hook's write needs a commit, and a guard" in
`packages/aai-runtime/CLAUDE.md`.

## A slot OWNS its session state — and stores it

There is no `ctx.state`. A session's state lives in `sessionSlot()`s
(`sdk/session-slot.ts`, root export), each of which owns its own key, its own
default, its reads, its writes, its projection to the client, and its STORAGE.
`AgentDef.state`, the state type parameter on `ToolContext`/`ToolDef`/`AgentDef`,
`InferAgentState`, `SlotState`/`SlotStateOf` and `getState` all went with the bag.

**The reason to remove it was that it could not be stored.** A slot's value used
to be a property of one mutable object in a `Map` in the runtime's heap, so it
died with the process: a crash, a redeploy, `handoverSlot`'s blue-green swap, or
the fleet-wide peer route a cold broker takes all handed a reconnecting caller an
agent that remembered the whole conversation (the client replays history) and had
forgotten its cart. Nothing on the client can replay state back.

Six rules follow, and each is enforced rather than documented. **`session-slot.ts`
carries each one on the member it governs** — read it before changing any of them:

- **`update` is SYNCHRONOUS and hands the body a mutable DRAFT.** Whatever the
  mutator leaves behind is stored when it returns, so a read-modify-write is
  atomic with no lock — which matters because the LLM loop runs a step's tool
  calls CONCURRENTLY. An await goes in FRONT of the mutation; `slot.updateTool`
  refuses a thenable body naming the rule, and a nested `update`/`set`/`reset` on
  the same slot throws rather than being overwritten by the outer draft (which is
  a write that succeeds and then vanishes — `pizza-ordering-agent` had one). A throwing
  mutator stores NOTHING and does not wedge the slot for the rest of the session.
- **`slot.get()` returns a frozen `DeepReadonly<T>` — the TYPE matches the
  freeze.** Mutating what it returns is a compile error at every depth
  (`cart.items.push(x)` as much as `cart.total = 0`) and a `TypeError` for a
  caller with no types, because a mutation applied there is applied to a value
  nothing is going to store. A shallow `Readonly<T>` over a deep freeze left the
  RUNTIME STRICTER THAN THE TYPE and shipped in two templates. It propagates into
  an agent's own helpers, which is the price — one that will not take
  `DeepReadonly<T>` is one that mutates.
- **`slot.set()` stores a COPY** (`privateCopy`, a `structuredClone` for a durable
  slot), so the freeze lands on the slot's own object and never on the caller's.
  Its own examples — a load, an import, a restore — are exactly the cases where
  the caller still holds a reference to what it passed, and freezing in place
  turned an unrelated later line (`imported.items.push(...)`) into a `TypeError`
  from a stack naming nothing about this slot. `update` was always safe; its draft
  is the same copy. A VIRTUAL slot is handed the live value and nothing
  freezes it.
- **A durable value is checked STRUCTURALLY, in both backends.** `Map` → `{}`,
  `Date` → string, `NaN` → null: the values that corrupt do not throw, so
  `JSON.stringify` is not the check. Running it in the memory backend too is the
  whole reason that backend is a valid test double for the Postgres one — and why
  `createToolContext` carries a real slot store rather than a stub.
- **`syncState` takes `slot.projection(view)`**, which is CALLABLE and carries the
  slot's key and default. That is what lets the runtime render a session that has
  run no tool, and so what let `AgentDef.state` be deleted rather than remembered
  — four of five slot-backed templates used to forget to declare it.
- **`caps` bounds a TOP-LEVEL array on every store, AFTER `after`.**
  `{ caps: { log: 40 } }` drops the oldest past the cap on every writer and the
  projection's empty frame; `SlotCaps<T>` admits only array-valued keys, and a
  bad cap is refused at DECLARATION (`_session-slot-caps.ts`). After the hook,
  so a hook that appends cannot overshoot and the stored value never exceeds
  the cap; the price is that the hook sees the untrimmed draft (a tail read is
  unaffected, a `length` is not). A nested list stays on `pushCapped`.

**Which backend an agent gets is a property of the DEPLOYMENT**, never of a slot:
Postgres when `DATABASE_URL` is present, memory otherwise, reported in the
"Session mode resolved" line so the tier is answerable from outside. A per-slot
`persist` flag is refused for the reason above. A value that genuinely cannot be
stored declares `{ durable: false }` — a VIRTUAL slot, neither checked, frozen nor
committed.

**`SessionStateBackend.countEvents` is `max(event_index) + 1`, not a
`count(*)`.** It is read on hydrate so a session resuming onto a REPLACEMENT
process continues its event log rather than restarting at 0 and overwriting its
own history — and this log need not be dense from zero: an event past
`MAX_SESSION_EVENTS` advances the position without being stored, and a partly
failed flush leaves a hole. Under a count either case hands a resumed session an
index it has already used, so its `tail` goes BACKWARDS and the re-used appends
are silently dropped by `on conflict do nothing`. **Both backends must answer
`max + 1`**, or the memory one stops being a valid double for the Postgres one.

**Read `host/session-state-store.ts`** for the commit point (the end of the tool
call, awaited, once per changed slot), the fail-open rule for shape drift on
redeploy, and the size cap; `host/runtime-session-state.ts` for where a session
hydrates and where it is reclaimed; `host/session-state-postgres.ts` for the table
and what a Postgres it is GIVEN guarantees. **Persistence is reliable across
crashes and best-effort across redeploys.**

**There is a THIRD backend, and on the platform it is the one that runs.**
`session-state-platform.ts` (in `aai-runtime`) puts slots and the event log on
the PLATFORM's database over HTTP — the app database this one was written for no
longer exists. All three must agree; that is what makes memory a valid double.

**The tables come WITH the database, and this backend creates none.**
`sessionStateDdl` is the shape, and whoever OWNS the database applies it — a
migration on the platform's own, or the operator of a self-hosted deployment.
The platform used to apply it while provisioning an app's database, the tables
being part of what "this app has a database" meant.

The backend used to `create table if not exists` on its own paths; `if not
exists` is a no-op once the table exists, so a newer SDK expecting an added
column was broken either way, and it cost a `42P07` NOTICE per guest boot. A
missing table surfaces as the honest error it is.

**`dialog()` is the other primitive built on a slot** — what an agent may do NEXT,
gated at EXECUTION. `sdk/dialog.ts`'s module doc owns it. Three things about its
authoring types are load-bearing enough to state here.

**A dialog is declarable as a plain state map, and the reason is a SILENT
failure.** `dialog(key, spec)` takes `{ initial, states }`, a state carrying
`instruction`, `on`, `final`, `initial`, nested `states`, and — once a dialog
had to describe a CALL — `timeout` plus five voice knobs. Not a subset chosen
for convenience: a dialog's snapshot is PERSISTED, so it must survive
`structuredClone`, which rules out guards, context, actions and invoked actors
by construction. `meta` is `Record<string, any>`, read back untyped, so
`instructions` (plural) compiled, deployed, and produced refusals with no
recovery text — the failure the `when` gate exists to prevent, arriving through
the field meant to explain it. A declared `instruction?: string` catches it.
The machine overload STAYS (`procedure()` needs full
XState); the spec compiles to an ordinary machine, so a `durable: true` dialog
resumes across an author's switch between the two forms. Two type-level traps,
both learned by getting them wrong, are argued in
`sdk/dialog-types.ts`, where they live.

**A dialog also moves on the CALL.** An `on` key starting with `@` is a SESSION
event (`"@session.timed-out": "abandoned"`), checked at declaration and kept out
of the union an author may `send`; `Dialog.receive` offers one. A state may also
carry `timeout: { afterMs, send }` and the knobs
`voice`/`bargeIn`/`keyterms`/`toolChoice`/`temperature`, both read
deepest-active-state-first like `instruction` and riding in `meta`, so the
stored snapshot is unchanged and a `durable` dialog predating them resumes.
**`after` is REFUSED in both forms**: the actor is stopped inside the window it
was started in, so a delay can never fire, and every guard here passed one — the
graph guard's own fixture included. `agent({ dialogs })` wires the three to a
session. **`packages/aai-runtime/DIALOG-CLAUDE.md` owns the rest**, including
what each knob can and cannot do.

**Three tool builders bind `R`; all three thread it out now.** `tool()` always
did. `dialog.tool`, `slot.tool` and `slot.updateTool` bound `R` and answered
`ToolDef<P>` — i.e. `unknown` — although the implementations already computed it,
so `InferToolOutput` was useless for exactly the tools a stateful agent writes
and four template specs paid for it with a hand-rolled unwrap and a couple of
dozen casts. They answer `ToolDef<P, Promise<DialogToolResult<R> | ToolFailure>>`
and `ToolDef<P, R>`. Narrowing a return type is covariant, so a gated or
slot-backed tool is still assignable to the registry's
`Readonly<Record<string, ToolDef<ToolInputSchema>>>`.

**`sendFrom` takes `Exclude<NoInfer<R>, ToolFailure>`, and `NoInfer` is the
load-bearing half** — `R` sat in two inference positions, so with a bare
`(result: R)` a `sendFrom` above `execute` silently inferred `unknown` and its
narrowing stopped meaning anything while still compiling. NEGATING a
`value is ToolFailure` predicate does not subtract from a generic, so the
narrowing runs through a module-local `isSuccess` whose POSITIVE branch hands
`sendFrom` its value, with no cast. **This fixed the SILENT half of the ordering
trap, not the trap**: `dialog.test-d.ts` pins both orderings only for a
non-context-sensitive `execute` (an annotated function reference), and every real
tool body is an inline arrow whose return is inferred in a later pass — so a
mis-ordered `sendFrom` now fails with `TS18046` instead of compiling. Declare it
after `execute`; see "A `sendFrom` goes BELOW `execute`" in
`packages/aai-templates/CLAUDE.md` for the two template cases and for why
`Exclude` does NOT do this job inside a per-agent wrapper.

The types for both primitives live one file over from their factories —
`sdk/dialog-types.ts` and `sdk/dialog-handle.ts` beside `sdk/dialog.ts`,
`sdk/session-slot-types.ts` beside `sdk/session-slot.ts`, each split by the
500-line cap along the seam a reader already uses (what a caller passes IN,
versus the handle it gets back). Both
factories re-export their types, so every name is still importable from
`@alexkroman1/aai` and still findable where the function is.

**And `procedure()` is its sibling, for the OTHER kind of machine.** A flow is
where a conversation IS: persisted in a slot, moved one event at a time by the
caller's turns. A graph is one unit of WORK inside a single tool call: never
stored, driving itself through invoked actors, so its context may hold a
`GenerateFn` no slot could. `run(input, { signal })` is the whole surface, and
it exists because `toPromise` on a STOPPED actor resolves `undefined` rather
than rejecting — so a hand-written lifecycle hands a half-finished graph back
typed as a finished one. `sdk/procedure.ts` owns the argument;
`technical-support-agent`'s CRAG loop is the worked example. Neither models a
per-ENTITY lifecycle (a status per row in a collection); that is a third shape
with no primitive.

**A slot is also the only thing carrying a state TYPE into a tool, because a tool
is a FILE.** `agent()` takes no `tools` argument — `tools/incident_create.ts` that
default-exports `tool({ … })` IS the tool `incident_create`, and the table is
filled by `withTools` over a registry the build enumerates. What that removed
along with the map is the map's one type-level service, checking each tool's
assignability against the agent's state shape; `slot.tool()` (reads) and
`slot.updateTool()` (writes) are what a stateful tool module reaches for instead.
And **`agent()` THROWS on a `tools` key** rather than only rejecting it in the
type: neither bundler type-checks user code, so the type alone would make "a tool
is only ever a file" true of this repo and of no user's project
(`assertNoInlineTools` in `sdk/define.ts`). `withTools` stays the seam a non-file
registry attaches through, which the studio's own coding agent needs — its tools
close over one session's workspace directory.

## The speech boundary, both directions (`sdk/spoken*.ts`)

A voice agent's boundary is speech going IN and going OUT, and the SDK owns a
helper for each direction. Inbound, `resolveOne` picks the one candidate an
utterance named or fails LISTING them — ambiguity is an ANSWER, never a guess —
over the `spokenDigits` / `spokenOrdinal` / `spokenAlphanumeric` readings.
Outbound, `spokenMoney` / `spokenDate` / `spokenTime` / `mintCode` turn data
into words a TTS voice reads correctly. Beside them sit the ARGUMENT shapes
those two meet at: `sdk/calendar.ts`'s `isIsoDate` / `isClockTime` /
`addDays` / `daysBetween`, and `sdk/tool-fields.ts`'s `isoDate(what)` /
`clockTime(what)` zod fields.

**[`AUTHORING-HELPERS-CLAUDE.md`](AUTHORING-HELPERS-CLAUDE.md) owns all of it**
— `resolveOne`'s reading order and why it is on the root rather than `/utils`,
the `spokenOrdinal` limitation that is pinned as a test, why nothing here
touches `Intl`, why `mintCode`'s alphabet is its whole design, and the ten
hand-written date rules the fields replaced. `retail-orders-agent`'s
`resolve.ts` is the worked example.

## Persistence, and the three things that were removed

**There is no `ctx.db`.** It was a SQL handle on `ToolContext` and on the
session-event hook context — first the platform's per-app Postgres, then a
`DATABASE_URL` an author set. The platform provisions no database and hands tool
code none, so a tool that persists brings its own client and credential. `Db`
survives as an `@internal` type: the shape this runtime's own Postgres consumers
take (upload records, the session-state backend, the workflow journal's
postgres arm), not an authoring type. `sdk/db.ts` carries that.

Removing it moved ten capability contracts — `aai:db` retired outright, and
`agent`/`tool`/`dialog`/`state`/`subagent`/`testing` plus five `aai-runtime`
ones bumped, because `ToolContext` appears in their reports. It also removed
`createUnusedDb`, the rejecting `Db` that `createToolContext` defaulted to.
(Those epoch numbers are gone — the numbering was reset to 1 — but the fan-out
is the durable lesson: a type on `ToolContext` is reachable from six contracts
at once.)

**What the platform DOES persist**, with no setup, is the part worth leading
with: `sessionSlot` for a session's own state (durable across a crash and a
redeploy, through the platform's session-state backend), and durable workflow
runs (surviving an idle sandbox, every redeploy, and a multi-day `ctx.sleep()`).
Those cover almost everything; a database is for data that must outlive a
session AND be queryable.

**No KV store and no vector store either** — `ctx.vector`, the `vector:` agent
field, the `@alexkroman1/aai/vector` subpath and the platform-owned
`PINECONE_API_KEY` were all removed. If retrieval returns it will be a client an
author brings, like SQL.

**One shipped template paid for this**: `tabletop-rpg-agent` lost `save_game`/`load_game`.
A template cannot reach a database — the scaffold ships no driver, and shipped
template code cannot import `@alexkroman1/aai-runtime` (templates type-check
under the scaffold tsconfig, which that package's source is not clean under). So
no template demonstrates cross-session persistence, which is a real gap in the
examples rather than a tidy outcome.

## Guest network access

There is **no per-agent egress policy**, and the network builtins screen a URL
only when there is no container around them (`builtinFetch` in `host/ssrf.ts`,
which lives here so the platform's guest-fetch proxy and the SDK's own builtins
resolve ONE copy). **The policy, the `AAI_SANDBOX_CONTAINED` declaration, the
screen's bypass classes and the two undici-version traps in the pinned
dispatcher are in `packages/aai-guest/CLAUDE.md`, "Guest network access"** — the
guest is what the rule is about, and this guide is at its cap.

## A request-path decode never throws

**`decodePathSegment` (`host/_path-decode.ts`) is the one spelling**, applied at
all five decode sites (`workflow/api.ts` x2, `server-static.ts`,
`workflow/serve.ts`, `session-events-api.ts`). `decodeURIComponent` THROWS a
`URIError` on a malformed escape and a request target is attacker-supplied:
`GET /.well-known/workflow/v1/webhook/%` is a legal HTTP request that nothing in
the stack rejects before a handler cuts the path apart. Those five sites sat in
three different accidental safety regimes — one caught explicitly, three inside
an `async` router whose rejection is answered 500, and **one fully synchronous**
(`webhookToken` → `pickWorkflowHandler` → `handleWorkflowRequest`, called from
`createRuntimeServer`'s `options.request?.(…)` hook with no `try`). That one
reached the guest's `uncaughtException` guard and `process.exit(4)`,
unauthenticated, taking every concurrent voice session on the sandbox down with
it.

So the decode is a FUNCTION with a stated contract rather than an expression
repeated with different luck: `undefined` means "this is not a decodable path
segment", and each caller answers it the way its own route answers a bad request
— a 400, a 404, or a decline. **There is no spelling of this that throws, and a
caller must never re-throw it**; the module doc carries the rest.

## A builtin's HTTP read is bounded at the READ, in BYTES

**`fetchCappedText` (`host/_fetch-capped.ts`) is the one bounded fetch** for
every builtin that reads a model-controlled URL — `visit_webpage`, `fetch_json`,
`get_page_design`'s page and stylesheet reads, and `web_search`'s two endpoints.
Two rules it exists to make unrepresentable:

- **The cap bounds the READ, not the value that is kept.** Every site used to do
  `const body = await resp.text()` and only then slice or refuse it, so the body
  was fully buffered into host memory first and the "cap" bounded nothing — the
  real limit was `FETCH_TIMEOUT_MS` times the link's bandwidth, on a URL a prompt
  injection picks. (`fetch_json` additionally pre-checked `content-length`, which
  reads `Number(null)` → `0` for any chunked response and therefore passed the
  guard exactly when the body was unbounded.) The body is read through
  `resp.body.getReader()` one chunk at a time, stopping the moment the budget is
  exceeded and cancelling the stream.
- **The budget is in BYTES, never `String.length`.** The old caps compared UTF-16
  code units against a byte budget, so a body of multi-byte characters passed at
  up to ~3x its nominal size.

`truncated` is the caller's decision: a page is worth reading in part, where a
JSON document clipped mid-value is not parseable and must be refused. An HTTP
failure is answered as `{ ok: false }` rather than thrown, because every caller
turns one into a tool result.

## The session takes two VOCABULARIES, not nineteen callbacks

`ServerSession` takes a `command(cmd)` and a `report(event)` — the whole
inbound surface, plus the two audio paths, where there used to be 157 `on*`
declarations. `guard-invariants` rule 16 keeps it that way. The three rules, and
what a callback has to be worth to survive, are in
`packages/aai-runtime/CLAUDE.md`.

## A `reset` starts a conversation, so it GREETS

A conversation that begins without the agent's declared opening line is not the
one the agent declares, so the pipeline transport's `reset()` ends by calling
`lifecycle.greet()`. Why `skipGreeting` deliberately does not reach it, and why
neither S2S transport re-greets (a known gap, not a decision), are in
`packages/aai-runtime/CLAUDE.md`.

## History records what was HEARD, not what was generated

An interrupted reply lands in history as the words the caller is estimated to
have actually heard, marked `[interrupted]`, and a reply cut before anything was
audible records nothing at all — because TTS runs behind the text, so the old
record told the model it had delivered information the caller never got. One
cursor, one owner, two tiers of accuracy, and why the proportional estimate has
to be CLAMPED: `packages/aai-runtime/CLAUDE.md`, the package holding
`transports/pipeline-heard.ts`.

## `speech_started` means "the agent is yielding", on BOTH transports

The two transports derive the edge differently — S2S from the service, pipeline
mode from the first non-empty STT partial — so while the agent holds the floor
pipeline mode HOLDS the event back rather than emitting what it happens to know.
It is a transport rule and the measurement behind it (53% of the events a
benchmark harness acted on were not interruptions) is in
`packages/aai-runtime/CLAUDE.md`.

## Data flow

On the platform, the browser's session WebSocket connects DIRECTLY to the
agent's sandbox (`/session` on its Modal tunnel, discovered via the
`GET /:slug/client-config` broker) — "server" below means the process running
the runtime: the guest harness on the platform, the `aai dev` server locally.
The audio path depends on the session mode:

- **S2S mode**: browser captures PCM → WebSocket → server relays it into a
  single AssemblyAI S2S socket → the agentic loop (LLM + tools) runs
  service-side → synthesized audio streams back through the same socket →
  server forwards it to the browser. An interrupt cancels the in-flight turn.
- **Pipeline mode**: browser captures PCM → WebSocket → server forwards it to
  the STT provider → partials stream to the client as `user-transcript.updated`
  (live captions) and drive the `speech.started`/`speech.stopped` edges → the
  committed turn is reported as `user-transcript.committed` → the host runs the
  LLM loop via `streamText` (tool calls execute host-side, as in S2S mode) →
  assistant text chunks stream into the TTS provider → audio returns over the
  client WebSocket. An interrupt cancels the in-flight LLM stream and TTS
  playback; a barge-in that never commits a user turn is a false interruption
  and the reply resumes (`resumeFalseInterruption`). `preemptiveGeneration` (OFF
  by default, measured) opens a branch one step earlier — see its row below.

## Default values and magic numbers

All numeric constants live in `packages/aai/src/sdk/constants.ts` (client-audio
budgets are split into `sdk/client-audio-constants.ts` for file-length reasons
and re-exported, so the import path is unchanged).

**The table of every default — the value, where it is applied, and the
measurement behind it — is [`DEFAULTS-CLAUDE.md`](DEFAULTS-CLAUDE.md).** Read it
there before changing any of them: several rows exist because the number was
already changed once on an intuition the measurement contradicts.

## Provider sockets disable permessage-deflate

**Every provider-facing `ws` client must spread `PROVIDER_WS_OPTIONS`**
(`host/_ws.ts`) — `defaultCreateHeaderWebSocket` (S2S + OpenAI Realtime),
`providers/tts/rime.ts`, `providers/tts/assemblyai.ts`,
`providers/stt/soniox.ts`. That module's doc carries the measurement and the
`ws` client/server default asymmetry behind the rule; this guide is at its cap.
`host/_ws.test.ts` pins the wire behaviour against a server that offers the
extension, and the three adapter suites assert the constructor option.

The vendor-SDK providers (`assemblyai` STT, `@deepgram/sdk`,
`@elevenlabs/elevenlabs-js`, `@cartesia/cartesia-js`) keep their WebSocket
private and expose no option to pass through, so they are NOT covered — their
compression behaviour is whatever the SDK and the provider negotiate. Worth
re-checking if one of them shows unexplained per-session memory.

## Self-hosted server defaults (`aai/host/server.ts`)

`createRuntimeServer` has no request authentication of its own — it is the
`aai dev` backend, not the managed platform — so two defaults are fail-closed:
it **binds loopback** (`127.0.0.1`; pass `"0.0.0.0"` deliberately, and `aai dev`
exposes `AAI_DEV_HOST` for setups where loopback isn't reachable), and **host
mode is opt-in** behind an explicit `AAI_ALLOW_HOST`. `createHostServer`
(`host/host-server.ts`) is the host-only server in one call; its module doc
carries the three ways the hand-rolled version was wrong.

**The rest — why a host client may bring its own provider credentials and what
makes that safe to expose self-serve, the `ALL_PROVIDER_ENV_VARS` allowlist and
why the gate is checked against the SERVER's env before the merge, the
`buildHostAgent` correction (a host session with no base agent runs the DEFAULT
PIPELINE, not S2S), and the host-mode audio pacing measurement — is in
`packages/aai-cli/CLAUDE.md`, "Running the SDK's own server (`aai dev` and host
mode)".** It went there when this guide hit its size cap; `aai dev` is the
server's principal caller and the CLI owns `AAI_DEV_HOST`, `hostModeEnv` and
`resolveServerEnv`.

## Pipeline-transport interleaving fuzz

`host/integration/pipeline-fuzz.integration.test.ts` drives the pipeline
transport through random event orderings (fast-check, no API keys; run by
`pnpm --filter @alexkroman1/aai test:integration`) and checks GLOBAL invariants
rather than specific outcomes — turn serialization, no callback after `stop()`,
no write to a closed provider session, reply-text integrity, and the strongest
oracle, validating every LLM request payload the way Anthropic and OpenAI do.
That last one is what surfaced the `capLlm` bug in the `maxHistory` row below.

**Its module doc is the guide to it** — the rules for adding an oracle, why
discovery and regression are separate jobs, what the generator produces, the
`preemptiveGeneration` arm's two honest limits, and why the coverage floors are
hand-rolled. Read it there; do not restate it here.

## Specs that observe a timer

**A spec that observes a TIMER runs on virtual time, never the wall clock.**
The pipeline-transport specs used to wait out real milliseconds
(`await sleep(60)`), which made them the first specs to fail on a contended
runner, and capped what they could describe: the dead-air cover was exercised
at `deadAirCoverMs: 1` and the SHIPPED 5s default was tested by nothing.
`useVirtualTime()` (`transports/_pipeline-transport-harness.ts`) installs
fake timers per file; drive them with `vi.advanceTimersByTimeAsync(ms)`.

**No scheduler had to be threaded through `PipelineTransportOptions`**:
`_fake-llm.ts`'s `delayMs` is the GLOBAL `setTimeout`, which is exactly what
`vi.useFakeTimers()` replaces, and `vi.waitFor` composes too.

Two things virtual time does break, both mechanical: `tick()` is a
`setTimeout(0)` and hangs until something advances the clock (use
`vi.advanceTimersByTimeAsync(0)`), and a `vi.waitFor` that polls for work
gated on a timer still polls in REAL time — prefer advancing by the amount
the work actually needs, which is deterministic and has no race to lose.

Deliberately NOT converted: `s2s-transport.test.ts`'s five `sleep(5)` calls.
Those are queue-settle yields, not timer observations — nothing is racing
them, and rewriting them would be churn.

## S2S property test

The fast-check property test over the S2S stack lives with the transports it
drives — `aai-runtime/integration/s2s-fuzz.integration.test.ts` and its four
helpers — so its design is in `packages/aai-runtime/CLAUDE.md` under the section
of this name.

## Fixture replay testing (`host/`)

A **hybrid mock**: a real `Runtime` and tool executor over a mocked S2S socket,
replaying the recorded AssemblyAI messages in `host/fixtures/` through the real
orchestration layer. `createFixtureSession` / `fireFixtureMessage` /
`makeMockHandle` in `host/_test-utils.ts` are the three helpers, documented there.
Note `fireFixtureMessage` drives `S2sCallbacks` — the S2S WIRE contract, which is
a provider adapter and deliberately NOT the session's `report` surface.

## One canonical config schema, deny-list boundaries

**One canonical config schema, deny-list boundaries.** The dropped-field bug
family (`builtinTools` — deployed agents silently lost the default cognitive
builtins; `send`; the provider triple) all came from
allow-list mappers re-declaring the config field list, where every field is
optional and an omission is valid TypeScript. Every such bug presents as a
*working* agent quietly ignoring part of its own config. The design is now
inverted — one canonical serializable schema flows CLI → server → runtime
unchanged, and each boundary subtracts an explicit deny-list instead of
copying fields:

- **`AgentConfigSchema`** (`sdk/_internal-types.ts`) is the canonical shape.
  `toAgentConfig` strips `HOST_ONLY_AGENT_FIELDS` (the five that hold
  FUNCTIONS — `tools`, `syncState`, `workflows`, `events`, `subagents`) plus
  undefined values and validates through the schema — no per-field copies.
  `_internal-types.test.ts` asserts the one subtraction:
  `Exclude<keyof AgentDef, keyof AgentConfig | HostOnlyAgentField>` is `never`.
- **`agent()`** derives its parameter shape from `AgentDef`
  (`AgentParams` = `Omit` + `Partial<Pick>` of the defaulted fields) plus
  three author-only conveniences `agent()` normalizes away (`system` as an
  alias of `systemPrompt`, `llm` accepting a gateway model-id string —
  `sdk/providers/llm/shared/from-string.ts` — and `voice` desugaring to
  `tts: assemblyAITts({ voice })`), instead
  of re-declaring it inline — the inline form is how `send` and `state`
  shipped as runtime-working but excess-property errors for authors
  (neither bundler typechecks user code). `define.test-d.ts` locks this.

  **Its defaults go through `omitUndefined`, because a spread lets a
  present-and-`undefined` key WIN over the default beneath it.**
  `agent({ greeting: undefined })` is already a compile error under
  `exactOptionalPropertyTypes` — but `agent({ name, ...opts })`, where `opts`
  is declared `{ greeting?: string; maxSteps?: number }`, is not, and that is
  how an options bag reaches `agent()`. It returned an agent whose `greeting`,
  `systemPrompt` and `maxSteps` were all `undefined` while every one of them is
  typed as REQUIRED on `AgentDef`: the agent opened on silence, ran with no
  system prompt, and the pipeline's `stopWhen` budget was `NaN` — with nothing
  anywhere reporting it. Making absent and present-and-undefined mean the same
  thing is what those fields' docs ("Defaults to …") already promise.
- **`IsolateConfigSchema`** (`aai-server/rpc-schemas.ts`) is
  `AgentConfigSchema.extend({...})` — the extensions are wire-tolerance
  loosenings, wire defaults, and the wire-only `toolSchemas`; none may drop
  a field. It runs at **deploy time only** (`validateAgentConfig`), on the
  current CLI's freshly extracted config.
- **Stored configs are FULLY OPAQUE on reads** (`StoredAgentConfigSchema` in
  `aai-server/agent-store.ts` — a bare record): the host has NO field-level
  reader left. Even the broker's `name`/`greeting` are PROXIED from the
  guest's own `/client-config` (the bundle's live agent definition,
  interpreted by the bundle's own SDK — see client-config-handler.ts), so a
  platform schema change can never re-interpret a deployed agent. A stored
  config is never re-validated against a newer schema, so tightening
  `IsolateConfigSchema` cannot 404 previously-valid deployed agents.
  Never add fields or refinements to the stored schema — strictness belongs
  at the deploy boundary.
- **The server never maps a stored config onto a runtime agent.** The old
  `toRuntimeAgent` boundary (`sandbox-agent-config.ts`) is gone with platform
  host mode — sessions run the bundle's own SDK on the bundle's own agent
  definition, so there is no server-side config→agent mapping left to drop
  fields at. (Historical context, kept because the bug class recurs: provider
  descriptors must be keyed off their own presence, never the optional
  `config.mode` — a config carrying all three providers with no `mode` once
  hit a `config.mode === "pipeline"` gate and lost every one of them, so the
  runtime resolved S2S and ran a healthy S2S session on the agent's own key,
  nothing logged. `superRefine` still rejects a `mode` that disagrees with
  the descriptors.) `rpc-schemas.test.ts` asserts the remaining subtraction:
  `Exclude<keyof AgentConfig, keyof IsolateConfig>` is `never`.

A new serializable agent field therefore needs exactly two edits — `AgentDef`
(docs + type) and `AgentConfigSchema` (shape) — and the type guards fail
loudly if either half is missing; no mapper edits, and the field reaches the
server, the wire, and the runtime by default.

**Never let S2S be a fallback.** The pipeline-by-default flip closed most of
this structurally: a config that loses its providers now gets the AssemblyAI
pipeline injected (`defaultProviders`), not a silent S2S session, and S2S
requires an explicit `s2s` descriptor. There is no fallthrough left —
`buildTransport` (`host/runtime-transport.ts`) throws on a descriptor-less
config whose pipeline providers didn't resolve (the pre-flip legacy fallback
to `buildAssemblyS2sTransport` was removed). Two rules keep mode
diagnosable: forward providers based on their own presence (above), and
`createRuntime` logs `"Session mode resolved"` once per runtime with the mode
and each stage's EFFECTIVE SETTINGS — "which transport is this agent on" must
be answerable from one log line rather than inferred from the shape of the
message stream (`S2S <<` prefixes).

**Settings, not just kinds** (`host/providers/_provider-settings.ts`). The kind
alone (`stt: "assemblyai"`) names the vendor and nothing that decides behaviour,
and almost every such value here is a DEFAULT nobody wrote down: the endpointing
pair, the Voice Focus threshold, the connect budget, the gateway model id and
its `reasoningEffort`, the TTS voice. Those are exactly what a bad session gets
blamed on — a split utterance, a mute agent, background speech in the transcript
— and none of them appeared anywhere at startup, so confirming one meant
re-deriving the `??` chains by hand against a build you hope is deployed. A
default pipeline now prints:

```text
Session mode resolved {
  slug: 'tau2-pipeline', mode: 'pipeline',
  stt: { kind: 'assemblyai', model: 'universal-3-5-pro', minTurnSilenceMs: 1600,
         maxTurnSilenceMs: 3000, voiceFocus: 'near-field',
         voiceFocusThreshold: 0.9, connectTimeoutMs: 2500, maxConnectRetries: 2 },
  llm: { kind: 'assemblyai', reasoningEffort: 'none', model: 'qwen3-next-80b-a3b' },
  tts: { kind: 'assemblyai', voice: 'jane' }
}
```

The defaults come from the SAME `resolve*Settings` function the stage's opener
dials with (`sdk/providers/**` — pure descriptor data, so this costs none of the
vendor-SDK load time `lazyOpener` defers), never a second copy of the `??`
chains: **a settings log that can drift from the wire is worse than no log,
because it is believed.** A new provider adds its resolver there and one entry
in the stage table; the tables are per-stage because `ASSEMBLYAI_STT_KIND`,
`ASSEMBLYAI_TTS_KIND`, `ASSEMBLYAI_LLM_KIND` and `ASSEMBLYAI_S2S_KIND` are four
different constants all equal to `"assemblyai"` — on `/host-internal`, since
the distinct NAMES exist only so `apiKeyEnv` can repoint one stage without
moving the others.
