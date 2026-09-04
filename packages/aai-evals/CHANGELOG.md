# aai-evals

## 0.1.36

### Patch Changes

- Updated dependencies [f9c1a98]
- Updated dependencies [8dc4cbb]
  - @alexkroman1/aai@15.0.0

## 0.1.35

### Patch Changes

- 79e3ea6: Collapse the eval tier's duplicated seams, and make the starter grader reachable by a unit test.
  
  The "blank counts as unset" env rule was spelled five times in three different semantics — including inside `envValue`, whose own doc warns that "a rule spelled out twice is one that can come to be spelled differently". It is one `_env.ts` now (`envValue` / `envFlag` / `envInt`), and `_gate.ts` keeps only the policy. `AAI_STEP_CAP_HINT` moved there too: it was `Number(process.env.X ?? 80)` in an eval file, so a blank value yielded `NaN` and every step-cap comparison answered false, reporting the agent as having run away.
  
  `gradeStarter` — which decides which checks exist, under what label, and holds the failure taxonomy — sat in `starter.eval.test.ts`, a file `vitest.config.ts` excludes, so every function it calls was unit-tested while the thing calling them was not. That matters because the labels are the keys `EvalReport.unstable` reports and `AAI_EVAL_ONLY` matches. It is `starter-grade.ts` with its own tests. The move also proved a rule worth writing down: `_gate.ts` resolves a key and announces at import time, so nothing the unit tier loads may import it.
  
  Also: `condense` was two identical bodies with different caps and `report.ts` owns it now; `failedScope`'s fourteen arms were a second copy of the vocabulary's label spellings and had already drifted, so they come from the real scope over zero events; `toolNames` / `describeToolCalls` / `responseErrorMessage` / `safeJsonParse` replace hand-rolled equivalents, and the first two render a tool call that never completed as such; `formatSpread` takes a spread rather than a report, so latency prints its range instead of a bare mean; `checkMode`'s `source` half produced two notes a passing check discards; `ContractRun`'s two booleans became a three-state `outcome`; `StudioTurn.ms` was written and never read; a contract run's child output was retained unbounded to report 800 characters of it; and the workspace materialization writes in parallel.
- Updated dependencies [b5beca2]
- Updated dependencies [79e3ea6]
- Updated dependencies [a9c1577]
- Updated dependencies [292ae33]
- Updated dependencies [292ae33]
- Updated dependencies [79e3ea6]
- Updated dependencies [292ae33]
- Updated dependencies [a9c1577]
- Updated dependencies [ef096bb]
  - @alexkroman1/aai@14.0.0

## 0.1.34

### Patch Changes

- @alexkroman1/aai@13.3.0

## 0.1.33

### Patch Changes

- Updated dependencies [4fb6b05]
  - @alexkroman1/aai@13.2.0

## 0.1.32

### Patch Changes

- @alexkroman1/aai@13.1.0

## 0.1.31

### Patch Changes

- Updated dependencies [9e12bb2]
- Updated dependencies [9e12bb2]
- Updated dependencies [9584e2e]
- Updated dependencies [9584e2e]
  - @alexkroman1/aai@13.0.0

## 0.1.30

### Patch Changes

- @alexkroman1/aai@12.0.0

## 0.1.29

### Patch Changes

- Updated dependencies [36a3f22]
- Updated dependencies [0718b57]
- Updated dependencies [fe3b6d6]
- Updated dependencies [63e1c8e]
- Updated dependencies [36a3f22]
- Updated dependencies [f10b6aa]
- Updated dependencies [7ab47cf]
- Updated dependencies [31459e8]
  - @alexkroman1/aai@11.0.0

## 0.1.28

### Patch Changes

- @alexkroman1/aai@10.0.1

## 0.1.27

### Patch Changes

- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
  - @alexkroman1/aai@10.0.0

## 0.1.26

### Patch Changes

- Updated dependencies [1ad4977]
- Updated dependencies [bee46bc]
  - @alexkroman1/aai@9.2.0

## 0.1.25

### Patch Changes

- Updated dependencies [041a5a2]
  - @alexkroman1/aai@9.1.0

## 0.1.24

### Patch Changes

- cc317e4: Move the starter-eval grading corpus into aai-evals and port it to TypeScript
- @alexkroman1/aai@9.0.2

## 0.1.23

### Patch Changes

