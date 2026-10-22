---
summary: >-
  aai-runtime's capabilities and epochs: how a signature change is classified,
  when a capability splits, and the frozen compatibility templates
read_when: >-
  changing a public signature of aai-runtime, adding a capability, or editing
  anything under `src/contracts/`
---

# aai-runtime contracts

## The published surface is versioned in epochs

Each capability under `contracts/entrypoints/` is a named slice of what an
embedder writes against (read the tree for the list — never restate it). The
mechanism is the repo's: see "The authoring surface is versioned in epochs" in
[`docs/CLAUDE.md`](../../../../docs/CLAUDE.md), which owns the reports, the
epochs and the renderings. Here it means a signature change on a contracted name
is CLASSIFIED — passed unrecorded when the probe proves it compatible, else
`--bump aai-runtime:<capability> --drop "<reason>"` or `--retain` — rather than
discovered by whoever's build breaks.

- **A new feature gets its own capability**, and its own subpath when a
  different reader imports it. Adding a feature to an existing capability makes
  every change to it an epoch of that capability; that is why `auth`, `metrics`,
  `eval-simulate` and `eval-assert` are separate.
- **The eval family is cut by what MOVES together**: `eval-assert` is every pure
  reader and claim plus the `EvalTurn`/`EvalToolCall` records (stable); `eval`
  the drivers, their options and records, and the runtime's OWN stubs
  (`installStubLlm`, the stub openers, `createVmRunCode`) — a mirror may hold
  only the SDK's names; `eval-network`, `eval-phone-tree`, `eval-simulate` one
  young feature each.
- **A capability whose last consumer goes is deleted, not emptied**: remove its
  entry point, its `epochs/<cap>/` and its `contracts.json` entry, and move the
  names to `/internal` if anything still imports them (`keys` went this way — no
  published signature took a key store).
- `tools` (one name, `withToolsDir`) is its own capability because it assembles
  the DEFINITION a runtime is handed, not any part of the engine.
- **A capability is not a subpath.** The two testing doors re-export across
  capabilities: `/testing` carries `testing` (the workflow and text drivers),
  `eval-stubs` and `testing-stubs`; `/testing/vitest` carries every eval
  capability — `eval`, `eval-assert`, `eval-network`, `eval-simulate`,
  `eval-stubs` — plus `testing-stubs`' installers, as `/eval/vitest` carries the
  eval ones. `eval-stubs` and `testing-stubs` are the SDK's `aai:testing` names
  re-exported here (the first the stubs an eval composes with, the second the
  rest). **They are MIRRORS** (`{ "mirrors": "aai:testing" }` in
  `contracts.json`): no epoch of their own, so an SDK change is classified once,
  on `aai:testing`. The check holds each to pure re-exports of names
  `aai:testing` contracts today, and refuses dropping a name the SDK still
  exports — that would be this package's break with no epoch to record it
  (`scripts/_api-contracts-mirror.mjs`). A helper added to the SDK still needs a
  line in the door's barrel and in the mirror's entry point.
- **Shape debt is baselined in `api-shape-baseline.json`** (`check:api-shape`,
  `docs/CLAUDE.md`). A non-authoring SDK name in a contracted signature is
  either re-declared here (`Db`, `RunCodeExecutor`), spelled inline
  (`EvalWorkflowsOptions.stepFetch`/`speech`) or dropped; `AgentEnv` and
  `ProviderEnv` stay baselined, because a copy here would not carry the SDK's
  host-credential marker and would let a `HostCredentialEnv` into `ctx.env`.
- **A handle passed back in is `@sealed` and reached both ways** (`Runtime`,
  `WorkflowJournal`, `SessionEventStream`): `check:api-shape` reads that as a
  round trip and passes it. An implementer interface (the opener contract,
  `CarrierCodec`) is reached both ways too, and its `positions` entry is the
  cost of the shape, not debt to tag away.
- Which barrel a name goes on, and the `@internal` rules, are in the package
  guide, "The published surface: two barrels and a rule between them".

## Compatibility templates

**A RETAINED epoch owes a frozen, compiling TEMPLATE** at
`compatibility/<capability>/v<N>.ts`, and `pnpm typecheck` enforces it. Read the
tree for which exist.

- **Never edit a frozen template to make an error go away** — the error IS the
  finding. An API changes by a new epoch carrying a new template.
- **A template, not an example.** This package's consumers embed it (a host, a
  carrier codec, a state backend), so each file is a starter they COPY: composed
  front to back, edit points marked, no design commentary.
- **A template need not exercise every contracted name.** The epoch hash covers
  the capability's whole REPORT, so every name is classification-covered; only
  compile-time exercise is per name. Deliberately absent:
  `createServerForRuntime` / `createHostServer` (a different artifact from the
  bootstrap) and `telnyxCodec` / `twilioCodec` (a third-carrier template is the
  alternative to them). Do not contort a starter into a catalogue.
- What writing the templates found (types whose constructor is `@internal`,
  `WdkAdapter`'s nine methods, `TextTurnResult` and upstream minors) is in
  [`docs/CLAUDE.md`](../../../../docs/CLAUDE.md), "`aai-runtime` contract
  hazards".
