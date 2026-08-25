# @alexkroman1/aai-runtime

## 8.1.0

### Patch Changes

- Updated dependencies [2f899e1]
- Updated dependencies [1789a55]
  - @alexkroman1/aai@8.1.0

## 8.0.0

### Minor Changes

- 32bbb05: Add the eval harness: `@alexkroman1/aai-runtime/eval` and `/eval/vitest`.
  
  `openEvalSession` drives a real session from TEXT — this runtime, the pipeline
  transport, the tool executor, `ctx` and the session event stream, with only the
  two speech stages faked — and `say()` returns the turn it provoked.
  `describeEval` gates a suite on a credential and, without one, runs it against a
  SCRIPTED model rather than skipping: the same code below the model, so a keyless
  run checks the wiring for free. `describeWorkflowEval` / `openEvalWorkflows` do
  the same for a workflow app, over the real workflow client and key store (no
  durability — the engine's doc says so at the seam). `run_code`, `fetch`,
  `toolTimeoutMs` and `workflows` are all suppliable per case, and `saidIn` /
  `toolCallsIn` / `toolResultIn` / `lastStateIn` / `customEventsIn` read the
  answers out of the event stream.
  
  `RuntimeOptions.toolTimeoutMs` is new and applies beyond evals: the tool
  executor always accepted a per-call deadline and the session path passed none,
  so a session's 30s voice-turn budget was unreachable from any caller.
  
  New `aai eval` command runs a project's `agent.eval.test.ts`, and every shipped
  template now has one.

### Patch Changes

- Updated dependencies [83edc89]
- Updated dependencies [1d58f53]
- Updated dependencies [6960bfa]
- Updated dependencies [efa6152]
- Updated dependencies [01b790c]
- Updated dependencies [56b775c]
  - @alexkroman1/aai@8.0.0

## 7.0.0

### Major Changes

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
- b8a5529: **BREAKING — 31 names move off `@alexkroman1/aai-runtime`'s root barrel to
  `@alexkroman1/aai-runtime/internal`.**
  
  Every one is a re-export of `@alexkroman1/aai/host-internal`, which the SDK
  itself deny-lists from its contracted surface as "not semver-covered". That
  exemption is per SUBPATH, so re-publishing the names on this package's root
  barrel defeated it — fifty not-semver-covered names sat on the one surface an
  embedder autocompletes over, one package along, and no contract could cover them
  without promising epochs on the SDK's internals.
  
  A release tag cannot fix it from here: API Extractor reads `@internal` at the
  DECLARATION site, so a `/** @internal */` on a re-export clause member is
  silently ignored (verified — the name stayed `@public` in the regenerated
  report). A subpath is the mechanism, and `NON_AUTHORING_SUBPATHS` now names this
  one so a name arriving there joins no capability contract.
  
  What moved: the builtins resolver, the SSRF-safe fetch pair, the four step-slot
  publishers, and the upload byte constants and id grammar. `aai-server`,
  `aai-cli` and `aai-guest` import them from the new subpath — the cross-package
  consumers the seam exists for.
  
  The 17-name OPENER CONTRACT deliberately did NOT move. `registerSttKind`/
  `registerTtsKind` are on the root barrel, and relocating their parameter types
  would make a custom speech provider — the documented use — import from two
  subpaths, one labelled not-semver-covered.
  
  Two dead mocks came out with it, both of which had stopped covering anything
  while every spec kept passing: `aai-guest`'s `vi.mock("@alexkroman1/aai-runtime")`
  replacing `safeFetch` (the import had moved, so the real function ran), and the
  CLI dev-server factory's `publishStepEnv`.

### Minor Changes

- 19c1ce4: createAgentServer now forwards the agent env to the server it builds, so AAI_WORKFLOW_API_TOKEN and AAI_SESSION_EVENTS_TOKEN close their routes through that door and DATABASE_URL reaches the upload store (AAI_ALLOW_HOST is filtered out, as in the guest). A malformed upload id answers 400 naming the grammar on every /uploads/:id route instead of 500 on the two reads. SESSION_EVENTS_TOKEN_ENV is exported, so a host can spell the variable that closes that surface.
- abfc018: `createAgentServer` can now express what `createRuntime` + `createServer` can, and the LLM registry's writer is published.
  
  - **`telephony` is reachable from the front door.** `createServer` defaults it to on for a voice agent, and `createAgentServer` forwarded neither it nor `page` — so every server built through the documented door, the scaffold's own `server.mjs` included, mounted an unauthenticated `WS /phone` with no way to switch it off short of abandoning the wrapper and restating by hand every field it derives. `telephony`, `page` and `uploadBroker` are forwarded now, and `page` DEFAULTS TO THE AGENT'S OWN: a `page: "static"` agent used to get the voice surfaces and a voice `GET /client-config`, because nothing carried the declaration through — the same silent drop `createAgentServer` exists to prevent for `name` and `greeting`.
  - **A `PassthroughServerOptions` bag can be spread into `ServerOptions`.** Its three fields were optional without `| undefined`, so `{ ...hooks }` widened each and `exactOptionalPropertyTypes` rejected the whole object (TS2379) — the one bag that exists to reach all three front doors could not be handed to any of them. `ServerOptions`' `logger`, `upgrade` and `request` accept `undefined`; existing callers are unaffected.
  - **`registerLlmKind` and `LlmRegistryEntry` are on `@alexkroman1/aai-runtime`**, beside `registerSttKind` and `registerTtsKind`. All three are one mechanism, and the LLM one was published from no subpath at all while `resolveLlm` — which reads the registry it writes — was public and contracted. A host wiring a model the SDK does not ship no longer has to reach past the descriptor path.
  - **`@alexkroman1/aai-runtime/internal` drops 63 re-exports nothing imports**, taking it from 99 names to 36. Every removed name is `@internal` at its declaration and was reachable only through that subpath; intra-package use is relative imports, so nothing in the repo changes. The three that stay unimported (`WakeHintOptions`, `WakeHintPublisher`, `WorldKind`) are kept because a name that IS imported has one of them in its signature.
  
  This subpath carries no semver promise, but the removal is listed here because it is the visible half of the change.
- abfc018: Add `withToolsDir` to `@alexkroman1/aai-runtime`: a self-hosted Node process can now discover an agent's `tools/` directory at startup, so a tool is registered by existing on that path too rather than only where a bundler enumerates it.

### Patch Changes

- d98169a: **Breaking (nominally): `@alexkroman1/aai-ui/default-client/*` is removed.** It
  had no consumer in any form — not one import specifier in the repo, the
  templates, the scaffold, or any README — because every real consumer reaches
  those files by filesystem path through `./package.json` (`client-dir.ts`,
  `aai-server/transport-websocket.ts`). `files: ["dist"]` still ships them, so
  nothing that worked stops working. `aai-studio-client`'s `./dist/*` goes for the
  same reason: both of its consumers `require.resolve` the manifest and join
  `"dist"` themselves.
  
  Also widens `check:attw`. `aai-ui` pinned `--entrypoints .`, which silently
  excluded `./client-dir` — a typed, contracted subpath — and `aai-runtime`
  inherited the same pin. `aai-ui` now uses `--exclude-entrypoints styles.css`
  (a CSS entry point has no type declarations, which is the only reason the pin
  existed) and `aai-runtime` drops it entirely, so a NEW subpath defaults into
  being checked instead of out.
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
