---
summary: >-
  The template gate specs in `aai-templates/src/`: API coverage and its
  allowlist, the durability and layout gates, `templates.test.ts`'s scaffold
  pins, prompt discovery, and what this package's tsconfig type-checks
read_when: >-
  editing a spec or helper in `packages/aai-templates/src/`, or a gate here
  fails after a template change
---

# packages/aai-templates/src — template gates

These specs hold every template in `templates/` and the `scaffold/` to their
contracts. The template-authoring rules they enforce are in
`packages/aai-templates/CLAUDE.md`.

## `template-api-coverage.test.ts` — every export has a worked example

Every public export must be exercised by a template or the scaffold, over a
scope DERIVED from the contract tree so it and `check:api-contracts` cannot
disagree about the authoring API. Its module doc has why. Exports with no
honest template use go in `template-api-allowlist.json` — e.g.
`defaultClientDir` (its only caller is framework code, `aai start`),
`TextAgentParams`/`PipelineAgentParams`/`S2sAgentParams` (union arms an author
never names), `isFfmpegError`/`FfmpegError`, `commandedBuiltins`,
`stubGateway`. An allowlist entry beats a contrived use.

**The last remover pays.** A cross-template migration moves coverage in a way
no single diff shows: when parallel changes each remove one of an export's
three uses, whoever lands LAST owes an allowlist entry or a retained example.
`EXEMPLARS-CLAUDE.md` at the package root lists who exercises what.

## `template-durability-gate.test.ts` — every workflow template runs durably

Every template with a `workflows/` directory must CALL `runWorkflow`
(`@alexkroman1/aai-runtime/testing`) in its own specs, in a
`describe("the run is DURABLE")` block asserting that template's own claim
(suspend, resume without redoing settled work, retry, signal, a worker dying
mid-step). The gate requires the call, not the import, so a leftover import
cannot satisfy it; both arms are A/B'd. Coverage alone would be satisfied by
one template.

Accepted limits: `call-audit-workflow`'s first step runs ffmpeg, which the test
environment lacks, so its block asserts a `FatalError` failing the run on one
attempt and says so. A whole-run spec cannot stub the gateway over
`globalThis.fetch` — compose `stubGatewayRoute` into one
`installStubStepFetch`, or use `stubTranscribe`'s `otherwise` where that fake
owns the slot.

## `template-layout-gate.test.ts` — where declarations live

A `workflow()` declaration goes where its importers can reach it: the six
`workflowApp()`s declare in `agent.ts`; `research-handoff-agent` and
`meeting-recap-agent` declare in `shared.ts`, because their tools import the def
and a tool importing `agent.ts` closes a cycle through `virtual:aai/agent`. A
session slot is declared in `shared.ts`. The module doc numbers each rule.

## `templates.test.ts` — pins that fail only on a user's machine

It asserts things whose failure makes a tool QUIETER, so nothing goes red on
its own:

- **The scaffold stays linted**: no negated scaffold glob in `biome.json`'s
  `files.includes`, and `packages/**` still present. The scaffold is the one
  tree that lands in someone else's project.
- **`scaffold/pnpm-workspace.yaml`** keeps `minimumReleaseAgeExclude:
  ["@alexkroman1/*"]` and the `onlyBuiltDependencies`/`allowBuilds` pair —
  pnpm ignores unknown keys silently.
- **The scaffold guide's voice catalog and SDK defaults** match the SDK in both
  directions.
- **Every template's prompt and tools resolve** through `_discovery.ts`, so an
  empty or orphaned `system-prompt.md` fails for every template at once.
  `_discovery.ts` reads the FILESYSTEM to decide which templates have a file:
  deriving that from the glob under test made breaking the glob change nothing.

Every assertion here should be A/B'd against the regression it guards (the
non-vacuity rule the gate specs carry).

## `tsconfig.json` decides what gets type-checked

A test file is imported by nothing, so tsc sees it only if `include` names it.
`include` names `src`, root `*.ts` and the template globs, so a new file is
covered on creation — keep it generic. `scaffold/` stays out: it is
`check:template-types`' (scaffold tsconfig, then again with
`exactOptionalPropertyTypes`; see `.agents/ratchets.md`), which also compiles
the excluded `templates/coding-agent/chat.ts`. Verify with
`tsc --noEmit --listFiles`, or by injecting a type error into a file you expect
covered.
