---
summary: >-
  The index of every package guide, directory guide and reference sibling, one
  line each, generated from the guides' own frontmatter.
read_when: >-
  looking for the guide that owns a package, directory or subject.
---

# Agent guide index

**All three tables are GENERATED** from each guide's `summary` / `read_when`
frontmatter by `pnpm sync:guide-index` (`check:guide-index` fails when stale);
edit the guide's frontmatter, never a row. `pnpm docs:list` prints the same
index with each guide's `read_when`.

## Package guides

Package rules live in the package's `CLAUDE.md`, which Claude Code auto-loads
when you work in that package:

<!-- prettier-ignore-start -->
<!-- guide-index:packages -->
| Guide | Covers |
| --- | --- |
| `packages/aai-cli/CLAUDE.md` | Subcommands, the studio round-trip (`push`/`pull`/`publish`/`delete`), bundling + Vite rules, credential destinations, `aai dev`'s server and host mode, self-hosting (`npm start`) and `aai build --target` |
| `packages/aai-evals/CLAUDE.md` | Eval tier: recorded assertions, the spread report, why it does not gate, the two levels, and what being a LIBRARY excludes. It is not the only package with `*.eval.test.ts` — most `aai-templates` templates ship one, `aai-guest-studio` has the coding agent's and `aai-studio-server` the starter eval |
| `packages/aai-gates/CLAUDE.md` | The meta-gate suite: what a gate spec may share, adding a `guard-invariants` rule, `check.yml`'s push list and concurrency group |
| `packages/aai-guest-core/CLAUDE.md` | Why the shared guest core is its own package (the cycle two packages could not express), where `StudioSession` is declared and why, the un-underscored `test-utils.ts`, and how coverage attribution decides where a test lives |
| `packages/aai-guest-studio/CLAUDE.md` | The studio coding agent in a guest: the package boundary, the agent as an ordinary `agent()`, workspace claims and reified package.json, `read_logs`, Publish, and its tests |
| `packages/aai-guest/CLAUDE.md` | The guest harness: one binary / two modes (plus warm-up), user-shipped runtime, dev-prod parity, `run_code`, guest network access + SSRF, credential separation, and the snapshot image the harness runs from |
| `packages/aai-runtime/CLAUDE.md` | The host runtime: why it is its own package, the one-way dependency on the SDK, the `host-internal` seam, the published surface, and package-wide rules |
| `packages/aai-server/CLAUDE.md` | Platform: sandboxes + Modal backends, stateless server, security architecture, auth, telephony, durable-workflow routes, stores/locks |
| `packages/aai-studio-client/CLAUDE.md` | Studio front-end: layout and the frame, the project shell, CSP, sign-in and the session, gate screens, request deadlines and the SSE streams, the chat transport and follow-up queue, the aai-ui import rule, testing, and surviving a platform deploy |
| `packages/aai-studio-server/CLAUDE.md` | Browser studio service and the deployment's composition root: package layout, the one-deployment/two-packages composition (bundling, the shared-core exports map, public origin, cross-service invalidation, retirement and shutdown), dev serving, and the studio's eval and fuzz suites |
| `packages/aai-templates/CLAUDE.md` | Templates + scaffold packaging. Note `scaffold/CLAUDE.md` is a product artifact, not repo docs |
| `packages/aai-ui/CLAUDE.md` | Browser client package: exports and subpaths, the public-vs-internal surface rule, key files, and pointers to the directory guides for the session core, hooks, workflow apps, components, worklets and contracts. |
| `packages/aai/CLAUDE.md` | SDK package-wide rules: the `sdk/` vs `host/` boundary, the subpath exports and what decides membership, session modes, the canonical agent-config schema, data flow, and pointers to the runtime-side rules |
<!-- /guide-index:packages -->
<!-- prettier-ignore-end -->

## Directory guides

Directory guides govern one area of a package and load when you work in it:

<!-- prettier-ignore-start -->
<!-- guide-index:directories -->
| Guide | Covers |
| --- | --- |
| `packages/aai-guest/src/harness/CLAUDE.md` | The harness's agent mode: boot contract, the bundle fetch and hash check, the manage surface and its derived token, guest-owned idle/drain lifecycle, the log ring, the debug-logging forward, and `/phone`. |
| `packages/aai-runtime/src/CLAUDE.md` | aai-runtime's `src/` map — which directory holds what, what stays flat and why — plus the cross-directory rules: client surfaces, subagents, egress pools, reply metrics |
| `packages/aai-runtime/src/contracts/CLAUDE.md` | aai-runtime's capabilities and epochs: how a signature change is classified, when a capability splits, and the frozen compatibility templates |
| `packages/aai-runtime/src/integration/CLAUDE.md` | The integration-tier property tests: the S2S model-based fuzz, the pipeline fuzz, and the history-rollback oracle |
| `packages/aai-runtime/src/runtime/CLAUDE.md` | The runtime object's session wiring: the keyed system-prompt suffix, dialogs and a roster's speakers |
| `packages/aai-runtime/src/server/CLAUDE.md` | The server: `createAgentServer` as the front door — self-hosted workflows, serverless hosts, and what it forwards |
| `packages/aai-runtime/src/session/CLAUDE.md` | One session: the attach lifecycle and socket adapter, the two inbound vocabularies, hook commits, and the session directory |
| `packages/aai-runtime/src/telephony/CLAUDE.md` | Where the phone-call design lives, and the one telephony remainder in this package |
| `packages/aai-runtime/src/tools/CLAUDE.md` | Tool execution: toolsets, `withToolsDir`, the tool-result message, error classification, `clientTool`, tool speech |
| `packages/aai-runtime/src/transports/CLAUDE.md` | Transport-wide rules: the `Transport` boundary, the capability table, when each transport resolves the system prompt, and run notify |
| `packages/aai-runtime/src/transports/pipeline/CLAUDE.md` | The pipeline transport's stage map and the one-way dependency direction between stages, the heard-history record, reset re-greeting, and `speakLine` |
| `packages/aai-runtime/src/transports/pipeline/history/CLAUDE.md` | Pipeline history: token budgets for the request and the record, the preparer pipeline, and a rollback undoing its push's eviction |
| `packages/aai-runtime/src/transports/pipeline/reply/CLAUDE.md` | Pipeline replies: every code-initiated line states `{ record, interruptible }` and picks one of three placements |
| `packages/aai-runtime/src/transports/pipeline/speech/CLAUDE.md` | The caller's side of the pipeline: `speech_started` as "the agent is yielding", speculation's prompt check, push-to-talk and typed turns |
| `packages/aai-runtime/src/uploads/CLAUDE.md` | The upload store: bytes as objects, the record's two homes, immutability, window sizing and concurrency |
| `packages/aai-runtime/src/workflow/CLAUDE.md` | aai-runtime's durable-workflow half: journal selection, webhook URLs, the public vs platform base URL, and the typed-JSON codec's escape |
| `packages/aai-runtime/src/workflow/api/CLAUDE.md` | The workflow HTTP API's error-to-status classification and its upload-id boundary |
| `packages/aai-server/src/guest/CLAUDE.md` | The platform's view of a guest: the one platform→guest forward and its header policy, route exposure, the bearer gate, and exec-env/boot wiring. |
| `packages/aai-server/src/platform/CLAUDE.md` | The platform's own Postgres coordination: the per-slug mutation lock, the connection budget and pool routing, the admin pool as a throughput bound, and the PlatformEvents change-signal rules. |
| `packages/aai-server/src/sandbox/CLAUDE.md` | The backend-independent sandbox lifecycle: backend selection, the slot cache, the broker as the only routing point, one sandbox per slug fleet-wide, and the teardown-before-boot rule. |
| `packages/aai-studio-client/src/panes/CLAUDE.md` | The studio's panes: the switcher order and the UI tab's id, Settings, Secrets, the Phone card, Workflows, Logs, the Code pane's drafts, the UI preview's probe and wake, and the chat panel's pre-sandbox states |
| `packages/aai-studio-server/src/CLAUDE.md` | The studio service's feature rules: workspaces, the CLI round-trip, projects, coding-agent sessions and the fleet-wide sandbox, previews and their event streams, project secrets, agent logs, Publish, LLM selection, auth, and rate limits. |
| `packages/aai-studio-server/src/prompts/CLAUDE.md` | The studio coding agent's system prompt: the per-kind preambles, the scaffold reference they embed, the project kind that selects one, and what the prompt must say about the agent's capabilities. |
| `packages/aai-templates/src/CLAUDE.md` | The template gate specs in `aai-templates/src/`: API coverage and its allowlist, the durability and layout gates, `templates.test.ts`'s scaffold pins, prompt discovery, and what this package's tsconfig type-checks |
| `packages/aai-ui/src/CLAUDE.md` | The module-directory rules (`session/`, `audio/`, `upload/` entered through `index.ts` only, and their one-way edges), the client-config lookup, client identity and the inbox, the public hooks, the fuzz harnesses, and the workflow-app hooks (`useWorkflowRun`/`Submit`/`Stream`/`Progress`, uploads, reload recovery) over the workflow HTTP API. |
| `packages/aai-ui/src/components/CLAUDE.md` | The React component kit: memoized-props and TypeDoc rules, the conversation view and chrome pieces, `AutoScroll`, forms and `<WorkflowFields>`, and the workflow-page components (progress, run panel, upload bar, audio result). |
| `packages/aai-ui/src/contracts/CLAUDE.md` | This package's capability contracts: the fifteen capabilities, what each promises, qualified ids, and the `.tsx` compatibility fixtures. |
| `packages/aai-ui/src/session/CLAUDE.md` | The browser session core as a module directory: what `index.ts` exports and why, the statecharts (agent state and the fatal latch, the audio path), pre-connect audio, drain completion across turns, and the handshake guard. |
| `packages/aai-ui/src/worklets/CLAUDE.md` | The capture and playback AudioWorklets: the jitter buffer, gap concealment, underrun stats, capture sample rate and constraints, the dead-mic probe, and the worklet stress/bench harnesses. |
| `packages/aai/src/host/CLAUDE.md` | The SDK's Node-only modules: guest network access and `ssrf.ts`, the bounded builtin fetch, `/step-files`, `/coding-tools` |
| `packages/aai/src/sdk/CLAUDE.md` | The SDK's authoring primitives: `AgentDef` field groups, the `/testing` helpers, concurrency primitives, session slots, dialogs, `procedure()`, `ctx.generate`/`messages`/`delegate`, `speaker()`/`roster()`, `Toolset`, tool `messages`, voice presets, persistence, workflow apps and the upload client |
| `packages/aai/src/sdk/providers/CLAUDE.md` | STT/LLM/TTS/S2S provider descriptors: one defineProvider record per vendor and the generated docs table, fallback(), the shipped providers and their rules, the AssemblyAI gateway default model and its measurement, voices, adding a provider, the stage registries, and the "Session mode resolved" settings log |
<!-- /guide-index:directories -->
<!-- prettier-ignore-end -->

