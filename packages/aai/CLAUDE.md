---
summary: >-
  SDK package-wide rules: the `sdk/` vs `host/` boundary, the subpath exports
  and what decides membership, session modes, the canonical agent-config
  schema, data flow, and pointers to the runtime-side rules
read_when: >-
  working in `packages/aai/`, or on anything an `agent.ts` imports
---

# packages/aai — SDK guide

The shared core SDK (`@alexkroman1/aai`). Repo-wide commands, conventions and
workflow live in `AGENTS.md`; platform behaviour in
`packages/aai-server/CLAUDE.md`; the host runtime in
`packages/aai-runtime/CLAUDE.md`.

## Directory guides

Claude Code loads these when you work in the directory:

- `src/sdk/CLAUDE.md` — authoring primitives: `AgentDef` field groups, the
  `/testing` helpers, concurrency primitives, slots, dialogs, `procedure()`,
  `ctx.generate`/`messages`/`delegate`, personas, tool `messages`, voice
  presets, persistence, workflow apps and the upload client.
- `src/sdk/providers/CLAUDE.md` — the STT/LLM/TTS/S2S descriptors, the
  AssemblyAI gateway default and its measurement, voices, adding a provider,
  the settings log.
- `src/host/CLAUDE.md` — the Node-only modules: guest network access
  (`ssrf.ts`), the bounded builtin fetch, `/step-files`, `/coding-tools`.

Reference siblings (read on demand): [`AUTHORING-HELPERS-CLAUDE.md`](AUTHORING-HELPERS-CLAUDE.md),
[`DEFAULTS-CLAUDE.md`](DEFAULTS-CLAUDE.md), [`S2S-CLAUDE.md`](S2S-CLAUDE.md).

## SDK structure

Two directories with a **hard dependency boundary** — critical for sandbox
security:

- **`sdk/`** — **zero Node.js dependencies**; safe in browsers, Deno and
  sandboxes. Types, the wire protocol, the canonical config
  (`agent-config.ts`, `toAgentConfig`), Standard Schema acceptance
  (`schema.ts`), the `agent()`/`tool()`/`sessionSlot()` helpers, provider
  DESCRIPTOR factories, the concurrency primitives. `sdk/tsconfig.json`
  compiles with `types: []`, so a `node:` import — or even naming a Node TYPE
  such as `NodeJS.Signals` — is a compile error, not a convention.
- **`host/`** — Node-only modules (`node:fs`, `node:child_process`, …), never
  run inside a guest sandbox: `ssrf.ts`, `_fetch-capped.ts`, the builtins, the
  coding tools, ffmpeg, html, step-files, slugify. The runtime itself
  (`server.ts`, `runtime*.ts`, transports, provider openers, the session-state
  backends) lives in `aai-runtime`.

**Rule**: new SDK code goes in `sdk/` if it has no `node:` dependency. Moving
`sdk/` → `host/` is safe; `host/` → `sdk/` requires removing every Node import.

The guest harness runs **Node** inside each Modal Sandbox, loading the agent's
ESM bundle directly; the Modal sandbox is the security boundary.

## Package exports

Twenty-three subpaths, twenty mapped below.

### The root barrel is CURATED, and `export *` is what broke it

**A symbol belongs on the root if an `agent.ts`, a tool module or a
`workflow()` would NAME it.** A budget the framework enforces on its own does
not qualify, nor does a value whose only use is reading back what the
framework already did (budgets and defaults are on `/internal`, slug/CLI
contracts and wire helpers on `/utils`). **No root export is `@internal`** —
preserve that. `index.ts`'s module doc holds the test in full and is the only
thing enforcing membership; keep it accurate.

`DEFAULT_SYSTEM_PROMPT` is exported to be READ (printed, diffed, asserted), not
composed against: `agent({ systemPrompt })` does NOT replace the prompt —
`buildSystemPrompt` always emits the voice sections and APPENDS the author's
rules under a precedence header, and strips a leading verbatim copy of the
constant.

## New features ship in `/experimental` first

**No inert knobs on the contracted surface** — a field typed and documented
but not honoured end to end (or unmeasured) costs an epoch to remove. A new,
unmeasured feature lands on `@alexkroman1/aai/experimental`
(`src/experimental.ts`), which is on `NON_AUTHORING_SUBPATHS` and
`docs-markdown.mjs`'s `UNDOCUMENTED_SUBPATHS`. Promotion is a MOVE to the
owning subpath, never a re-export from both. A contracted type may not name an
experimental one (the gate refuses unowned declarations).

