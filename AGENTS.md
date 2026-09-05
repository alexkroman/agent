# AGENTS.md

Guidance for coding agents (and humans) working in this repository.

The root `CLAUDE.md` is a one-line import of this file (`@AGENTS.md`) and
carries no content of its own — `AGENTS.md` is the name every other agent tool
looks for, so keeping the guide here means one canonical copy rather than a
per-tool set that drifts. Edit THIS file; never paste content into
`CLAUDE.md` (`check-claude-md.mjs` and
`packages/aai-templates/src/claude-md-limit.test.ts` both fail if you do — this
line used to cite an `agents-md-shim.test.ts` that has never existed in the
tree, which mattered because the parenthetical is the whole reason an author
believes the rule is checked). Package guides stay
named `CLAUDE.md`: Claude Code auto-loads a package's guide when you work in
that directory, which is the behaviour those files exist for, and
`konsistent.json` requires one per package.

## Overview

AAI is a voice agent development kit. Users define agents as directories
containing `agent.ts`. The CLI bundles and deploys them to the managed platform.

- **Platform**: `agent.ts` → CLI bundle → deploy to managed server

## Detailed references

**This file holds what is needed on EVERY task. Everything below is read on
demand.** The split is the one nitro uses, and it exists because a guide is
loaded into an agent's context in full: this file was 118,862 characters — 99%
of the 120,000-char cap — and every task paid for all of it before doing any
work. What moved is REFERENCE: the argument behind a gate, a convention's
history, the shape of a config. What stayed is what an agent has to know before
it can act at all.

Nothing was deleted. If a package guide cites a heading you cannot find here,
it is in one of these:

| Reference | Covers |
| --- | --- |
| [`.agents/ratchets.md`](.agents/ratchets.md) | Every gate beyond lint/typecheck/test: what each one checks, the failure it was written for, and the baseline or floor it carries. |
| [`.agents/testing.md`](.agents/testing.md) | Vitest conventions, harness declaration, snapshots, teardown, virtual time, coverage, the per-package configs, test env vars, and the property-test rules. The TIER table stays in AGENTS.md — it is needed on every task; this is the detail behind it. |
| [`.agents/ci.md`](.agents/ci.md) | The required check job, `pnpm check`, turbo strict env mode, task `inputs`, and the cache paths. Read before touching `turbo.json` or `.github/workflows/check.yml`. |
| [`.agents/dependencies.md`](.agents/dependencies.md) | The pnpm catalog, manifest shape and format checks, what a published manifest owes, the 24-hour release-age quarantine, action SHA pinning, and the artifact size budget. |
| [`.agents/releases.md`](.agents/releases.md) | The fixed release group, what arms a deploy, and how to write a changeset. |