## The docs workspace

One guide sits outside `packages/`: [`docs/CLAUDE.md`](../docs/CLAUDE.md), for
the `aai-docs` workspace (the Astro + Starlight site, both TypeDoc renderings,
the committed markdown reference, the `typescript@6` pin) and the API reports
and capability epochs.

## Siblings

Siblings are reference files beside a package guide, read on demand (Claude Code
auto-loads only `CLAUDE.md`):

<!-- prettier-ignore-start -->
<!-- guide-index:siblings -->
| Sibling | Covers |
| --- | --- |
| `packages/aai-cli/SELF-HOSTING-CLAUDE.md` | Self-hosting: `aai start` and the built worker, `aai build --target`'s per-host emits (Vercel, Deno, Modal), the deploy-env warning, and the Node/Deno/Bun certification of the serve half |
| `packages/aai-guest-studio/CODING-AGENT-TESTS-CLAUDE.md` | Testing the studio coding agent: the agent-level unit spec through `runTextAgent`, and the agent's own EVAL — what is real in a case, the one thing that is per-case (the system prompt), and why it lives in `aai-guest-studio` rather than `aai-evals` |
| `packages/aai-runtime/DIALOG-CLAUDE.md` | What each dialog voice knob can and cannot do |
| `packages/aai-runtime/JOURNAL-CLAUDE.md` | The workflow journal and the replay engine's decisions |
| `packages/aai-runtime/TEXT-AGENT-CLAUDE.md` | Text mode |
| `packages/aai-runtime/TOOL-OUTCOMES-CLAUDE.md` | What a settled tool call leaves in `ctx.messages` (the four producers, the two silent traps) and what a thrown one becomes (`onError`'s four guard rules) |
| `packages/aai-server/MODAL-CLAUDE.md` | Modal sandboxes and backends |
| `packages/aai-server/PLATFORM-SOCKET-CLAUDE.md` | The platform session socket |
| `packages/aai-server/SCHEMA-CLAUDE.md` | The platform database schema |
| `packages/aai-server/TRACING-CLAUDE.md` | Platform tracing |
| `packages/aai-studio-client/API-DOCS-CLAUDE.md` | The studio's API pane and the public `/studio/api/<slug>` page: generated from the running agent, gated per agent shape, SDK-first snippets, the upload card, the form-field-to-JSON map, and what stays behind sign-in |
| `packages/aai-studio-server/GITHUB-SYNC-CLAUDE.md` | Sync to GitHub: the GitHub App connect flow, the unauthenticated callback's two guards, the one-commit Git Data API push, the empty-repository bootstrap, and ref-conflict retries |
| `packages/aai-studio-server/SSE-CLAUDE.md` | The studio's two long-lived event streams: shutdown, timeouts and heartbeats for the only long-lived responses the combined deployment serves |
| `packages/aai-studio-server/STARTER-EVAL-CLAUDE.md` | The studio starter eval: its five modules and why they are in that package rather than in `aai-evals`, the five tool-output regexes and what would retire them, the second in-process eval in `aai-guest-studio`, and the opt-in template behaviour contract |
| `packages/aai-templates/EXEMPLARS-CLAUDE.md` | Which template is the worked example of which SDK primitive, and the per-template accounts behind `research-handoff-agent`, `transcription-workflow`, `meeting-recap-agent` and the dialog templates |
| `packages/aai-templates/FFMPEG-CLAUDE.md` | `call-audit-workflow` as the reference use of `@alexkroman1/aai/ffmpeg`, and what cutting a recording at human boundaries takes |
| `packages/aai-templates/PORTS-CLAUDE.md` | Porting a framework's example to a voice agent |
| `packages/aai-templates/STEP-IO-CLAUDE.md` | A template's step I/O |
| `packages/aai-ui/PLAYBACK-CLAUDE.md` | The browser playback path |
| `packages/aai/AUTHORING-HELPERS-CLAUDE.md` | The speech boundary both ways, the calendar/zod argument shapes, `ctx.random`, `orFail`/`failable`, `parseWav`, `roundMoney` |
| `packages/aai/DEFAULTS-CLAUDE.md` | Every numeric default an `agent()` field carries — the value, where it is applied, and the measurement behind it |
| `packages/aai/S2S-CLAUDE.md` | S2S wire-level: the one sample rate, tool-call captions, in-band errors, `endSession`, abandoning a handshake |
<!-- /guide-index:siblings -->
<!-- prettier-ignore-end -->