**Open vocabularies are known literals `| (string & {})`, written INLINE**
(`VoicePresetName`, `TurnDetectionMode`, `BuiltinTool`, `TelephonyCarrier`,
`AssemblyAIGatewayModel`, `LlmProviderName`, `AssemblyAITtsVoice`,
`OpenAIS2sVoice`, `AssemblyAIReasoningEffort`). An unknown value compiles, is
accepted by `AgentConfigSchema`, and is WARNED about by `agentConfigWarnings`.
**Never publish the closed `Known…` half**: a grown union is not assignable to
the one it grew from, so every added name would break that export. A reader
that must be total derives it (`KnownLiterals<T>` in `sdk/is-known.ts`,
`keyof typeof VOICE_PRESETS`); `KnownLlmProvider`/`KnownGatewayModel` are on
`/host-internal`.

**A published constant is typed as its primitive**, never its literal
(`DEFAULT_SYSTEM_PROMPT: string`, `*_TIMEOUT_MS: number`): a value is a
behaviour owed a changeset, not a type an author can pin. Identifiers
(`DELEGATE_TOOL_NAME`, `SLACK_CHANNEL_KIND`) stay literal.

## One epoch classification the tool cannot make

**`aai:defaults` cannot be bumped** — its hash strips doc comments, so
`DEFAULT_SYSTEM_PROMPT`'s CONTENT can change while `--bump` refuses ("still
matches epoch N"). That is a changeset-and-review matter. Every capability was
reset to epoch 1 with nothing retained; see "Every capability restarts at epoch
1" in `docs/CLAUDE.md` for when that is wrong to repeat.

## Subpath export → file mapping