Add to the reference that owns the surface, not to this file. The test for
which one a section belongs in is the one above: would an agent need it before
it could start work, or only once it is already in that area?

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
```

**Never type `turbo run <task>` across the workspace directly** — the six
fan-out scripts go through `node scripts/with-worker-budget.mjs turbo run …`,
because turbo's concurrency and each task's vitest pool are ONE mechanism and
only bound the machine when `TURBO_CONCURRENCY` is set. Unset, `pnpm test` ran
~40 processes on 4 cores and timed out `aai-cli`'s bundler specs on contention
alone. That script, `_turbo-concurrency.mjs` and `vitest.shared.ts` carry the rest;
a longer timeout is never the fix.

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

**A LIVE eval REPORTS and does not gate** — a measurably noisy instrument must
not block a merge. Runs repeat and the report carries a spread. What `pnpm check`
and CI do run is the same files with `AAI_EVAL_STUB=1`: a SCRIPTED model, so the
run is deterministic and free and what it gates is wiring, not behaviour (see
"A keyless run gets a SCRIPTED model" in `packages/aai-runtime/CLAUDE.md`).
`packages/aai-evals/CLAUDE.md` owns the live half.

They used to be separated by TIMEOUT, a proxy for the rule above that stops being
one as soon as two tests are slow for unrelated reasons. `pipeline-fuzz` (pure
memory) and `platform-schema` (needs a database) shared one tier, timeout, retry
policy and serial block, so neither was configured for its own failure mode — and
`pnpm test:integration` took **721 seconds to evaluate twelve tests**, 50 of 63
skipping for want of a database. It is 10 seconds now.

**Real NETWORK is the unit tier's boundary and lands a test in SCENARIO**, which
the table left implicit: the unit row forbade it and no other row claimed it.
`aai-runtime/agent-server.scenario.test.ts` is the worked case — two specs that
open a live voice session, so the runtime really dials the STT provider and is
really refused, and they had sat in the unit tier failing on any machine with
egress while passing wherever that connect fails fast. Note what the fix was NOT:
their assertions resolve promptly, and what overran the 5s budget was TEARDOWN
draining three provider connect attempts, so the tier is the answer and a longer
deadline is not. A test in that tier for network reasons alone needs no gate —
there is nothing to resolve and nothing to skip.

**Membership is a NAMING CONVENTION** — `*.integration.test.ts`,
`*.scenario.test.ts` and `*.eval.test.ts`, excluded by every unit config and
selected one each by the scripts, so a new test needs no config edit (see
"Integration- and scenario-tier membership" below for the deliberate exceptions).

**No tier carries a `retry`** — a tier that retries has classified its own
failures as noise; `vitest.slow.config.ts` carries the argument.

**Fifteen scenario suites need a real Postgres, and without one they SKIP** — a
silent skip being the worst outcome available, since that tier is the only thing
in the repo that can see a driver-level bug. `pnpm test:pg` resolves a local
database and runs the tier against it; a skip ANNOUNCES itself via
`describeWithPg` / `describeWithStack`; and `AAI_REQUIRE_PG` / `AAI_REQUIRE_STACK`
turn a skip into a hard failure, declared in the `check:scenario` task's `env` in
`turbo.json` because strict env mode would otherwise strip them and the
enforcement would silently do nothing. **`AAI_REQUIRE_STACK` is only exported
when a stack really resolved, so `scripts/with-test-pg.mjs --require-stack` is
what makes "no stack" a FAILURE** — without the flag every failure path (no
CLI, stack down, unparsable `supabase status -o env`) printed two lines and
exited 0, so `supabase start` succeeding while that output changes shape gave a
green platform-stack job in which `realtime-rls.scenario.test.ts`, the only
walrus/RLS leak test in the repository, never ran. CI passes the flag; `pnpm
test:pg` deliberately does not, because a developer on a plain 5432 is entitled
to the narrow arm with a printed reason. **`AAI_REQUIRE_REGISTRY` is the same shape
one tier up**, in `check:e2e`'s `env` — see `packages/aai-cli/CLAUDE.md`. The
whole gate, including the vitest collection trap that makes `pgUrl()` illegal at
the top of a gated `describe` body, is in `packages/aai-server/CLAUDE.md`,
"Gating a suite on a real Postgres".

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

Ten workspace packages under `packages/`:

| Package | npm name | Purpose |
| --- | --- | --- |
| `packages/aai/` | `@alexkroman1/aai` | Shared core: agent config, types, protocol, S2S, session, Db |
| `packages/aai-ui/` | `@alexkroman1/aai-ui` | Browser client (React 19): session, audio, UI components |
| `packages/aai-runtime/` | `@alexkroman1/aai-runtime` | The HOST runtime: `createRuntime`/`createAgentServer`, the session core, transports, provider openers, the workflow API. What runs an `agent.ts`; an `agent.ts` imports none of it |
| `packages/aai-cli/` | `@alexkroman1/aai-cli` | The `aai` CLI: init, dev, test, eval, build, list, pull, push, publish, delete, login, secret, logs, workflow, templates (`deploy` is hidden/internal — the mechanism in-guest Publish runs). The list is PINNED to the registry in `cli.test.ts` — it named a removed `storage` for several releases |
| `packages/aai-guest/` | `aai-guest` | Guest sandbox harness (private): the Node entrypoint that runs the complete agent inside each Modal Sandbox, built into one self-contained `dist/harness.mjs` |
| `packages/aai-server/` | `aai-server` | Agent service + shared platform core (private): sandbox, auth, SSRF, stores, locks |
| `packages/aai-studio-server/` | `aai-studio-server` | Studio service (private): browser coding agent, workspace builds. Also the composition root — its entry is the one every deployment runs |
| `packages/aai-studio-client/` | `aai-studio-client` | The studio's browser front-end (private): Vite React app served by aai-server |
| `packages/aai-templates/` | `aai-templates` | Agent templates + scaffold (private): starter templates |
| `packages/aai-evals/` | `aai-evals` | Behaviour eval tier (private): the runner, its assertion vocabulary over the session event stream, and its targets |

**Dependency flow:** every other package depends on `@alexkroman1/aai` (via
`workspace:*`), and `aai-runtime` sits one layer above it — the CLI, the guest,
the server and the evals all take the host runtime from there, while
`aai-runtime` imports only `aai`. `aai-server` depends on
`aai-guest` only to resolve its built artifact (`aai-guest/harness` →
`dist/harness.mjs`, baked into the guest snapshot image) — it never imports
guest source, and the guest never imports server code; that hard boundary is
the reason the guest is its own package. The one edge to the CLI is
`aai-guest` → `aai-cli`, and only for its four public subpaths: the three
build hooks (`/worker-bundler`, `/client-bundler`, `/typecheck`), because the
studio builds workspaces through the CLI's own Vite pipeline and typechecks
them with the CLI's own gate rather than carrying a second bundler, plus
`/project-config`, because Publish materializes a project the CLI then parses
and the writers for those two files belong to the CLI. Do not widen it —
nothing else may import from the CLI, and the CLI must never import from the
server or the guest.

Two edges sit outside that spine. `aai-studio-server` → `aai-server` is the
repo's LARGEST: 158 import sites across all 36 of that package's subpath
exports, and not one bare `aai-server` specifier — which is why a boundary rule
naming the bare name matched nothing for as long as it existed (konsistent's
matcher is exact unless the pattern ends `/*`). And `aai-evals` →
`aai-studio-client/starters`, its only workspace edge beyond the SDK.

**Publishable packages must use the `@alexkroman1/` scope.** The unscoped
names `aai`, `aai-ui`, `aai-cli` are taken on npm by other publishers —
publishing under those names returns 404. The `scripts/check-publish-names.mjs`
script enforces this at CI time.

### Package guides

**This file holds only what is repo-wide.** Everything package-specific lives
in that package's own `CLAUDE.md`, which Claude Code loads when you work in
that directory — go there first, and put new package-specific rules there
rather than here:

| Guide | Covers |
| --- | --- |
| `packages/aai/CLAUDE.md` | SDK layout (`sdk/` vs `host/`), subpath exports, session modes, STT/LLM/TTS/S2S providers, voices, `ctx.generate`, what persistence a tool gets, the concurrency primitives, session slots, the canonical agent-config schema, data flow, the defaults/magic-numbers table |
| `packages/aai-ui/CLAUDE.md` | Browser session, client audio path (capture/playback worklets, pacing, jitter buffer), components, fuzz harnesses, **workflow apps** (`mountPage()`, `createWorkflowApi`, `useWorkflowRun`, and the workflow HTTP API the SDK serves) |
| `packages/aai-cli/CLAUDE.md` | Subcommands, the studio round-trip (`push`/`pull`/`publish`/`delete`), bundling + Vite rules, credential destinations, `aai dev`'s server and host mode, self-hosting (`npm start`) |
| `packages/aai-runtime/CLAUDE.md` | The host runtime: why it is its own package, the one-way dependency on the SDK, the fifteen `host/` modules that stayed, and the `host-internal` seam |
| `packages/aai-guest/CLAUDE.md` | The guest harness: one binary / three modes, user-shipped runtime, dev-prod parity, agent guests as servers, guest network access + SSRF, credential separation |
| `packages/aai-server/CLAUDE.md` | Platform: sandboxes + Modal backends, stateless server, security architecture, auth, telephony, durable-workflow routes, stores/locks |
| `packages/aai-studio-server/CLAUDE.md` | Browser studio: workspaces, coding agent, previews, Publish, LLM selection, studio evals, the two-package/one-deployment composition |
| `packages/aai-studio-client/CLAUDE.md` | Studio front-end: panes, composer queue, CSP, preview probing |
| `packages/aai-templates/CLAUDE.md` | Templates + scaffold packaging. Note `scaffold/CLAUDE.md` is a product artifact, not repo docs |
| `packages/aai-evals/CLAUDE.md` | Eval tier: recorded assertions, the spread report, why it does not gate, the two levels |

One guide sits outside `packages/`: [`docs/CLAUDE.md`](docs/CLAUDE.md), for the
`aai-docs` workspace — both TypeDoc renderings, the committed markdown
reference, and the `typescript@6` pin — **and, because they answer three
versions of one question, the API REPORTS and the capability EPOCHS as well.**
See "The published surface is described by three committed artifacts".

Three files sit outside the table for a different reason:
`packages/aai-server/MODAL-CLAUDE.md`, `packages/aai-server/SCHEMA-CLAUDE.md`
and `packages/aai-runtime/JOURNAL-CLAUDE.md`, SIBLINGS of their package's guide
rather than second package guides. `check:claude-md` measures it (its pathspec is
`*CLAUDE.md`) and konsistent permits it (`workspace-package-layout` requires a
`CLAUDE.md` and forbids nothing else), but Claude Code auto-loads only
`CLAUDE.md`, so a sibling is read on demand and is only the right shape for
REFERENCE — a build recipe — never for a rule someone needs resident. Prefer
moving a section to the package that owns the surface; reach for a sibling when
no other package owns it and the guide is at the cap.

### A guide says what to do in code that EXISTS

There used to be a `research/` directory for issue-backed plans — a design doc
for a change that did not exist yet — kept out of the guides because a guide is
loaded into an agent's context on every task and everything in it competes for
that budget. It is gone, along with the rule 10 that checked its frontmatter,
and the half of the split worth keeping is the one that survives it: a guide
documents code that exists. A design for a change nobody has made yet belongs on
the issue that owns it, not in a file an agent reads while working on something
else — that habit is directly how the root guide reached 233,000 characters. When
a plan ships, the rule it establishes lands in the owning package's guide as a
few lines.

## Conventions

- **Runtime**: Node everywhere (host, platform server, and guest sandbox)
- **Frameworks**: React (client UI), Tailwind CSS v4 (compiled at bundle time)
- **Linting**: Biome. Auto-runs on staged files via lefthook pre-commit hook.
  **Every package needs a `lint` script** (`biome check .`) or `turbo run
  lint` — and so `pnpm check` — silently skips it; `aai-templates` had none.
  Filename conventions are Biome's job too (`useFilenamingConvention`,
  kebab-case), which replaced a never-invoked `ls-lint` whose config existed
  but which no pipeline ran and which blocked for 30+ minutes at repo root.
  A `tools/` file is exempted by an override: its name mirrors the
  snake_case LLM tool name.

  **`^2.5.12` is a FLOOR, and biome is the one dependency exempt from the
  release-age quarantine** — argued at `minimumReleaseAgeExclude` in
  `pnpm-workspace.yaml`. 2.5.9-2.5.11 report an already-awaited
  `await pTimeout(…)` as floating, costing nine suppressions; 2.5.12 also
  retires the one this cost at 2.5.8. Do not lower the floor.

- **Exports**: every entry carries BOTH conditions — `@dev/source` naming
  `./src/…` and `types`/`import` naming `./dist/…`. There is no pre-publish
  rewrite: a consumer without `customConditions` resolves to `dist`.

### Package layout

**Every package is `src/` plus its configs.** Source — `.ts`, `.tsx`, tests,
fixtures, snapshots, the capability contracts — lives in `packages/<pkg>/src/`;
the manifests, tsconfigs, tool configs, guides, `etc/` (the API reports) and
static assets (`index.html`, `public/`, `aai-ui`'s published `styles.css`,
`aai`'s `skills/`) stay at the package root. `aai-templates` keeps `templates/`
and `scaffold/` there too: that TypeScript is a shipped product authored FOR a
user's project, checked under the SCAFFOLD's tsconfig by
`check:template-types`, not source this package builds.

`tsconfig.build.json` therefore sets `rootDir: "src"` and `include: ["src"]`,
which keeps a repo artifact out of `dist/` by construction rather than by an
`exclude` list somebody keeps current — `aai-ui` shipped the frozen contract
examples that way. **The emitted layout is unchanged**: with every entry under
`src/`, tsdown and tsc both take it as the common root, so `dist/index.js` and
`dist/sdk/protocol.d.ts` are where they were and no published `exports` target
moved — only `@dev/source` names `src/`. Enforced by `check:package-layout`,
not konsistent: `paths` is a discovery glob, so a package that lost its `src/`
would match nothing and pass.

### File naming conventions

| Pattern | Meaning | Example |
| --- | --- | --- |
| `_foo.ts` | **Internal module** — not part of the public API. Never import cross-package. Biome's `noPrivateImports` rule enforces this at lint time. | `_utils.ts`, `_bundler.ts`, `_internal-types.ts` |
| `foo-barrel.ts` | **Barrel re-export file** — aggregates exports from multiple modules into one subpath export. Has `biome-ignore` for `noReExportAll`. | `runtime-barrel.ts`, `manifest-barrel.ts` |
| `foo.test.ts` | **Unit test** — co-located with source. Runs via `pnpm test`. | `session.test.ts` |
| `foo.test-d.ts` | **Type-level test** — checked by tsc, never executed at runtime. Uses `expectTypeOf`. | `types.test-d.ts` |
| `_test-utils.ts` | **Test helpers** — each package has its own with different utilities (see below). | `host/_test-utils.ts` |

### `_test-utils.ts` per package (not interchangeable)

Each package's helper module is its own, named for that package's domain, and a
spec reaches for the one beside it rather than importing another package's. The
paths and the roster each module owes are the **`test-helper-modules`**
konsistent convention now — a hand-kept copy lived here and had gone stale in
four places (`flush()` had moved packages, `sleep()` was never a test helper at
all, and the largest module in the repo was missing from the list). The
published pair, `@alexkroman1/aai/testing` and `/testing/vitest`, is
**`published-testing-split`**: anything that INSTALLS or RESTORES is
`/testing/vitest`, and `testing.ts` may not import `vitest` at all.
`packages/aai/CLAUDE.md`'s subpath table carries the inventory and the argument.

### `@dev/source` custom export condition

Package.json exports use a custom `@dev/source` condition so that
TypeScript source (`.ts`) is resolved during development, while compiled
`.js` dist paths are used in production:

```jsonc
// package.json
"exports": {
  ".": {
    "@dev/source": "./index.ts",     // ← resolved in dev (via tsconfig)
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"      // ← resolved in production
  }
}
```

This is enabled by `customConditions: ["@dev/source"]` in the root
`tsconfig.json`. During dev, imports like `import { X } from "@alexkroman1/aai"`
resolve directly to `.ts` source — no build step needed.

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

**Eight names are published by two packages at once.** Settle any claim here
against `API-EXPORTS.json` — it records the SUBPATH each name comes from, which
is the whole question. Seven are on `aai` and `aai-ui`, each a re-export of the
single `aai` declaration — one concept with two reference pages, not a
collision: `ClientConfigResponse` and `SessionErrorCode` (`/protocol`; the
latter's union is eight wire codes), plus `WorkflowApi`, `WorkflowSummary`,
`WorkflowOutputOf`, `WorkflowRunStatus` and `isTerminal` (`/workflow-api`).

**No real COLLISION is left, and the last one is worth remembering.** It was
`SessionCore` — one word for the two sides of one wire, neither reference page
naming the other, and both halves declared in a file called
`session-core-types.ts`:

| Name | `aai-runtime` (root) | `aai-ui` (root) |
| --- | --- | --- |
| `SessionCore` (was) | the SERVER session, bridging a `Transport` to the client protocol — now `ServerSession` | the BROWSER session (socket + audio + state) — now `BrowserSession` |

That is the shape to watch for rather than the outcome: two packages naming the
same concept from opposite ends, so the word is right in each file and useless
in an autocomplete list spanning both. Each name says which side of the wire it
is now, and neither reader has to know which package they landed in.

The table carried four rows before that; what the `/internal` split resolved,
and why renaming the runtime halves was affordable at all, is in
`packages/aai-runtime/CLAUDE.md`.

The near-miss an AUTHOR meets is three workflow-client factories, none of them a
collision; `packages/aai-ui/CLAUDE.md` tells them apart.

### Concurrency primitives (use these, don't hand-roll)

The repo's recurring async-coordination patterns are reified as small
primitives. **The catalogue — every primitive, its home module and the argument
for it — is the `concurrency-primitives` konsistent convention**, which pins
each one's location so the roster cannot go stale, plus
`packages/aai/CLAUDE.md`, "Concurrency primitives". Go there before
re-inventing one at a call site; `guard-invariants` rules 2, 3, 4, 19, 21, 22,
23 and 31 are what catch a hand-rolled copy in a function body.

Two are repo-wide rather than this SDK's, and stay here:

- **Timeouts**: use `p-timeout` (a dependency of aai, aai-cli, aai-guest,
  and aai-server) — never a hand-rolled `Promise.race` with a timer; the
  losing branch's late rejection and timer cleanup are exactly what gets
  re-derived wrong. The guest harness is no exception: tsdown bundles its
  npm dependencies (p-timeout included) into `dist/harness.mjs` — only the
  vite/rolldown build toolchain stays external to the bundle.
- **Combining abort signals**: use native `AbortSignal.any([...])` (sources
  held weakly — no unlink bookkeeping); the pipeline transport combines the
  session signal with each turn's controller this way.

### The published surface is described by three committed artifacts

Three generated, committed descriptions of what the four publishable packages
expose, each with its own gate, and **all three are documented together in
[`docs/CLAUDE.md`](docs/CLAUDE.md)** — they answer three different questions
about one surface and used to be argued in three places:

| Artifact | Gate | Question it answers |
| --- | --- | --- |
| `packages/*/etc/*.api.md`, `API.md`, `API-EXPORTS.json` | `pnpm check:api-report` | did a SIGNATURE move, and is a name in or out |
| `contracts/epochs/<capability>/v<N>.json` + `contracts/compatibility/**` | `pnpm check:api-contracts` | is that move BREAKING, and for whom |
| `docs/api/**`, `docs/dist/**` | `pnpm check:docs-md`, the turbo `docs` task | what does it MEAN (the doc comments) |

Four things a change to a published package owes, without reading further:

- **Regenerate rather than hand-edit** — `pnpm api-report`, `pnpm docs:md`. All
  three trees are derived, and all three gates fail on a stale one.
- **A capability whose shape moved has to be CLASSIFIED before it can land**:
  `node scripts/api-contracts.mjs --bump <pkg>:<capability> --retain` (epoch N
  still compiles) or `--drop "<reason>"`. Run `pnpm typecheck` FIRST — the
  frozen examples it reddens are the older epochs to drop. Names are qualified
  per package (`aai-ui:workflow`), and ambiguity is REFUSED, never resolved by
  precedence.
- **A new subpath export defaults INTO all three** — each is a deny-list, so it
  fails until somebody writes down why it should be out.
- **A `--bump` is the moment to ask what should come OUT.** Read
  `template-api-allowlist.json` at one: it records the exports no shipped
  example exercises, and a bump only ever asks about the names that MOVED.

**The rest is in [`docs/CLAUDE.md`](docs/CLAUDE.md)**, including what a new
CONTRACT package owes. This section used to be two, "Published type signatures
are a committed report" and "The authoring surface is versioned in epochs" —
the titles three package guides still cite as living in the root; both are
there under those same headings, with the `@internal`-surface ratchet, the six
load-bearing properties of an epoch, why capabilities rather than entry points,
and the two mechanical notes.

### The authoring guide ships inside the SDK

`scaffold/CLAUDE.md` is the one source of truth for how to write an aai agent,
and `scripts/sync-agent-guide.mjs` materializes it as
`packages/aai/AGENT_GUIDE.md` so it ships in the `aai` tarball and cannot
describe a different release than the SDK beside it. It is a REPO-LEVEL script
rather than a build step in `aai`, because `aai` may import no sibling package
and a build step reading from `aai-templates` would invert that;
`check:agent-guide` keeps the copy honest. See "The authoring guide ships inside
the SDK" in `packages/aai-templates/CLAUDE.md` for the drift it prevents and why
the shipped SKILL carries no API guidance of its own.

### API reference docs

The third artifact of the three above: two renderings of the published type
surface, both from TypeDoc over the built `dist/*.d.ts` of `aai` and `aai-ui`
(only those two, deliberately). `pnpm docs:api` renders `docs/dist/**` as HTML
for GitHub Pages; `pnpm docs:md` renders `docs/api/**` as **committed**
markdown, so an agent can `cat` the API reference instead of a rendered site,
and `pnpm check:docs-md` fails when it is stale.

**All of it is in [`docs/CLAUDE.md`](docs/CLAUDE.md)** — the two commands and
what gates each, the `@module`/entry-point rule a new subpath export owes, the
five load-bearing options in `typedoc.markdown.json`, why the markdown
rendering is committed and floored, why `aai-cli` and `aai-runtime` are
deliberately absent, why `docs/` pins its own `typescript@6`, and why knip has
to be told about the second config. `pnpm check:doc-examples` — every
```` ```ts ```` fence in published-package doc comments, READMEs, the scaffold
guide and the studio prompts compiles under the scaffold tsconfig — is
documented there too.

### Git hooks (lefthook)

- **pre-commit**: runs `biome check --write` on staged files (via
  `scripts/pre-commit-format.mjs`) and `syncpack lint` when package.json
  changes.

  **A PARTIALLY-staged file is skipped, and that is the whole reason the script
  exists** (from vercel/eve's `pre-commit-fmt.mjs`). The hook was
  `biome check --write {staged_files} && git add {staged_files}`. Biome rewrites
  the WORKING TREE file, so on a file with some hunks staged and the rest not,
  that `git add` staged the whole thing and the author's unstaged work went into
  a commit they never chose — reproduced on a scratch repo, one staged and one
  unstaged line, and the unstaged line was in the index afterwards. It is
  silent, and `git add -p` / `git commit -p` are exactly the workflows that
  produce it. Skipping is the conservative half: an unformatted file fails CI
  loudly, where the alternative rewrites a commit nobody can see. The skip is
  ANNOUNCED — a silent one reads as "biome found nothing".
- **pre-push**: blocks pushes to main/master, **blocks pushes when branch
  is behind origin/main** (must rebase first), checks for merge conflicts
  with main, **verifies changeset exists for changed packages**, and runs
  `pnpm check`.

### Worktree gotchas

- Run `unset GIT_DIR` before `pnpm changeset status` in worktrees
  (lefthook sets GIT_DIR which confuses changeset's repo detection).
- Always use `pnpm install --frozen-lockfile` in worktrees to avoid
  modifying the lockfile. Fall back to `pnpm install` only if frozen
  fails (new deps added on the branch).
- Never edit `pnpm-lock.yaml` directly — always use `pnpm install`.

### Updating AGENTS.md

When you make changes that affect architecture, security model, conventions,
or gotchas, update the guide that OWNS the surface — the package's own
`CLAUDE.md` (see "Package guides" above) for anything package-specific, this
file only for repo-wide rules. Adding to the root instead of the package guide
is how this file grew to 233k characters and had to be split.

**There are now three places a repo-wide rule can go, and the question is when
it is needed rather than what it is about.** This file is loaded into every
task's context before any work starts, so what belongs here is what an agent
must know to act at all: the tier table, the package map, the naming and import
conventions, the workflow. What belongs in `.agents/` (see "Detailed
references") is everything read once you are already in an area — the argument
behind a gate, a config's shape, a convention's history. And a rule that can be
MECHANICAL belongs in neither.

The split is not cosmetic. This file was 118,862 characters against a
120,000-char cap, so every task in the repo paid ~30k tokens of context before
reading a line of code, and the next well-justified paragraph had nowhere to
go. It is 38k now. When a reference file approaches the cap in turn, split it
the same way rather than moving anything back.

**The root guide is `AGENTS.md`, and `CLAUDE.md` is one line: `@AGENTS.md`** —
the two-name split and why it exists are in this file's opening paragraph.
Every guide must stay under 120,000 characters (`check:claude-md`, and
`claude-md-limit.test.ts`; see `.agents/ratchets.md`), the scaffold's
included — and that cap covers `.agents/` too —
that one is exempt from the "repo docs" rule, being a product artifact shipped
to users, but not from the cap.

**And a rule that belongs in a GUARD does not belong here.** Most of what
follows in this file is a rule with a story attached, and a story is only
enforcement when a reviewer remembers it. `scripts/guard-invariants.mjs` is
where the mechanically-checkable half lives — see `.agents/ratchets.md`.
Before
adding a paragraph that says "always X" or "never Y", check whether it can be
a numbered rule there instead; prose is the fallback, not the default.

## PR workflow

**Default:** When finishing a development branch, always push and create a
Pull Request (don't ask — just do it).

**Before pushing**, rebase on the latest `main` to avoid merge conflicts:

```sh
git fetch origin main
git rebase origin/main
```

The pre-push hook will automatically check for conflicts with `main` and
block the push if any are found. This prevents PRs from being opened with
merge conflicts.

Run `pnpm check:local` **before your first commit** on a PR branch. This
catches the most common issues that historically required follow-up commits:

1. **Syncpack version drift**: When bumping a dependency, also update
   `packages/aai-templates/scaffold/package.json` if it has the same dep.
   Note syncpack does NOT check the scaffold (it is excluded in
   `.syncpackrc.json`) — run `pnpm sync:scaffold` to sync it. `check:scaffold`
   now fails when it is stale, so this is a fix rather than something to
   remember; the same bump usually also owes `pnpm sync:guest-toolchain`, which
   `check:guest-toolchain` holds the same way.
2. **Test assertion mismatches**: After changing output formats or error
   messages, run `pnpm test` and update affected assertions.
3. **Lint in related files**: Pre-commit only lints staged files. Run
   `pnpm lint` to catch lint issues in files affected by your change.
4. **Type-level tests**: After changing public API types (`toAgentConfig`,
   `AgentConfig`, etc.), run `pnpm vitest run --project aai-types`
   to verify type contracts haven't regressed. Update `.test-d.ts` files
   if the change is intentional.
5. **Dependencies orphaned by a deletion**: removing the last consumer of a
   package leaves the `devDependencies` entry and its lockfile tree behind.
   `pnpm check:knip` catches this and is in the local subset for that
   reason — it's the one failure you won't notice while working, because
   deleting code puts your attention on what goes away, not on what the
   removal strands. When a PR deletes a directory, expect a dependency to
   come out with it.

   **It also reports unused EXPORTS, and the setting that makes that useful
   is `includeEntryExports` — set on the private packages only.** With it on,
   knip reports a file's exports even when the file is an entry point; that is
   right where every importer lives in this repo, and wrong for `aai`,
   `aai-ui`, and `aai-cli`, whose entry exports are the published API and
   whose consumers (templates, user projects) knip cannot see. Reporting those
   is what produced the 174-finding run that kept the whole check switched off
   for so long. The published packages still get the check for everything
   *not* reachable from a subpath export — an internal helper whose last
   caller went away, which is the case worth catching. `types` stays excluded
   pending an `@internal` tagging pass.

## A new guest route must declare how the PLATFORM exposes it

`aai dev` serves the guest's own routes directly, so a feature is developed
against a server where the guest's dispatch table is the whole API; deployed,
almost nothing works that way, and it has landed twice. The two declarations
that close it are pinned by the **`guest-route-exposure`** konsistent
convention, whose description carries the argument. **See "A new guest route
must declare how the PLATFORM exposes it" in `packages/aai-server/CLAUDE.md`**
for the four exposure kinds, which half is a test and which is
`guard-invariants` rule 12, and why exposure is decided by who CALLS a route.

## Security architecture

The security model is documented where the boundaries live:

- **Sandbox isolation, credential separation, auth, `run_code`, the platform's
  own threat model** — `packages/aai-server/CLAUDE.md`.
- **What a guest may do, what the harness contract exposes, guest network
  access + SSRF (`aai/host/ssrf.ts` is the implementation), and credential
  separation** — `packages/aai-guest/CLAUDE.md`.
- **The `sdk/` vs `host/` dependency boundary** — `packages/aai/CLAUDE.md`.
- **Where the CLI is allowed to send a user's API key** —
  `packages/aai-cli/CLAUDE.md`.

Two rules general enough to state here: **the Modal container is the security
boundary** (no in-process capability stripping is relied on anywhere), and
**every AssemblyAI key on the platform is user-provided** — there is no
platform-owned provider credential, and no credential resolution path may fall
back to the host's `process.env`.

### Known limitations

- **Biome's promise rules cannot see a `node:` builtin**, and typescript-eslint
  cannot close it — `typescript@7` ships no compiler API. `guard-invariants`
  rule 23 covers the listener half; the measurements are in
  `packages/aai-templates/CLAUDE.md`.
- **Type-level tests**: six `.test-d.ts` files — four in `aai`
  (`sdk/define.test-d.ts`, `sdk/env-types.test-d.ts`, `sdk/dialog.test-d.ts`,
  `sdk/workflow-types.test-d.ts`), one in `aai-ui` (`hooks.test-d.ts` — the four
  generic hooks a custom client is written against) and one in `aai-runtime`
  (`providers/providers.test-d.ts`). Most subpath exports are still uncovered,
  and **the two newest files each have a blind spot a template hit on day 1**:
  each pins only the shape its own fixtures use — see "A `sendFrom` goes BELOW
  `execute`" and "A body that names `WorkflowInputOf` obliges the DEF to carry a
  type" in `packages/aai-templates/CLAUDE.md`. (Their RUNTIME export
  lists are pinned — see `sdk/exports.test.ts` — which is a different
  guarantee.) `hooks.test-d.ts` pins the deliberate
  `any`s (`DefaultToolResult`, `ToolCallInfo.args`) as well as the shapes,
  because tightening one to `unknown` is a breaking change for every untyped
  client and should fail here rather than in a user's build.

### Open testability work

The `aai-server` logger seam once named here is DONE — every line in that
package goes through `logger.ts`, silenced in specs by `captureLogs()` rather
than `spyOn(console, …)` (see "Every line goes through `logger.ts`" in
`packages/aai-server/CLAUDE.md`). What remains is the same job elsewhere:
`aai-studio-server` and `aai-cli` still write to `console.*` in places, and the
SDK publishes a `Logger` either could take.