- @alexkroman1/aai@9.0.1

## 0.1.22

### Patch Changes

- Updated dependencies [444e209]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
- Updated dependencies [e888216]
- Updated dependencies [444e209]
- Updated dependencies [444e209]
- Updated dependencies [444e209]
- Updated dependencies [f6be741]
- Updated dependencies [af284a7]
- Updated dependencies [e20a992]
- Updated dependencies [444e209]
- Updated dependencies [841f460]
- Updated dependencies [b238ba0]
- Updated dependencies [6796ae3]
- Updated dependencies [5bac92d]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
  - @alexkroman1/aai@9.0.0

## 0.1.21

### Patch Changes

- @alexkroman1/aai@8.2.1

## 0.1.20

### Patch Changes

- @alexkroman1/aai@8.2.0

## 0.1.19

### Patch Changes

- Updated dependencies [2f899e1]
- Updated dependencies [1789a55]
  - @alexkroman1/aai@8.1.0

## 0.1.18

### Patch Changes

- Updated dependencies [83edc89]
- Updated dependencies [1d58f53]
- Updated dependencies [6960bfa]
- Updated dependencies [efa6152]
- Updated dependencies [01b790c]
- Updated dependencies [56b775c]
  - @alexkroman1/aai@8.0.0

## 0.1.17

### Patch Changes

- d98169a: Hash the starter-eval corpus in this package's cached test tasks.
  `starter-expectations.test.ts` imports `EXPECTATIONS` and `checkCapabilities`
  from `../../scripts/starter-eval/expectations.mjs` and asserts directly over
  that data, but `inputs` globs resolve relative to the PACKAGE — so editing an
  expectation replayed a cached green `aai-evals#test:coverage`, the very task the
  CI coverage matrix added so these suites are gated at all. Verified the
  documented way: the task hash was byte-identical across a change to the corpus
  before this, and moves with it after.
  
  Scoped to a package `turbo.json` rather than the root `globalDependencies`,
  whose five entries are all files every task reads; this corpus is read by one.
- 76ca287: **BREAKING — the last 76 `@internal` names come off the two packages' public
  barrels: 68 to `@alexkroman1/aai-runtime/internal`, 8 to a new
  `@alexkroman1/aai-ui/internal`.** Both `contracts/internal-surface.json`
  ratchets are now at zero, which is where `@alexkroman1/aai` already stood.
  
  The exemption those files record is the one hole in the capability contracts: a
  name tagged `@internal` at its declaration site but reachable anyway from a
  public subpath belongs to no capability, gets no epoch and no frozen compiling
  template, and is held to nothing but a comment. It is a ratchet that may shrink
  and may never grow, and counting it is what got it paid off — `aai` went 71 to
  0, `aai-runtime` 68 to 0, `aai-ui` 8 to 0.
  
  A release tag cannot close it from the barrel. API Extractor reads `@internal`
  at the DECLARATION site, so the tag on a re-export clause member is silently
  ignored and the name stays `@public` in the report. A deny-listed subpath is the
  mechanism, and it is the third time this repo has reached for it.
  
  **`@alexkroman1/aai-runtime`** — the second tranche off that root barrel, after
  the 31 host-internal pass-throughs that made the subpath exist. These 68 are the
  package's OWN host infrastructure: the host-mode server and its tool relay, both
  transports and the `Transport` contract they satisfy, the session core, the
  session-state backends and the table names and DDL they own, the workflow
  serving half (API handler, surface, world, install), the wake hint, the
  queue-lock sweep, the step-slot publishers, and the two shipped `Logger` values.
  What stays on the root barrel is exactly what a capability covers.
  
  Where a type is contracted and its constructor is not, the two now split: the
  `SessionCore`, `SessionStateBackend`, `SessionStateStore`, `SessionEventPage`,
  `SessionEventStream`, `Logger` and `S2SConfig` TYPES — the shapes a host
  implementing one has to name — stay on the root barrel; `createSessionCore`,
  `createMemoryStateBackend`, `createSessionStateStore`, `createSessionEventStream`
  and `consoleLogger` move. The 17-name OPENER CONTRACT deliberately did not move,
  for the reason it did not move last time: relocating it would make a custom
  speech provider import from two subpaths, one labelled not-semver-covered.
  
  **`@alexkroman1/aai-ui`** gains its first `./internal` subpath, carrying
  `SessionProvider`, `ThemeProvider`, `ToolConfigContext`, the three URL chips
  (`ApiUrlChip`, `SessionUrlChips`, `UiUrlChip`), `buildAgentUrl` and
  `loadClientConfig` — none of which a `client.tsx` names, and all of which sat in
  a client author's autocomplete beside `client()` and `useAgentState`.
  
  `aai-server`, `aai-guest`, `aai-cli`, `aai-evals` and `aai-studio-server` import
  the moved names from the new subpaths — the cross-package consumers the seam
  exists for.
  
  Both barrels now state the rule in their module docs, so the next name does not
  re-open the ratchet: a name on `/internal` that wants to become public gets its
  `@internal` tag REMOVED at the declaration site and joins a capability under
  `contracts/entrypoints/`, which is what buys it an epoch. It is never
  re-exported from the public barrel with the tag still on it.