| Import path | Resolves to | What it contains |
| --- | --- | --- |
| `@alexkroman1/aai` | `src/index.ts` | The AUTHORING surface only: `agent()`/`tool()`/`sessionSlot()`/`workflow()`, their types, `assemblyAIPipeline()`/`assemblyAIS2s()`, `DEFAULT_SYSTEM_PROMPT` |
| `@alexkroman1/aai/testing` | `sdk/testing.ts` | Test helpers for an author's OWN project (`createToolContext`, `deployedAgent`, `runTool`, the stubs). Inventory and rules: "`/testing` helpers" in `src/sdk/CLAUDE.md`. May not import `vitest` (`published-testing-split`) |
| `@alexkroman1/aai/testing/vitest` | `sdk/testing-vitest.ts` | `installStubGateway` and every other `install*`/`restore`-returning helper. A helper belongs here only when its remaining content is the INSTALLATION; the fake stays framework-agnostic in `testing.ts` |
| `@alexkroman1/aai/utils` | `sdk/utils.ts` | Zero-dependency helpers a TOOL body reaches for (`errorMessage`, `safeJsonParse`, `toolFailure`/`isToolFailure`, `pushCapped`, `isRecord`, `omitUndefined`, `createKeyedLock`/`withLock`, …). **`formatBytes`/`formatDuration`/`countWords`/`plural` (`sdk/format.ts`) and `decodeHtmlEntities` are reachable only here** — read by a step AND a `client.tsx` without zod's graph. Non-localized (no `Intl`), pinned in `format.test.ts`. `plural` returns the WORD. `createKeyedLock`'s `p-timeout` is the one dependency |
| `@alexkroman1/aai/step` | `sdk/step-barrel.ts` | The vocabulary a workflow step is written against: `mapConcurrent`/`mapSettled`, `stepEnv`, `stepDelegate`, `stepFetch` (HTTP/1.1-pinned), `stepReport`/`stepEmit`, `stepGenerate`/`stepGenerateJson`, upload read/write, `stepSpeak`, `stepTranscribe*`, `isTransientStatus`/`retryAfter`. The module doc owns the rest |
| `@alexkroman1/aai/step-errors` | `sdk/step-errors.ts` | `toStepError`/`throwStepError`/`throwFatalStepError`, `FatalError`/`RetryableError`, the seven `*OrFail` callers, and `throwFfmpegStepError` — whose default is INVERTED (unrecognised = fatal). Importing from here is the opt-in to burning a step's retries. The ffmpeg guard is STRUCTURAL, not `instanceof`, because `sdk/` may not name a Node type |
| `@alexkroman1/aai/channels` | `sdk/channels-barrel.ts` | `slackChannel({ webhookUrl })` + `sendToChannel`. Descriptor is `{ kind, options }`; `text` is required; `isSlackWebhookUrl` is a SECURITY boundary |
| `@alexkroman1/aai/slugify` | `host/slugify.ts` | `slugifyName` (transliterating). Separate from the dependency-free contract in `sdk/slug.ts`; nothing on the SDK hot path may import it |
| `@alexkroman1/aai-runtime` | (other package) | The Node runtime |
| `@alexkroman1/aai/workflow-api` | `sdk/workflow-api-barrel.ts` | The CLIENT for a caller outside the agent; **`createAgentClient`** is the one to reach for. The server half is on `/internal`. A lone in-repo importer is NOT the test for removal — read the barrel's doc first. HTTP surface: `packages/aai-ui/CLAUDE.md` |
| `@alexkroman1/aai/protocol` | `sdk/protocol.ts` | Wire Zod schemas, `lenientParse()`, `SessionCommand`, the event envelope. The event VOCABULARY (`SessionEvent<K>`, `SessionEventMap`) is on the ROOT, owned by `aai:events` |
| `@alexkroman1/aai/manifest` | `sdk/manifest-barrel.ts` | `toAgentConfig()`, `agentToolsToSchemas()`, `AgentConfig`/`ToolSchema` + schemas, config-rule asserts (name is historical) |
| `@alexkroman1/aai/stt` · `/llm` · `/tts` · `/s2s` | `sdk/providers/*-barrel.ts` | Provider descriptors — see `src/sdk/providers/CLAUDE.md` |
| `@alexkroman1/aai/experimental` | `experimental.ts` | Unmeasured features before promotion; uncontracted and undocumented by deny-list entry |
| `@alexkroman1/aai/tools` | `host/agent-tools.ts` | `fetchJson`, `visitWebpage`, `webSearch`. All ANSWER `T \| ToolFailure` — narrow with `isToolFailure`; a bare `T` turns a 403 into "the web has nothing" |
| `@alexkroman1/aai/coding-tools` | `host/coding-tools-barrel.ts` | `createCodingTools({ dir })` — nine workspace tools for an agent that edits code. See `src/host/CLAUDE.md` |
| `@alexkroman1/aai/ffmpeg` | `host/ffmpeg.ts` | `runFfmpeg`/`probeMedia`/`transcodeToWav`/`describeMedia`; why, in `packages/aai-guest/CLAUDE.md` |
| `@alexkroman1/aai/html` | `host/html.ts` | `htmlToText`, `parseFeed`, `pageMetadata` over `htmlparser2`. Three functions, not a toolkit |
| `@alexkroman1/aai/step-files` | `host/step-files.ts` | Upload ↔ local-file plumbing for ffmpeg steps. See `src/host/CLAUDE.md` |
| `@alexkroman1/aai/internal` | `internal.ts` | Cross-package infrastructure, every framework BUDGET and DEFAULT, the workflow API's server half, the slug and `aai login` contracts both ends derive, the wire helpers. Not semver-covered. **ZOD-FREE, as a rule** — it rides the CLI's path. The env brands are on `aai-runtime`'s `./runtime` |

**Four subpaths are NODE-ONLY — `/ffmpeg`, `/step-files`, `/html`,
`/coding-tools`** — so they live in `host/` rather than joining `/step`. They
are CONTRACTED anyway: `NON_AUTHORING_SUBPATHS` is for surfaces whose reader
is the framework. A `workflows/*.ts` module may import them at module scope.
The `*_KIND`/`*_API_KEY_ENV` pairs are on `/host-internal`; `ProviderDescriptor`
is on the root alone.

## Session modes

`toAgentConfig()` selects one of three from which fields `agent()` got:

- **Text mode** (`text: true`, explicit) — no audio; `createTextAgent` over a
  message list. Text and `s2s` refuse each other by name. See
  `aai-runtime`'s `text-agent.ts` module doc.
