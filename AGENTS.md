# AGENTS.md

Guidance for coding agents (and humans) working in this repository.

The root `CLAUDE.md` is one line, `@AGENTS.md`, so every agent tool reads one
copy. Edit THIS file, never `CLAUDE.md` (`claude-md-limit.test.ts` fails).
Package and directory guides are named `CLAUDE.md` so Claude Code auto-loads
them; `konsistent.json` requires one per package.

## Overview

AAI is a voice agent development kit. Users define agents as directories
containing `agent.ts`. The CLI bundles and deploys them to the managed platform.

- **Platform**: `agent.ts` → CLI bundle → deploy to managed server

## Detailed references

**This file holds what is needed on EVERY task**; everything else is read on
demand. `pnpm docs:list` prints every guide with one line on what it covers and
one on when to read it. Repo-wide reference lives in `.agents/`:

<!-- guide-index:references -->
| Reference | Covers |
| --- | --- |
| [`.agents/ci.md`](.agents/ci.md) | The required check job, `pnpm check`, turbo strict env mode, task `inputs`, and the cache paths. |
| [`.agents/dependencies.md`](.agents/dependencies.md) | The pnpm catalog, manifest shape and format checks, what a published manifest owes, the 24-hour release-age quarantine, action SHA pinning, and the artifact size budget. |
| [`.agents/ratchets.md`](.agents/ratchets.md) | Every gate beyond lint/typecheck/test: what each one checks, the failure it was written for, and the baseline or floor it carries. |
| [`.agents/releases.md`](.agents/releases.md) | The fixed release group, what arms a deploy, and how to write a changeset. |
| [`.agents/testing.md`](.agents/testing.md) | Vitest conventions, harness declaration, snapshots, teardown, virtual time, coverage, the per-package configs, test env vars, and the property-test rules. The TIER table stays in AGENTS.md — it is needed on every task; this is the detail behind it. |
<!-- /guide-index:references -->

Procedures live in skills under `.claude/skills/` and load when their
description matches the task: `pr-workflow`, `changeset-release`,
`api-contract-epoch-bump`, and `expose-guest-route`.

## Commands

```sh
pnpm install             # Install dependencies
pnpm test                # Run all unit tests (vitest)
pnpm lint                # Run Biome linter (all packages)
pnpm typecheck           # Type-check all packages
pnpm lint:fix            # Auto-fix lint issues
pnpm check:konsistent    # Structural conventions (konsistent.json)
pnpm check:local         # Fast pre-commit gate (single turbo invocation, max parallelism)
pnpm check:affected      # Only check packages affected by changes since main
pnpm docs:list           # Every agent guide: what it covers, when to read it
```

**Never type `turbo run <task>` across the workspace directly** — use the
`pnpm` scripts, which set `TURBO_CONCURRENCY` via
`scripts/with-worker-budget.mjs` so turbo and vitest's pool share one CPU
budget. A longer timeout is never the fix for contention.

### Test tiers

**Tiers are cut by what a test may TOUCH: pick the tightest one that can express
the assertion.**

| Tier | Command | Membership rule | Timeout |
| --- | --- | --- | --- |
| Unit | `pnpm test` | no filesystem writes, subprocess, or real network | 5s |
| Integration | `pnpm test:integration` | multiple modules **in memory** | 30s |
| Scenario | `pnpm test:scenario` | a real subprocess, port, bundler, Postgres, or NETWORK | 120s |
| Scenario + real Postgres | `pnpm test:pg` | the above, `AAI_TEST_PG_URL` resolved | 120s |
| E2E | `pnpm test:e2e` | full process spawn + Playwright browser | 300s |
| Eval | `pnpm test:eval` | a live model on a real key, `*.eval.test.ts` | 1800s |
| Templates | `pnpm test:templates` | template agent example tests | 5s |

- **Membership is a NAMING CONVENTION** (`*.integration.test.ts`,
  `*.scenario.test.ts`, `*.eval.test.ts`), so a new test needs no config edit;
  exceptions are in `.agents/testing.md`.