- Updated dependencies [12ead27]
- Updated dependencies [028044a]
- Updated dependencies [429126e]
- Updated dependencies [abfc018]
- Updated dependencies [43ceb43]
- Updated dependencies [8c9ce20]
- Updated dependencies [9b9051a]
- Updated dependencies [55d5ec1]
- Updated dependencies [d98169a]
- Updated dependencies [ea0c9c9]
- Updated dependencies [d1e7c56]
- Updated dependencies [abfc018]
- Updated dependencies [a7309a5]
- Updated dependencies [51d571d]
- Updated dependencies [43ceb43]
- Updated dependencies [6596e4b]
- Updated dependencies [df8effa]
- Updated dependencies [23e8b3f]
- Updated dependencies [abfc018]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
  - @alexkroman1/aai@7.0.0

## 0.1.16

### Patch Changes

- Updated dependencies [11e4892]
- Updated dependencies [91364b0]
- Updated dependencies [3d20929]
- Updated dependencies [0397945]
- Updated dependencies [12deeec]
- Updated dependencies [8958dd1]
- Updated dependencies [1602a0e]
- Updated dependencies [0da62af]
- Updated dependencies [70e3ceb]
- Updated dependencies [f433015]
- Updated dependencies [298f3f2]
- Updated dependencies [1602a0e]
  - @alexkroman1/aai@6.11.0

## 0.1.15

### Patch Changes

- Updated dependencies [5556ed5]
  - @alexkroman1/aai@6.10.1

## 0.1.14

### Patch Changes

- Updated dependencies [1a76804]
  - @alexkroman1/aai@6.10.0

## 0.1.13

### Patch Changes

- Updated dependencies [9d45c1e]
  - @alexkroman1/aai@6.9.1

## 0.1.12

### Patch Changes

- Updated dependencies [203c2d4]
- Updated dependencies [bbde9f9]
  - @alexkroman1/aai@6.9.0

## 0.1.11

### Patch Changes

- @alexkroman1/aai@6.8.0

## 0.1.10

### Patch Changes

- Updated dependencies [7f2637c]
  - @alexkroman1/aai@6.7.2

## 0.1.9

### Patch Changes

- Updated dependencies [c46dac6]
  - @alexkroman1/aai@6.7.1

## 0.1.8

### Patch Changes

- Updated dependencies [9882411]
  - @alexkroman1/aai@6.7.0

## 0.1.7

### Patch Changes

- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
  - @alexkroman1/aai@6.6.0

## 0.1.6

### Patch Changes

- 58788ee: Internal quality pass: give repeated shapes one home each, remove stranded code, and hoist redundant work out of render and streaming paths. No API or behaviour change.
- Updated dependencies [58788ee]
- Updated dependencies [e2c2cda]
- Updated dependencies [153264f]
  - @alexkroman1/aai@6.5.1

## 0.1.5

### Patch Changes

- Updated dependencies [4da4327]
- Updated dependencies [4da4327]
  - @alexkroman1/aai@6.5.0

## 0.1.4

### Patch Changes

- Updated dependencies [5288539]
  - @alexkroman1/aai@6.4.0

## 0.1.3

### Patch Changes

- Updated dependencies [dd29277]
  - @alexkroman1/aai@6.3.1

## 0.1.2

### Patch Changes

- Updated dependencies [b04af38]
- Updated dependencies [2e103d8]
  - @alexkroman1/aai@6.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [295e8db]
  - @alexkroman1/aai@6.2.0