- **Pipeline mode** (the DEFAULT) — any subset of `stt`/`llm`/`tts`, or none;
  `defaultProviders` (`sdk/providers/_default-providers.ts`) FILLS each unset
  stage with AssemblyAI, so `agent({ llm: llm({ … }) })` means "default
  pipeline with that LLM". The host drives the LLM loop (`streamText`).
  **A failing TURN is not a failing SESSION**: `onError` defaults to
  `fatal: true` and aai-ui ends the call on a fatal frame, so every turn-level
  reporter passes `{ fatal: false }` — `aai-runtime`'s
  `transports/pipeline-error.ts` owns it.
- **S2S mode** (`s2s: assemblyAIS2s()` or `openAIS2s()`, explicit) — one
  WebSocket; STT, LLM and TTS run service-side. **Never reachable by
  omission.** [`S2S-CLAUDE.md`](S2S-CLAUDE.md) owns the wire rules (24 kHz both
  ways, tool-call captions, in-band errors, abandoning a handshake) — read it
  before changing either S2S transport.

The default fill runs at every mode-derivation site (`toAgentConfig` and
`createRuntime`) before `assertProviderTriple`. `s2s` combined with a pipeline
provider or pipeline-only field fails `tsc` naming the rule
(`PipelineOnlyMisuse` in `AgentParams`, `sdk/define.ts`).

## One canonical config schema, deny-list boundaries

Allow-list mappers that re-declare the config field list drop fields silently
(an omission is valid TypeScript and the agent still works). So one canonical
serializable schema flows CLI → server → runtime and **each boundary subtracts
an explicit deny-list instead of copying fields**:

- **`AgentConfigSchema`** (`sdk/_internal-types.ts`) is canonical.
  `toAgentConfig` strips `HOST_ONLY_AGENT_FIELDS` (the five holding FUNCTIONS —
  `tools`, `syncState`, `workflows`, `events`, `subagents`) and undefined
  values, then validates. `_internal-types.test.ts` pins
  `Exclude<keyof AgentDef, keyof AgentConfig | HostOnlyAgentField>` = `never`.
- **`agent()`** derives its parameters from `AgentDef` (`AgentParams` = `Omit` plus
  `Partial<Pick>` of defaulted fields) plus three conveniences it normalizes
  away (`system` → `systemPrompt`, `llm` as a model-id string via
  `sdk/providers/llm/shared/from-string.ts`, `voice` → `tts:
  assemblyAITts({ voice })`). Never re-declare the shape inline — neither
  bundler typechecks user code. `define.test-d.ts` locks this. **Defaults go
  through `omitUndefined`**: a spread lets a present-and-`undefined` key (from
  an options bag) beat the default, yielding `undefined` required fields.
- **`IsolateConfigSchema`** (`aai-server/rpc-schemas.ts`) is
  `AgentConfigSchema.extend({...})`; extensions may loosen or add wire fields,
  never drop one. Runs at **deploy time only**.
- **Stored configs are FULLY OPAQUE on reads** (`StoredAgentConfigSchema`, a
  bare record). Name/greeting are proxied from the guest. **Never add fields or
  refinements to the stored schema** — strictness belongs at deploy.
- **The server never maps a stored config onto a runtime agent**; sessions run
  the bundle's own SDK. Provider descriptors are keyed off their own presence,
  never the optional `config.mode` (`superRefine` rejects a disagreeing
  `mode`). `rpc-schemas.test.ts` pins
  `Exclude<keyof AgentConfig, keyof IsolateConfig>` = `never`.

A new serializable field needs exactly two edits — `AgentDef` (docs + type)
and `AgentConfigSchema` — and the type guards fail if either is missing.

### Never let S2S be a fallback

A config that loses its providers gets the AssemblyAI pipeline
(`defaultProviders`), never a silent S2S session. `buildTransport`
(`aai-runtime`'s `runtime-transport.ts`) throws on a descriptor-less config
whose pipeline providers did not resolve. `createRuntime` logs
`"Session mode resolved"` once with the mode and each stage's effective
settings (see "Settings, not just kinds" in `src/sdk/providers/CLAUDE.md`).

## Data flow

On the platform the browser's session WebSocket connects DIRECTLY to the
agent's sandbox (`/session` on its Modal tunnel, discovered via
`GET /:slug/client-config`); "server" is the guest harness, or the `aai dev`
server locally.

