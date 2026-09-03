# aai-templates

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