- **Real NETWORK puts a test in SCENARIO**, even when its assertions are fast.
- **No tier carries a `retry`** — a tier that retries has classified its own
  failures as noise (`vitest.slow.config.ts`).
- **A LIVE eval REPORTS and does not gate**; `pnpm check` runs the same files
  with `AAI_EVAL_STUB=1` (a scripted model), gating wiring, not behaviour.
- **Postgres-backed scenario suites SKIP without a database, and say so**
  (`describeWithPg` / `describeWithStack`). `AAI_REQUIRE_PG` /
  `AAI_REQUIRE_STACK` (and e2e's `AAI_REQUIRE_REGISTRY`) turn a skip into a
  failure and must be in the task's `env` in `turbo.json`, or strict env mode
  strips them. Never call `pgUrl()` at the top of a gated `describe` body — see
  "Gating a suite on a real Postgres" in `packages/aai-server/CLAUDE.md`.

### Single-package shortcuts

```sh
pnpm test:aai-core       # Run only aai unit tests
pnpm test:aai-ui         # Run only aai-ui unit tests
pnpm test:aai-cli        # Run only aai-cli unit tests
pnpm test:aai-server     # Run only aai-server unit tests
pnpm test:aai-studio-client  # Run studio front-end unit tests
pnpm test:templates      # Run template agent tests
pnpm dev:aai-server      # Start aai-server in dev mode
```

### Running specific tests

```sh
pnpm vitest run --project aai                   # Single package via --project
pnpm vitest run packages/aai/src/sdk/types.test.ts  # Single file
pnpm vitest run session                         # All files matching "session"
pnpm --filter @alexkroman1/aai test             # Single package via pnpm filter
```

## Architecture

Thirteen workspace packages under `packages/`:

| Package | npm name | Purpose |
| --- | --- | --- |
| `packages/aai/` | `@alexkroman1/aai` | Shared core: agent config, types, protocol, S2S, session, Db |
| `packages/aai-ui/` | `@alexkroman1/aai-ui` | Browser client (React 19): session, audio, UI components |
| `packages/aai-runtime/` | `@alexkroman1/aai-runtime` | The HOST runtime (`createRuntime`/`createAgentServer`, session core, transports, providers, workflow API): what runs an `agent.ts`, which imports none of it |
| `packages/aai-cli/` | `@alexkroman1/aai-cli` | The `aai` CLI: init, dev, console, test, eval, build, list, pull, push, publish, delete, login, secret, logs, workflow, templates (`deploy` is hidden/internal — the mechanism in-guest Publish runs). The list is pinned to the registry in `cli.test.ts` |
| `packages/aai-guest/` | `aai-guest` | Guest sandbox harness (private): runs the agent inside each Modal Sandbox, built into one `dist/harness.mjs`; holds the guest image's `toolchain/` |
| `packages/aai-guest-core/` | `aai-guest-core` | The modules both guest modes need (private): `rpc`, `types`, `bundle`, `auth`, `http`, plus `trial` (the `run_code`/tool executor) and `limits` |
| `packages/aai-guest-studio/` | `aai-guest-studio` | The studio coding agent as it runs in a guest (private), plus the generated `studio-prompts/` copies |
| `packages/aai-server/` | `aai-server` | Agent service + shared platform core (private): sandbox, auth, SSRF, stores, locks |
| `packages/aai-studio-server/` | `aai-studio-server` | Studio service (private): browser coding agent, workspace builds. Also the composition root — its entry is the one every deployment runs |
| `packages/aai-studio-client/` | `aai-studio-client` | The studio's browser front-end (private): Vite React app served by aai-server |
| `packages/aai-templates/` | `aai-templates` | Agent templates + scaffold (private): starter templates |
| `packages/aai-gates/` | `aai-gates` | Meta-gate suite (private): specs holding `scripts/check-*.mjs`, `konsistent.json`, `turbo.json`, `lefthook.yml` and the workflows to their contracts |
| `packages/aai-evals/` | `aai-evals` | Behaviour eval LIBRARY (private): recording runner, spread report, assertion vocabulary |

**Dependency flow:**

- Every package depends on `@alexkroman1/aai` (`workspace:*`). `aai-runtime`
  sits one layer above it and imports only `aai`; the CLI, guest, server and
  evals take the host runtime from `aai-runtime`.
- `aai-server` depends on `aai-guest` only to resolve its built artifact
  (`aai-guest/harness` → `dist/harness.mjs`, baked into the guest image). It
  never imports guest source, and the guest never imports server code.
- The guest is three packages: `aai-guest-core` → nothing in the trio,
  `aai-guest-studio` → core, `aai-guest` → both; tsdown bundles them into one
  artifact (`packages/aai-guest-core/CLAUDE.md`).
- The one edge to the CLI is `aai-guest` → `aai-cli`, for four public subpaths
  only: `/worker-bundler`, `/client-bundler`, `/typecheck` (the studio builds
  with the CLI's own pipeline) and `/project-config`. Do not widen it — nothing
  else may import the CLI, and the CLI must never import the server or guest.
- `aai-studio-server` owns three more edges: → `aai-server` (subpath exports
  only — a konsistent rule must end `/*` to match them), →
  `aai-studio-client/starters`, and a DEV edge → `aai-evals`.
- `aai-evals` may import only the SDK and `@alexkroman1/aai-runtime/eval`
  (`evals-package-boundary`).

**Publishable packages must use the `@alexkroman1/` scope** — the unscoped
`aai`, `aai-ui`, `aai-cli` belong to other npm publishers
(`scripts/check-publish-names.mjs`).

### Package guides

**This file holds only what is repo-wide.** Package rules live in the
package's `CLAUDE.md` and area rules in the governed directory's `CLAUDE.md`;
Claude Code loads both when you work there:

<!-- guide-index:packages -->
| Guide | Covers |
| --- | --- |
| `packages/aai-cli/CLAUDE.md` | Subcommands, the studio round-trip (`push`/`pull`/`publish`/`delete`), bundling + Vite rules, credential destinations, `aai dev`'s server and host mode, self-hosting (`npm start`) and `aai build --target` |
| `packages/aai-evals/CLAUDE.md` | Eval tier: recorded assertions, the spread report, why it does not gate, the two levels, and what being a LIBRARY excludes. It is not the only package with `*.eval.test.ts` — `aai-templates` ships 25, `aai-guest` one and `aai-studio-server` the starter eval |
| `packages/aai-gates/CLAUDE.md` | The meta-gate suite: what a gate spec may share, adding a `guard-invariants` rule, `check.yml`'s push list and concurrency group |
| `packages/aai-guest-core/CLAUDE.md` | Why the shared guest core is its own package (the cycle two packages could not express), where `StudioSession` is declared and why, the un-underscored `test-utils.ts`, and how coverage attribution decides where a test lives |
| `packages/aai-guest-studio/CLAUDE.md` | The studio coding agent in a guest: the package boundary, the agent as an ordinary `agent()`, workspace claims and reified package.json, `read_logs`, Publish, and its tests |
| `packages/aai-guest/CLAUDE.md` | The guest harness: one binary / two modes (plus warm-up), user-shipped runtime, dev-prod parity, `run_code`, guest network access + SSRF, credential separation, and the snapshot image the harness runs from |
| `packages/aai-runtime/CLAUDE.md` | The host runtime: why it is its own package, the one-way dependency on the SDK, the `host-internal` seam, the published surface, and package-wide rules |
| `packages/aai-server/CLAUDE.md` | Platform: sandboxes + Modal backends, stateless server, security architecture, auth, telephony, durable-workflow routes, stores/locks |
| `packages/aai-studio-client/CLAUDE.md` | Studio front-end: panes, composer queue, CSP, preview probing |
| `packages/aai-studio-server/CLAUDE.md` | Browser studio service and the deployment's composition root: package layout, the one-deployment/two-packages composition (bundling, the shared-core exports map, public origin, cross-service invalidation, retirement and shutdown), dev serving, and the studio's eval and fuzz suites |
| `packages/aai-templates/CLAUDE.md` | Templates + scaffold packaging. Note `scaffold/CLAUDE.md` is a product artifact, not repo docs |
| `packages/aai-ui/CLAUDE.md` | Browser client package: exports and subpaths, the public-vs-internal surface rule, key files, and pointers to the directory guides for the session core, hooks, workflow apps, components, worklets and contracts. |
| `packages/aai/CLAUDE.md` | SDK package-wide rules: the `sdk/` vs `host/` boundary, the subpath exports and what decides membership, session modes, the canonical agent-config schema, data flow, and pointers to the runtime-side rules |
<!-- /guide-index:packages -->

Directory guides govern one area of a package and load when you work in it:

<!-- guide-index:directories -->
| Guide | Covers |
| --- | --- |
| `packages/aai-guest/src/harness/CLAUDE.md` | The harness's agent mode: boot contract, the bundle fetch and hash check, the manage surface and its derived token, guest-owned idle/drain lifecycle, the log ring, the debug-logging forward, and `/phone`. |
| `packages/aai-runtime/src/CLAUDE.md` | Rules for aai-runtime's flat `src/` modules: session lifecycle and vocabularies, `createAgentServer`, tools, subagents, the prompt suffix, dialogs/personas wiring, hook commits, the upload store, egress pools, reply metrics |
| `packages/aai-runtime/src/contracts/CLAUDE.md` | aai-runtime's capabilities and epochs: how a signature change is classified, when a capability splits, and the frozen compatibility templates |
| `packages/aai-runtime/src/integration/CLAUDE.md` | The integration-tier property tests: the S2S model-based fuzz, the pipeline fuzz, and the history-rollback oracle |
| `packages/aai-runtime/src/telephony/CLAUDE.md` | Where the phone-call design lives, and the one telephony remainder in this package |
| `packages/aai-runtime/src/transports/CLAUDE.md` | Pipeline and S2S transport behaviour: `speech_started`, per-turn prompt resolution, heard-history, the context budget, rollback at the cap, reset, push-to-talk |
| `packages/aai-runtime/src/workflow/CLAUDE.md` | aai-runtime's durable-workflow half: journal selection, webhook URLs, the public vs platform base URL, and the typed-JSON codec's escape |
| `packages/aai-runtime/src/workflow/api/CLAUDE.md` | The workflow HTTP API's error-to-status classification and its upload-id boundary |
| `packages/aai-server/src/guest/CLAUDE.md` | The platform's view of a guest: the one platform→guest forward and its header policy, route exposure, the bearer gate, and exec-env/boot wiring. |
| `packages/aai-server/src/platform/CLAUDE.md` | The platform's own Postgres coordination: the per-slug mutation lock, the connection budget and pool routing, the admin pool as a throughput bound, and the PlatformEvents change-signal rules. |
| `packages/aai-server/src/sandbox/CLAUDE.md` | The backend-independent sandbox lifecycle: backend selection, the slot cache, the broker as the only routing point, one sandbox per slug fleet-wide, and the teardown-before-boot rule. |
| `packages/aai-studio-server/src/CLAUDE.md` | The studio service's feature rules: workspaces, the CLI round-trip, projects, coding-agent sessions and the fleet-wide sandbox, previews and their event streams, project secrets, agent logs, Publish, LLM selection, auth, and rate limits. |
| `packages/aai-studio-server/src/prompts/CLAUDE.md` | The studio coding agent's system prompt: the per-kind preambles, the scaffold reference they embed, the project kind that selects one, and what the prompt must say about the agent's capabilities. |
| `packages/aai-templates/src/CLAUDE.md` | The template gate specs in `aai-templates/src/`: API coverage and its allowlist, the durability and layout gates, `templates.test.ts`'s scaffold pins, prompt discovery, and what this package's tsconfig type-checks |
| `packages/aai-ui/src/CLAUDE.md` | The browser session core (statecharts, fatal latch, handshake guard, client-config lookup), the public hooks, the fuzz harnesses, and the workflow-app hooks (`useWorkflowRun`/`Submit`/`Stream`/`Progress`, uploads, reload recovery) over the workflow HTTP API. |
| `packages/aai-ui/src/components/CLAUDE.md` | The React component kit: memoized-props and TypeDoc rules, the conversation view and chrome pieces, `AutoScroll`, forms and `<WorkflowFields>`, and the workflow-page components (progress, run panel, upload bar, audio result). |
| `packages/aai-ui/src/contracts/CLAUDE.md` | This package's capability contracts: the ten capabilities, what each promises, qualified ids, and the `.tsx` compatibility fixtures. |
| `packages/aai-ui/src/worklets/CLAUDE.md` | The capture and playback AudioWorklets: the jitter buffer, gap concealment, underrun stats, capture sample rate and constraints, the dead-mic probe, and the worklet stress/bench harnesses. |
| `packages/aai/src/host/CLAUDE.md` | The SDK's Node-only modules: guest network access and `ssrf.ts`, the bounded builtin fetch, `/step-files`, `/coding-tools` |
| `packages/aai/src/sdk/CLAUDE.md` | The SDK's authoring primitives: `AgentDef` field groups, the `/testing` helpers, concurrency primitives, session slots, dialogs, `procedure()`, `ctx.generate`/`messages`/`delegate`, personas, tool `messages`, voice presets, persistence, workflow apps and the upload client |
| `packages/aai/src/sdk/providers/CLAUDE.md` | STT/LLM/TTS/S2S provider descriptors: the shipped providers and their rules, the AssemblyAI gateway default model and its measurement, voices, adding a provider, the stage registries, and the "Session mode resolved" settings log |
<!-- /guide-index:directories -->

One guide sits outside `packages/`: [`docs/CLAUDE.md`](docs/CLAUDE.md), for the
`aai-docs` workspace (the Astro + Starlight site, both TypeDoc renderings, the
committed markdown reference, the `typescript@6` pin) and the API reports and
capability epochs.

Siblings are reference files beside a package guide, read on demand (Claude Code
auto-loads only `CLAUDE.md`):

<!-- guide-index:siblings -->
| Sibling | Covers |
| --- | --- |
| `packages/aai-guest/CODING-AGENT-TESTS-CLAUDE.md` | Testing the studio coding agent: the agent-level unit spec through `runTextAgent`, and the agent's own EVAL — what is real in a case, the one thing that is not (the system prompt), and why it lives in `aai-guest` rather than `aai-evals` |
| `packages/aai-runtime/DIALOG-CLAUDE.md` | What each dialog voice knob can and cannot do |
| `packages/aai-runtime/JOURNAL-CLAUDE.md` | The workflow journal and the replay engine's decisions |
| `packages/aai-runtime/TEXT-AGENT-CLAUDE.md` | Text mode |
| `packages/aai-runtime/TOOL-OUTCOMES-CLAUDE.md` | What a settled tool call leaves in `ctx.messages` (the four producers, the two silent traps) and what a thrown one becomes (`onError`'s four guard rules) |
| `packages/aai-server/MODAL-CLAUDE.md` | Modal sandboxes and backends |
| `packages/aai-server/PLATFORM-SOCKET-CLAUDE.md` | The platform session socket |
| `packages/aai-server/SCHEMA-CLAUDE.md` | The platform database schema |
| `packages/aai-server/TRACING-CLAUDE.md` | Platform tracing |
| `packages/aai-studio-server/GITHUB-SYNC-CLAUDE.md` | Sync to GitHub: the GitHub App connect flow, the unauthenticated callback's two guards, the one-commit Git Data API push, the empty-repository bootstrap, and ref-conflict retries |
| `packages/aai-studio-server/SSE-CLAUDE.md` | The studio's two long-lived event streams: shutdown, timeouts and heartbeats for the only long-lived responses the combined deployment serves |
| `packages/aai-studio-server/STARTER-EVAL-CLAUDE.md` | The studio starter eval: its five modules and why they are in that package rather than in `aai-evals`, the five tool-output regexes and what would retire them, the second in-process eval in `aai-guest`, and the opt-in template behaviour contract |
| `packages/aai-templates/EXEMPLARS-CLAUDE.md` | Which template is the worked example of which SDK primitive, and the per-template accounts behind `research-handoff-agent`, `transcription-workflow`, `meeting-recap-agent` and the dialog templates |
| `packages/aai-templates/FFMPEG-CLAUDE.md` | `call-audit-workflow` as the reference use of `@alexkroman1/aai/ffmpeg`, and what cutting a recording at human boundaries takes |
| `packages/aai-templates/PORTS-CLAUDE.md` | Porting a framework's example to a voice agent |
| `packages/aai-templates/STEP-IO-CLAUDE.md` | A template's step I/O |
| `packages/aai-ui/PLAYBACK-CLAUDE.md` | The browser playback path |
| `packages/aai/AUTHORING-HELPERS-CLAUDE.md` | The speech boundary both ways, the calendar/zod argument shapes, `ctx.random`, `orFail`/`failable`, `parseWav`, `roundMoney` |
| `packages/aai/DEFAULTS-CLAUDE.md` | Every numeric default an `agent()` field carries — the value, where it is applied, and the measurement behind it |
| `packages/aai/S2S-CLAUDE.md` | S2S wire-level: the one sample rate, tool-call captions, in-band errors, `endSession`, abandoning a handshake |
<!-- /guide-index:siblings -->

**All three tables are GENERATED** from each guide's `summary` / `read_when`
frontmatter by `pnpm sync:guide-index` (`check:guide-index` fails when stale).

## Conventions

- **Runtime**: Node everywhere (host, platform server, and guest sandbox)
- **Frameworks**: React (client UI), Tailwind CSS v4 (compiled at bundle time)
- **Linting**: Biome, auto-run on staged files by the pre-commit hook. **Every
  package needs a `lint` script** (`biome check .`), or `turbo run lint` skips
  it silently. Filenames are kebab-case (`useFilenamingConvention`); `tools/`
  files are exempt because they mirror snake_case LLM tool names. Biome
  `^2.5.12` is a FLOOR, exempt from the release-age quarantine
  (`pnpm-workspace.yaml`) — do not lower it.

### Package layout

**Every package is `src/` plus its configs.** Code, tests, fixtures and
contracts live in `packages/<pkg>/src/`; manifests, configs, guides, `etc/` and
static assets stay at the root (plus `aai-templates`' `templates/` and
`scaffold/`, shipped product checked by `check:template-types`).
`tsconfig.build.json` sets `rootDir: "src"` so nothing else reaches `dist/`.
Enforced by `check:package-layout`.

### File naming conventions

| Pattern | Meaning | Example |
| --- | --- | --- |
| `_foo.ts` | **Internal module** — not part of the public API. Never import cross-package. Biome's `noPrivateImports` rule enforces this at lint time. | `_utils.ts`, `_bundler.ts`, `_internal-types.ts` |
| `foo-barrel.ts` | **Barrel re-export file** — aggregates exports from multiple modules into one subpath export. Has `biome-ignore` for `noReExportAll`. | `runtime-barrel.ts`, `manifest-barrel.ts` |
| `foo.test.ts` | **Unit test** — co-located with source. Runs via `pnpm test`. | `session.test.ts` |
| `foo.test-d.ts` | **Type-level test** — checked by tsc, never executed at runtime. Uses `expectTypeOf`. | `types.test-d.ts` |
| `_test-utils.ts` | **Test helpers** — each package has its own with different utilities (see below). | `host/_test-utils.ts` |

### `_test-utils.ts` per package (not interchangeable)

Each package's helper module is its own; a spec uses the one beside it, never
another package's. The paths and roster are the **`test-helper-modules`**
konsistent convention. In the published pair, anything that INSTALLS or
RESTORES goes in `@alexkroman1/aai/testing/vitest`, and `testing.ts` may not
import `vitest` (**`published-testing-split`**; inventory in
`packages/aai/CLAUDE.md`).

### `@dev/source` custom export condition

Every export names `"@dev/source": "./src/…"` FIRST, then `types`/`import`
under `./dist/…`. The root `tsconfig.json`'s `customConditions:
["@dev/source"]` resolves workspace imports to source with no build step; a
consumer without it gets `dist`. Condition order matters (first match wins),
which is why `.syncpackrc.json`'s `sortExports` names `@dev/source` first.

### Import rules

- **Cross-package imports** must use the npm package name (e.g.
  `import { X } from "@alexkroman1/aai/protocol"`), never relative paths between
  packages. Biome's `noRestrictedImports` enforces this.
- **Internal modules** (`_*.ts`) must not be imported from outside their
  own package. Biome's `noPrivateImports` enforces this.
- **Re-exports**: barrel files use `export * from "..."` with explicit
  `biome-ignore` comments. Follow re-export chains to find the original
  source of a type/function.

### Disambiguating cross-package names

A name published by both `aai` and `aai-ui` (e.g. `SessionErrorCode`,
`WorkflowApi`) is a re-export of the one `aai` declaration; `API-EXPORTS.json`
records each name's subpath. When two packages name one concept from opposite
ends of the wire, name each by its side (`ServerSession` in `aai-runtime`,
`BrowserSession` in `aai-ui`). The three workflow-client factories are told
apart in `packages/aai-ui/CLAUDE.md`.

### Concurrency primitives (use these, don't hand-roll)

The catalogue is the **`concurrency-primitives`** konsistent convention plus
"Concurrency primitives" in `packages/aai/src/sdk/CLAUDE.md`; `guard-invariants`
rules 2, 3, 4, 19, 21, 22, 23 and 31 catch hand-rolled copies. Two are
repo-wide:

- **Timeouts**: use `p-timeout`, never a hand-rolled `Promise.race` with a
  timer (the losing branch's late rejection and timer cleanup are what get
  re-derived wrong). tsdown bundles it into the guest harness too.
- **Combining abort signals**: use native `AbortSignal.any([...])`.

### The published surface is described by three committed artifacts

| Artifact | Gate | Question it answers |
| --- | --- | --- |
| `packages/*/etc/*.api.md`, `API.md`, `API-EXPORTS.json`, `API-INDEX.md` | `pnpm check:api-report` | did a SIGNATURE move, is a name in or out, and where is it imported FROM |
| `packages/<pkg>/src/contracts/epochs/<capability>/v<N>.json` + `.../contracts/compatibility/**` | `pnpm check:api-contracts` | is that move BREAKING, and for whom |
| `docs/api/**`, `docs/dist/**` | `pnpm check:docs-md`, the turbo `docs` task | what does it MEAN (the doc comments) |

All three are derived: regenerate, never hand-edit. **A moved capability hash
must be RECORDED before it can land**, and a new subpath export defaults INTO
all three and fails until covered or excused in writing. The procedure is the
`api-contract-epoch-bump` skill; the mechanism is in
[`docs/CLAUDE.md`](docs/CLAUDE.md).

### The authoring guide ships inside the SDK

`scaffold/CLAUDE.md` is the one source of truth for writing an aai agent;
`pnpm sync:agent-guide` copies it to `packages/aai/AGENT_GUIDE.md`
(`check:agent-guide`). See the same heading in `packages/aai-templates/CLAUDE.md`.

### API reference docs

`pnpm docs:api` builds the GitHub Pages site; `pnpm docs:md` writes the
committed markdown reference an agent can `cat` (`docs/api/**`). See
[`docs/CLAUDE.md`](docs/CLAUDE.md).

### Updating agent guides

**Put a rule where an agent will be when it needs it:**

| Where | What belongs there |
| --- | --- |
| `AGENTS.md` | what every task needs before acting: tiers, package map, naming and import conventions, workflow pointers |
| `.agents/*.md` | repo-wide reference read once you are in an area (a gate's detail, a config's shape) |
| `packages/<pkg>/CLAUDE.md` | rules for the whole package |
| `<dir>/CLAUDE.md` | rules for the files in that directory — the deepest directory that still covers them all |
| `<PKG>/<NAME>-CLAUDE.md` sibling | on-demand reference when no directory owns it |
| `.claude/skills/<name>/SKILL.md` | a step-by-step procedure; the guide keeps a one-line pointer |
| a guard (`guard-invariants`, konsistent, a gate spec) | anything mechanically checkable — prose is the fallback |

**Write each rule as: the rule, one sentence of why when it is not obvious, and
a link** to what enforces it; if a guard enforces it, say so in one line.
History — what broke, measurements, what the rule replaced — belongs in commit
messages and PR bodies. Never drop a rule, gotcha or security constraint to
save space; compress it.

A guide documents code that EXISTS; designs belong on their issue.
Auto-loaded guides (this file, package and directory `CLAUDE.md`,
`docs/CLAUDE.md`) are capped at 40,000 characters, with a shrink-only baseline
for files still over it; reference files (`.agents/`, siblings, the scaffold
guide) at 120,000. Both are enforced by `check:claude-md`, which also prints a
nearly-full guide's largest sections.

## PR workflow

When a branch is done, push it and open a PR without asking. Run
`pnpm check:local` before the first commit and rebase on `origin/main` before
pushing. The pre-push hook blocks pushes to `main`, a branch behind or
conflicting with `origin/main`, a missing changeset and a failing `pnpm check`.
In a worktree, `unset GIT_DIR` before `pnpm changeset status` and install with
`--frozen-lockfile`; never edit `pnpm-lock.yaml` directly. Full procedure: the
`pr-workflow` skill; changesets: the `changeset-release` skill.

## A new guest route must declare how the PLATFORM exposes it

`aai dev` serves every guest route directly, but the deployed platform does
not, so each new route must declare its exposure (the **`guest-route-exposure`**
konsistent convention; `guard-invariants` rule 12). The procedure is the
`expose-guest-route` skill; the four exposure kinds are in "A new guest route
must declare how the PLATFORM exposes it" in `packages/aai-server/CLAUDE.md`.

## Security architecture

- **The Modal container is the security boundary**; no in-process capability
  stripping is relied on anywhere.
- **Every AssemblyAI key on the platform is user-provided**: there is no
  platform-owned provider credential, and no credential resolution may fall
  back to the host's `process.env`.
- The rest lives with the boundary: sandboxing, auth, `run_code` and the threat
  model in `packages/aai-server/CLAUDE.md`; guest capabilities, network access
  and SSRF (`aai/host/ssrf.ts`) in `packages/aai-guest/CLAUDE.md`; the `sdk/` vs
  `host/` boundary in `packages/aai/CLAUDE.md`; where the CLI may send a user's
  API key in `packages/aai-cli/CLAUDE.md`.

### Known limitations

- **Biome's promise rules cannot see a `node:` builtin**, so
  `pnpm lint:promises` (oxlint/tsgolint) holds `no-floating-promises` and
  `no-misused-promises`. A file is linted against its NEAREST `tsconfig.json`,
  which is why `scripts/tsconfig.json` exists (`packages/aai-gates/CLAUDE.md`).
- **Type-level tests cover little of the surface**: most subpath exports have
  no `.test-d.ts`, and each existing one pins only the shapes its fixtures use
  (two blind spots are in `packages/aai-templates/CLAUDE.md`).
  `hooks.test-d.ts` pins the deliberate `any`s (`DefaultToolResult`,
  `ToolCallInfo.args`): tightening one to `unknown` breaks untyped clients.

### Open testability work

`aai-studio-server` and `aai-cli` still write to `console.*`; route them
through a `Logger` as `aai-server` does (`logger.ts`, `captureLogs()`).
`guard-invariants` rule 34 baselines every `vi.mock`/`vi.doMock` — each marks a
unit with no seam for a fake; `pnpm debt:report` lists them.