- **S2S**: PCM → WebSocket → one provider socket → service-side LLM + tools →
  audio back through the same socket → browser.
- **Pipeline**: PCM → STT → `user-transcript.updated` partials and
  `speech.started`/`speech.stopped` → `user-transcript.committed` → host LLM
  loop (`streamText`, tools host-side) → TTS → browser. A barge-in that never
  commits a user turn resumes the reply (`resumeFalseInterruption`).
  `preemptiveGeneration` is OFF by default.

## Default values and magic numbers

Numeric constants live in `sdk/constants.ts` (client-audio budgets in
`sdk/client-audio-constants.ts`). **Every default — value, where applied, the
measurement — is in [`DEFAULTS-CLAUDE.md`](DEFAULTS-CLAUDE.md); read it before
changing one.**

## Rules whose code lives in `aai-runtime`

These are cited from this guide by older comments. The first four are owned by
`packages/aai-runtime/src/CLAUDE.md` and
`packages/aai-runtime/src/transports/CLAUDE.md`, the last by
`packages/aai-runtime/src/integration/CLAUDE.md`; the rest live only here.

- **Session vocabularies**: `ServerSession` takes `command(cmd)` and
  `report(event)` plus two audio paths — no `on*` callbacks
  (`guard-invariants` rule 16).
- **A `reset` GREETS**: pipeline `reset()` ends with `lifecycle.greet()`;
  `skipGreeting` does not reach it; S2S does not re-greet (a known gap).
- **History records what was HEARD**: an interrupted reply is stored as the
  estimated heard words, marked `[interrupted]` (`transports/pipeline-heard.ts`).
- **`speech_started` means "the agent is yielding"** on both transports;
  pipeline mode holds it back while the agent has the floor.
- **A request-path decode never throws**: `decodePathSegment`
  (`_path-decode.ts`) is the one spelling; `undefined` means "not decodable" and
  each caller answers 400/404/decline. **Never call `decodeURIComponent` on a
  request path, and never re-throw** — a synchronous `URIError` reaches the
  guest's `uncaughtException` guard and kills every session on the sandbox.
- **Provider sockets disable permessage-deflate**: every provider-facing `ws`
  client spreads `PROVIDER_WS_OPTIONS` (`_ws.ts`; pinned by `_ws.test.ts`).
  Vendor-SDK providers (assemblyai STT, Deepgram, ElevenLabs, Cartesia) cannot
  be covered.
- **Self-hosted server defaults**: `createRuntimeServer` has no auth, so it
  **binds loopback** (`AAI_DEV_HOST` to override) and **host mode is opt-in**
  (`AAI_ALLOW_HOST`). `createHostServer` is the host-only server in one call.
  The rest is in `packages/aai-cli/CLAUDE.md`, "Running the SDK's own server".
- **S2S property test**: `integration/s2s-fuzz.integration.test.ts`.

### Pipeline-transport interleaving fuzz

`aai-runtime`'s `integration/pipeline-fuzz.integration.test.ts` drives the
pipeline transport through random orderings (fast-check, no keys) and checks
GLOBAL invariants, including validating every LLM request payload the way
Anthropic and OpenAI do. **Its module doc is the guide** — oracles, generator,
coverage floors.

### Specs that observe a timer

**A spec that observes a TIMER runs on virtual time, never the wall clock.**
`useVirtualTime()` (`transports/_pipeline-transport-harness.ts`) installs fake
timers per file; drive with `vi.advanceTimersByTimeAsync(ms)`. `_fake-llm.ts`'s
`delayMs` uses the global `setTimeout`, so no scheduler needs threading. Under
virtual time `tick()` hangs (use `vi.advanceTimersByTimeAsync(0)`), and
`vi.waitFor` still polls in real time — advance by the amount the work needs.
Queue-settle yields (`s2s-transport.test.ts`'s `sleep(5)`) are not timer
observations and stay.

### Fixture replay testing

A real `Runtime` and tool executor over a mocked S2S socket, replaying recorded
AssemblyAI messages from `fixtures/`. `createFixtureSession` /
`fireFixtureMessage` / `makeMockHandle` in `_test-utils.ts`.
`fireFixtureMessage` drives `S2sCallbacks` (the wire contract), not the
session's `report` surface.
