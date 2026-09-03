# aai-guest

## 0.5.15

### Patch Changes

- Updated dependencies [61fe5cd]
- Updated dependencies [61fe5cd]
- Updated dependencies [61fe5cd]
  - @alexkroman1/aai-runtime@13.1.0
  - @alexkroman1/aai-cli@13.1.0
  - @alexkroman1/aai@13.1.0
  - @alexkroman1/aai-ui@13.1.0

## 0.5.14

### Patch Changes

- 9e12bb2: Bump dependencies across the workspace: the ai SDK and its provider adapters, zod, vite, vitest, hono, the Supabase clients, xstate, undici, modal, @cartesia/cartesia-js and the build/lint toolchain.
  
  Two source changes come with it. The scripted fake language model emitted a bare-string stream finish reason where the v3 provider spec declares a { unified, raw } pair — harmless until ai@7.0.70 made automatic tool execution conditional on that value, after which a scripted tool call never ran; the fake's doGenerate half already had the pair. And protocol-compat.test.ts moves off zod's deprecated ZodTypeAny to ZodType.
- Updated dependencies [9584e2e]
- Updated dependencies [9e12bb2]
- Updated dependencies [9e12bb2]
- Updated dependencies [4647b84]
- Updated dependencies [9584e2e]
- Updated dependencies [9584e2e]
- Updated dependencies [b94fdd1]
- Updated dependencies [b94fdd1]
- Updated dependencies [ef6c39c]
- Updated dependencies [b94fdd1]
- Updated dependencies [4647b84]
- Updated dependencies [ef6c39c]
  - @alexkroman1/aai-cli@13.0.0
  - @alexkroman1/aai@13.0.0
  - @alexkroman1/aai-runtime@13.0.0
  - @alexkroman1/aai-ui@13.0.0

## 0.5.13

### Patch Changes

- Updated dependencies [4507050]
  - @alexkroman1/aai-runtime@12.0.0
  - @alexkroman1/aai-cli@12.0.0
  - @alexkroman1/aai@12.0.0
  - @alexkroman1/aai-ui@12.0.0

## 0.5.12

### Patch Changes

- Updated dependencies [36a3f22]
- Updated dependencies [0718b57]
- Updated dependencies [165f9b2]
- Updated dependencies [36a3f22]
- Updated dependencies [fe3b6d6]
- Updated dependencies [6bbef9b]
- Updated dependencies [63e1c8e]
- Updated dependencies [14b1d2d]
- Updated dependencies [36a3f22]
- Updated dependencies [f10b6aa]
- Updated dependencies [623a8bb]
- Updated dependencies [36a3f22]
- Updated dependencies [7ab47cf]
- Updated dependencies [36a3f22]
- Updated dependencies [36a3f22]
- Updated dependencies [31459e8]
  - @alexkroman1/aai@11.0.0
  - @alexkroman1/aai-runtime@11.0.0
  - @alexkroman1/aai-cli@11.0.0
  - @alexkroman1/aai-ui@11.0.0

## 0.5.11

### Patch Changes

- f35bdf7: Fix a durable-workflow livelock and the park cadence that hid it.
  
  A workflow step longer than the guest's idle window never completed in production. The guest counted workflow work by HTTP RESPONSE, so the platform's 60s delivery abort read as an idle guest while the walk carried on; the sandbox self-exited mid-step `AGENT_IDLE_EXIT_MS` later and a fresh one restarted the same step, forever. Activity is now counted at the WALK — the promise the delivery door already awaits — so a running step keeps the guest alive and an idle one still exits promptly. A parked delivery is credited nothing, deliberately.
  
  The guest half reaches production through a platform DEPLOY rather than through its own version — the harness is baked into the guest image, whose content-addressed tag the server pins at deploy time — which is why `aai-server` is named alongside it.
  
  The park delay is also proportionate to the walk instead of a flat 5 seconds: `clamp(walkingForSeconds / 8, 5, 120)`, with the log line on the same curve. A 15-minute step now costs ~24 queue round trips and ~24 log lines rather than ~170 of each, while a brief race between two deliveries still gets its fast 5s retry.
- Updated dependencies [f35bdf7]
  - @alexkroman1/aai-runtime@10.0.1
  - @alexkroman1/aai-cli@10.0.1
  - @alexkroman1/aai@10.0.1
  - @alexkroman1/aai-ui@10.0.1

## 0.5.10

### Patch Changes

- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
  - @alexkroman1/aai-runtime@10.0.0
  - @alexkroman1/aai@10.0.0
  - @alexkroman1/aai-cli@10.0.0
  - @alexkroman1/aai-ui@10.0.0

## 0.5.9

### Patch Changes

- Updated dependencies [1ad4977]
- Updated dependencies [bee46bc]
- Updated dependencies [1e5170a]
  - @alexkroman1/aai@9.2.0
  - @alexkroman1/aai-runtime@9.2.0
  - @alexkroman1/aai-cli@9.2.0
  - @alexkroman1/aai-ui@9.2.0

## 0.5.8

### Patch Changes

- Updated dependencies [041a5a2]
  - @alexkroman1/aai@9.1.0
  - @alexkroman1/aai-cli@9.1.0
  - @alexkroman1/aai-runtime@9.1.0
  - @alexkroman1/aai-ui@9.1.0

## 0.5.7

### Patch Changes

- Updated dependencies [dcb2050]
- Updated dependencies [cc317e4]
  - @alexkroman1/aai-runtime@9.0.2
  - @alexkroman1/aai-cli@9.0.2
  - @alexkroman1/aai@9.0.2
  - @alexkroman1/aai-ui@9.0.2

## 0.5.6

### Patch Changes

- Updated dependencies [533e217]
- Updated dependencies [533e217]
  - @alexkroman1/aai-runtime@9.0.1
  - @alexkroman1/aai-cli@9.0.1
  - @alexkroman1/aai@9.0.1
  - @alexkroman1/aai-ui@9.0.1

## 0.5.5

### Patch Changes

- Updated dependencies [444e209]
- Updated dependencies [65ad531]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [044236f]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
- Updated dependencies [9d5e2a2]
- Updated dependencies [e888216]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [006cc1e]
- Updated dependencies [444e209]
- Updated dependencies [bccae5a]
- Updated dependencies [86398d7]
- Updated dependencies [fcb113c]
- Updated dependencies [98be232]
- Updated dependencies [e8bc7d9]
- Updated dependencies [1f21e37]
- Updated dependencies [444e209]
- Updated dependencies [f6be741]
- Updated dependencies [af284a7]
- Updated dependencies [af284a7]
- Updated dependencies [e20a992]
- Updated dependencies [9115625]
- Updated dependencies [4e2f9f3]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [bca2d99]
- Updated dependencies [444e209]
- Updated dependencies [841f460]
- Updated dependencies [7dd348f]
- Updated dependencies [01046b6]
- Updated dependencies [841f460]
- Updated dependencies [b238ba0]
- Updated dependencies [6796ae3]
- Updated dependencies [5bac92d]
- Updated dependencies [841f460]
- Updated dependencies [af284a7]
- Updated dependencies [9e41442]
- Updated dependencies [841f460]
- Updated dependencies [18dfb1c]
- Updated dependencies [13b610f]
- Updated dependencies [044236f]
- Updated dependencies [b386453]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [95be1ca]
- Updated dependencies [c871232]
- Updated dependencies [857c3d9]
- Updated dependencies [6796ae3]
- Updated dependencies [af284a7]
- Updated dependencies [6d360a7]
- Updated dependencies [841f460]
- Updated dependencies [af284a7]
- Updated dependencies [4743746]
- Updated dependencies [444e209]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [444e209]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
- Updated dependencies [9690f28]
- Updated dependencies [af284a7]
- Updated dependencies [777d0eb]
- Updated dependencies [35a57fb]
- Updated dependencies [841f460]
  - @alexkroman1/aai@9.0.0
  - @alexkroman1/aai-runtime@9.0.0
  - @alexkroman1/aai-cli@9.0.0
  - @alexkroman1/aai-ui@9.0.0

## 0.5.4

### Patch Changes

- Updated dependencies [b9d9098]
  - @alexkroman1/aai-cli@8.2.1
  - @alexkroman1/aai@8.2.1
  - @alexkroman1/aai-runtime@8.2.1
  - @alexkroman1/aai-ui@8.2.1

## 0.5.3

### Patch Changes

- Updated dependencies [690a623]
- Updated dependencies [690a623]
  - @alexkroman1/aai-runtime@8.2.0
  - @alexkroman1/aai-cli@8.2.0
  - @alexkroman1/aai@8.2.0
  - @alexkroman1/aai-ui@8.2.0

## 0.5.2

### Patch Changes

- Updated dependencies [2f899e1]
- Updated dependencies [1789a55]
  - @alexkroman1/aai@8.1.0
  - @alexkroman1/aai-cli@8.1.0
  - @alexkroman1/aai-runtime@8.1.0
  - @alexkroman1/aai-ui@8.1.0

## 0.5.1

### Patch Changes

- Updated dependencies [83edc89]
- Updated dependencies [1d58f53]
- Updated dependencies [6960bfa]
- Updated dependencies [c0e3d85]
- Updated dependencies [32bbb05]
- Updated dependencies [efa6152]
- Updated dependencies [01b790c]
- Updated dependencies [56b775c]
  - @alexkroman1/aai@8.0.0
  - @alexkroman1/aai-ui@8.0.0
  - @alexkroman1/aai-runtime@8.0.0
  - @alexkroman1/aai-cli@8.0.0

## 0.5.0

### Minor Changes

- ddbb905: Studio coding agent: a `read_logs` tool, so it can read what the agent it is building actually printed.
  
  A runtime failure — a tool throwing mid-call, a missing provider key, a response shape the code guessed wrong — only happens with a real caller on the line, and `test_agent` loads the bundle inside the coding agent's own sandbox where none of that is visible. The evidence existed (it is what the studio's Logs pane shows) and the agent's only route to it was asking the user to read it out.
  
  `read_logs` takes an ENVIRONMENT (`preview`, the default, or `production`) and never a slug: the guest RPCs the host, which resolves the project's own deployed agents from the workspace of the (scope, project) the sandbox is pinned to and reads the platform's owner-authenticated `GET /:slug/logs` with the account key those agents were deployed with. The host drains the guest's cursor-indexed ring forward and returns the TAIL, because the ring hands back its oldest lines first and "what just broke" is at the other end. Eviction is reported rather than swallowed, and each of the three empty states — never deployed, not running, running and silent — says which one it is, since they call for different next moves.

### Patch Changes

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
- Updated dependencies [d98169a]
- Updated dependencies [12ead27]
- Updated dependencies [abfc018]
- Updated dependencies [028044a]
- Updated dependencies [429126e]
- Updated dependencies [76ca287]
- Updated dependencies [abfc018]
- Updated dependencies [43ceb43]
- Updated dependencies [8c9ce20]
- Updated dependencies [9b9051a]
- Updated dependencies [19c1ce4]
- Updated dependencies [55d5ec1]
- Updated dependencies [8c2190f]
- Updated dependencies [d98169a]
- Updated dependencies [6fadb69]
- Updated dependencies [ea0c9c9]
- Updated dependencies [b8a5529]
- Updated dependencies [abfc018]
- Updated dependencies [d1e7c56]
- Updated dependencies [b8a5529]
- Updated dependencies [abfc018]
- Updated dependencies [a7309a5]
- Updated dependencies [51d571d]
- Updated dependencies [43ceb43]
- Updated dependencies [6596e4b]
- Updated dependencies [3b3b833]
- Updated dependencies [abfc018]
- Updated dependencies [df8effa]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
- Updated dependencies [abfc018]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
  - @alexkroman1/aai-ui@7.0.0
  - @alexkroman1/aai-runtime@7.0.0
  - @alexkroman1/aai@7.0.0
  - @alexkroman1/aai-cli@7.0.0

## 0.4.31

### Patch Changes

- Updated dependencies [11e4892]
- Updated dependencies [91364b0]
- Updated dependencies [9c73674]
- Updated dependencies [3d20929]
- Updated dependencies [0397945]
- Updated dependencies [1334239]
- Updated dependencies [12deeec]
- Updated dependencies [8958dd1]
- Updated dependencies [1602a0e]
- Updated dependencies [0da62af]
- Updated dependencies [70e3ceb]
- Updated dependencies [f433015]
- Updated dependencies [298f3f2]
- Updated dependencies [1602a0e]
  - @alexkroman1/aai@6.11.0
  - @alexkroman1/aai-cli@6.11.0
  - @alexkroman1/aai-ui@6.11.0

## 0.4.30

### Patch Changes

- Updated dependencies [5556ed5]
  - @alexkroman1/aai@6.10.1
  - @alexkroman1/aai-cli@6.10.1
  - @alexkroman1/aai-ui@6.10.1

## 0.4.29

### Patch Changes

- Updated dependencies [1a76804]
  - @alexkroman1/aai@6.10.0
  - @alexkroman1/aai-cli@6.10.0
  - @alexkroman1/aai-ui@6.10.0

## 0.4.28

### Patch Changes

- Updated dependencies [9d45c1e]
  - @alexkroman1/aai@6.9.1
  - @alexkroman1/aai-cli@6.9.1
  - @alexkroman1/aai-ui@6.9.1

## 0.4.27

### Patch Changes

- Updated dependencies [ebd3c39]
- Updated dependencies [203c2d4]
- Updated dependencies [bbde9f9]
- Updated dependencies [a8e74a9]
  - @alexkroman1/aai-ui@6.9.0
  - @alexkroman1/aai@6.9.0
  - @alexkroman1/aai-cli@6.9.0

## 0.4.26

### Patch Changes

- Updated dependencies [c7bb199]
  - @alexkroman1/aai-ui@6.8.0
  - @alexkroman1/aai-cli@6.8.0
  - @alexkroman1/aai@6.8.0

## 0.4.25

### Patch Changes

- Updated dependencies [7f2637c]
- Updated dependencies [088eee6]
  - @alexkroman1/aai@6.7.2
  - @alexkroman1/aai-ui@6.7.2
  - @alexkroman1/aai-cli@6.7.2

## 0.4.24

### Patch Changes

- Updated dependencies [c46dac6]
  - @alexkroman1/aai@6.7.1
  - @alexkroman1/aai-cli@6.7.1
  - @alexkroman1/aai-ui@6.7.1

## 0.4.23

### Patch Changes

- Updated dependencies [9882411]
- Updated dependencies [54fe7b1]
  - @alexkroman1/aai@6.7.0
  - @alexkroman1/aai-cli@6.7.0
  - @alexkroman1/aai-ui@6.7.0

## 0.4.22

### Patch Changes

- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
  - @alexkroman1/aai@6.6.0
  - @alexkroman1/aai-cli@6.6.0
  - @alexkroman1/aai-ui@6.6.0

## 0.4.21

### Patch Changes

- 58788ee: Internal quality pass: give repeated shapes one home each, remove stranded code, and hoist redundant work out of render and streaming paths. No API or behaviour change.
- Updated dependencies [58788ee]
- Updated dependencies [e2c2cda]
- Updated dependencies [153264f]
- Updated dependencies [153264f]
  - @alexkroman1/aai@6.5.1
  - @alexkroman1/aai-ui@6.5.1
  - @alexkroman1/aai-cli@6.5.1

## 0.4.20

### Patch Changes

- Updated dependencies [4da4327]
- Updated dependencies [4da4327]
  - @alexkroman1/aai@6.5.0
  - @alexkroman1/aai-cli@6.5.0
  - @alexkroman1/aai-ui@6.5.0

## 0.4.19

### Patch Changes

- Updated dependencies [5288539]
- Updated dependencies [5288539]
  - @alexkroman1/aai@6.4.0
  - @alexkroman1/aai-cli@6.4.0
  - @alexkroman1/aai-ui@6.4.0

## 0.4.18

### Patch Changes

- Updated dependencies [dd29277]
  - @alexkroman1/aai@6.3.1
  - @alexkroman1/aai-cli@6.3.1
  - @alexkroman1/aai-ui@6.3.1

## 0.4.17

### Patch Changes

- Updated dependencies [b04af38]
- Updated dependencies [2e103d8]
  - @alexkroman1/aai@6.3.0
  - @alexkroman1/aai-cli@6.3.0
  - @alexkroman1/aai-ui@6.3.0

## 0.4.16

### Patch Changes

- Updated dependencies [295e8db]
  - @alexkroman1/aai@6.2.0
  - @alexkroman1/aai-ui@6.2.0
  - @alexkroman1/aai-cli@6.2.0

## 0.4.15

### Patch Changes

- c4791cc: Split the local-dev sentinel in two: SUPABASE_DB_URL decides where platform state lives (no memory tier beside a real database), AAI_LOCAL_DEV=1 declares a local run. pnpm dev:aai-server resolves the local Supabase stack and a repo-root .env itself; studio sign-in offers the methods GoTrue reports, so email+password works locally with no OAuth app; boot verifies pg_cron instead of creating it. Studio projects get a database by DEFAULT (absent means on; the opt-out is an explicit false), and `@workflow/world-postgres` is no longer bundled into the guest harness — it ships on-disk Drizzle migrations the bundle cannot carry, so the durable Postgres workflow world could never start.
- 16bec88: Use the SDK's own `errorMessage` and `isToolFailure` where the guest harness and the retail template had hand-written copies of them.
- @alexkroman1/aai-cli@6.1.0

## 0.4.14

### Patch Changes

- Updated dependencies [66b588a]
- Updated dependencies [df41665]
- Updated dependencies [24e8178]
  - @alexkroman1/aai-cli@5.14.0
  - @alexkroman1/aai@5.14.0
  - @alexkroman1/aai-ui@5.14.0

## 0.4.13

### Patch Changes

- Updated dependencies [4ba7ab3]
  - @alexkroman1/aai-ui@5.13.2
  - @alexkroman1/aai-cli@5.13.2
  - @alexkroman1/aai@5.13.2

## 0.4.12

### Patch Changes

- Updated dependencies [7e92c96]
  - @alexkroman1/aai@5.13.1
  - @alexkroman1/aai-cli@5.13.1
  - @alexkroman1/aai-ui@5.13.1

## 0.4.11

### Patch Changes

- Updated dependencies [5cfe26b]
- Updated dependencies [90e5c15]
- Updated dependencies [cdc8e54]
- Updated dependencies [db4b0fb]
- Updated dependencies [ce45435]
- Updated dependencies [cdc8e54]
  - @alexkroman1/aai@5.13.0
  - @alexkroman1/aai-cli@5.13.0
  - @alexkroman1/aai-ui@5.13.0

## 0.4.10

### Patch Changes

- Updated dependencies [42cf8ab]
- Updated dependencies [c49f501]
- Updated dependencies [db3fb48]
- Updated dependencies [42cf8ab]
- Updated dependencies [c49f501]
- Updated dependencies [db3fb48]
- Updated dependencies [a91c3bc]
- Updated dependencies [db3fb48]
- Updated dependencies [42cf8ab]
- Updated dependencies [db3fb48]
- Updated dependencies [c49f501]
- Updated dependencies [9fded19]
- Updated dependencies [c49f501]
- Updated dependencies [348fa16]
- Updated dependencies [db3fb48]
- Updated dependencies [c49f501]
- Updated dependencies [9fded19]
  - @alexkroman1/aai-cli@5.12.0
  - @alexkroman1/aai@5.12.0
  - @alexkroman1/aai-ui@5.12.0

## 0.4.9

### Patch Changes

- Updated dependencies [f06e2b7]
- Updated dependencies [e8d5e15]
- Updated dependencies [678acea]
  - @alexkroman1/aai-cli@5.11.0
  - @alexkroman1/aai@5.11.0
  - @alexkroman1/aai-ui@5.11.0

## 0.4.8

### Patch Changes

- Updated dependencies [f941665]
  - @alexkroman1/aai-cli@5.10.1
  - @alexkroman1/aai@5.10.1
  - @alexkroman1/aai-ui@5.10.1

## 0.4.7

### Patch Changes

- 6b4a6d8: Run the platform on Node 26: the Modal service image, the guest sandbox base image, the repo's pinned toolchain, and CI all move from 24 to 26, matching the `@types/node` major the workspace already type-checks against. Published SDK packages keep `engines.node: >=24` so consumers on the previous LTS are unaffected.
- Updated dependencies [b125465]
- Updated dependencies [1731876]
- Updated dependencies [b037dd6]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [fb7b545]
- Updated dependencies [d569226]
- Updated dependencies [b125465]
- Updated dependencies [c7617df]
- Updated dependencies [b125465]
- Updated dependencies [520900f]
- Updated dependencies [b125465]
- Updated dependencies [fbccb3e]
- Updated dependencies [c524b76]
- Updated dependencies [b125465]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [ae9fd19]
- Updated dependencies [b125465]
- Updated dependencies [6ca79e0]
- Updated dependencies [b125465]
- Updated dependencies [fee8ece]
- Updated dependencies [ae9fd19]
- Updated dependencies [d8e34d8]
- Updated dependencies [a90296e]
- Updated dependencies [b125465]
- Updated dependencies [a82e54d]
- Updated dependencies [4b6e064]
- Updated dependencies [1c5056f]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [ae9fd19]
  - @alexkroman1/aai@5.10.0
  - @alexkroman1/aai-cli@5.10.0
  - @alexkroman1/aai-ui@5.10.0

## 0.4.6

### Patch Changes

- Updated dependencies [f5e2c54]
  - @alexkroman1/aai-cli@5.9.0
  - @alexkroman1/aai@5.9.0
  - @alexkroman1/aai-ui@5.9.0

## 0.4.5

### Patch Changes

- Updated dependencies [3ddfbfc]
  - @alexkroman1/aai-cli@5.8.1
  - @alexkroman1/aai@5.8.1
  - @alexkroman1/aai-ui@5.8.1

## 0.4.4

### Patch Changes

- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
  - @alexkroman1/aai@5.8.0
  - @alexkroman1/aai-cli@5.8.0
  - @alexkroman1/aai-ui@5.8.0

## 0.4.3

### Patch Changes

- Updated dependencies [56efab9]
- Updated dependencies [56efab9]
- Updated dependencies [56efab9]
- Updated dependencies [56efab9]
- Updated dependencies [56efab9]
- Updated dependencies [1c034af]
- Updated dependencies [56efab9]
  - @alexkroman1/aai-cli@5.7.0
  - @alexkroman1/aai@5.7.0
  - @alexkroman1/aai-ui@5.7.0

## 0.4.2

### Patch Changes

- 77b0a80: Log guest stderr on boot failure, validate the resume sessionId, and stop a bundle spoofing its own deploy-time config.
- f4ae66f: Two more guest-ownership moves: replica shutdown RETIRES agent guests
  (one awaited deadline-carrying drain each — live calls finish in the guests
  after the replica exits) instead of count-poll-terminate, deleting the whole
  shutdown session-drain machinery; and the client-config broker now PROXIES
  name/greeting from the guest's own `/client-config` (the bundle's live agent
  definition), making the stored config fully opaque to the host — no
  field-level reader remains.
- f4ae66f: Simplify sandbox management around guest-owned lifecycle: delete per-slug
  horizontal scaling and the cross-replica sandbox registry (one sandbox per
  slug per replica), delete host-side idle eviction (agent guests self-exit
  after 5 idle minutes), make retirement fire-and-forget (one
  deadline-carrying `POST /manage/drain`; the guest enforces the deadline),
  replace the control-channel `bundle/load`/`tool/execute` RPCs with a
  one-shot describe-mode harness exec for deploy-time config extraction, and
  fail loudly on an unresolvable pinned harness image
  (`SANDBOX_IGNORE_IMAGE_PINS=1` is the operator kill switch).
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [e2a473a]
- Updated dependencies [753665a]
- Updated dependencies [dd90edc]
- Updated dependencies [5cd6d50]
- Updated dependencies [77b0a80]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [8b622e8]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [8b622e8]
- Updated dependencies [29fa487]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [77b0a80]
  - @alexkroman1/aai@5.6.0
  - @alexkroman1/aai-cli@5.6.0
  - @alexkroman1/aai-ui@5.6.0

## 0.4.1

### Patch Changes

- Updated dependencies [1a6f800]
  - @alexkroman1/aai@5.5.1
  - @alexkroman1/aai-cli@5.5.1
  - @alexkroman1/aai-ui@5.5.1

## 0.4.0

### Minor Changes

- ae89dd9: Email login via Supabase Auth, for the studio and the CLI. The studio's browser bearer is now a session token (magic-link sign-in) resolved server-side to the user's stored AssemblyAI key (`user-key:<uid>` in Vault); connecting that key is the mandatory onboarding step after sign-in — every AssemblyAI key on the platform is user-provided, and the browser never holds one. `aai login` drives the same flow from the terminal via Supabase email OTP and saves the fetched key in the CLI config. A dev-token auth implementation keeps local dev Supabase-free. The guest chat surface is gated by a broker-minted per-session token instead of the caller's key. Slug-ownership hashes drop argon2id for plain SHA-256 digests (high-entropy machine keys need no slow hash), removing `@node-rs/argon2` and the verify cache. Raw API-key bearers keep working on every route.

### Patch Changes

- 4de0abe: Add studio template tools: list_templates enumerates the bundled example agents and use_template copies a template's files verbatim into the workspace
- Updated dependencies [a57905b]
- Updated dependencies [030b55f]
- Updated dependencies [966aeed]
- Updated dependencies [6cca475]
- Updated dependencies [e7a6f43]
- Updated dependencies [d303cfb]
- Updated dependencies [41d53ae]
- Updated dependencies [ae89dd9]
- Updated dependencies [cecafd3]
  - @alexkroman1/aai@5.5.0
  - @alexkroman1/aai-ui@5.5.0
  - @alexkroman1/aai-cli@5.5.0

## 0.3.3

### Patch Changes

- Updated dependencies [cb2de62]
- Updated dependencies [08dbc81]
- Updated dependencies [2198e2e]
- Updated dependencies [2198e2e]
- Updated dependencies [1d76583]
- Updated dependencies [5174cb2]
- Updated dependencies [aafe175]
  - @alexkroman1/aai@5.4.0
  - @alexkroman1/aai-ui@5.4.0
  - @alexkroman1/aai-cli@5.4.0

## 0.3.2

### Patch Changes

- Updated dependencies [27c5963]
- Updated dependencies [27c5963]
- Updated dependencies [a9ff1d1]
  - @alexkroman1/aai@5.3.0
  - @alexkroman1/aai-cli@5.3.0
  - @alexkroman1/aai-ui@5.3.0

## 0.3.1

### Patch Changes

- 2cedec1: Post-write type diagnostics in the studio coding agent: every successful write_file/edit_file type-checks the workspace (cold tsgo, coalesced) and appends hint-annotated diagnostics to the tool result; the standalone check_types tool is removed in favor of this plus test_agent.
- Updated dependencies [be1ed53]
  - @alexkroman1/aai-cli@5.2.0
  - @alexkroman1/aai@5.2.0
  - @alexkroman1/aai-ui@5.2.0

## 0.3.0

### Minor Changes

- a96e9f8: Studio preview mode: edits auto-deploy to a per-project preview agent; Publish is production-only.

  - Every settled edit (the coding agent's turn-complete workspace sync — now flagged `done: true`, the analog of opencode's `session.idle` / codex's `agent-turn-complete` — and editor file writes/deletes) schedules a coalesced, fire-and-forget deploy of the workspace to `<project>-preview` through the same in-guest `aai deploy` path Publish uses. Mid-turn checkpoints never trigger deploys, so half-finished trees are never previewed.
  - The Live tab is renamed Preview and frames the preview agent, keyed by a `previewVersion` token so a fresh preview reloads the iframe exactly once; the client polls while a preview deploy is in flight, and failed preview builds surface their CLI output in the pane banner.
  - The production URL in the top bar stays a plain link that opens the deployed agent in a new tab, and the Secrets panel mirrors writes to the preview slug so previews run with the same third-party keys.

### Patch Changes

- b1bf017: Consolidate aai-guest internals: one shared child-process runner (runCapped) replaces five hand-rolled spawn helpers, one bearer-auth module serves both authenticated surfaces, and the per-tool 120s deadline now wraps the merged studio tool set (web, project, and design tools included). Parallelize workspace snapshot/materialize/sync I/O and make grep read only glob-matching files.
- c745865: Serialize the studio build child's worker and client bundles: two concurrent Rolldown passes peak at roughly the sum of their native allocations in the one process a sandbox memory cap would OOM-kill, and the sandbox's single CPU means serializing costs no meaningful wall clock.
- 8b8249e: Revert the one-shot child-process workspace build (#845): test_agent builds run in-process in the harness again.
- Updated dependencies [ded8b64]
- Updated dependencies [e47a187]
- Updated dependencies [b829155]
- Updated dependencies [ab577dc]
  - @alexkroman1/aai-cli@5.1.1
  - @alexkroman1/aai-ui@5.1.1
  - @alexkroman1/aai@5.1.1

## 0.2.2

### Patch Changes

- d1fc1c0: Run the studio's test_agent workspace build in a one-shot child process. Rolldown allocates outside V8 and never returns that memory to the OS, so an in-process build left ~1.5 GB permanently resident in the long-lived guest harness — measured 258 MB to 1.7 GB on one build, climbing with each later one. Publish already spawned the CLI; both build paths now exit to reclaim.
- Updated dependencies [8fb0a0d]
- Updated dependencies [ac21a90]
- Updated dependencies [3bc83bb]
  - @alexkroman1/aai@5.1.0
  - @alexkroman1/aai-ui@5.1.0
  - @alexkroman1/aai-cli@5.1.0

## 0.2.1

### Patch Changes

- Updated dependencies [fb4c14c]
  - @alexkroman1/aai-ui@5.0.1
  - @alexkroman1/aai-cli@5.0.1
  - @alexkroman1/aai@5.0.1

## 0.2.0

### Minor Changes

- 293da11: The studio coding agent is now a Claude-Code-style agentic agent that runs
  INSIDE the project's own Modal sandbox, with the browser connected to it
  directly — mirroring the voice path. `POST /studio/projects/:project/
session` boots (or reuses) a guest sandbox through the same warm-pool
  machinery deployed agents use and returns the sandbox's public chat URL;
  turns stream browser→sandbox over SSE and never pass through the platform
  host. The loop runs in the guest on the caller's own key with tools over a
  real filesystem workspace — list/read (windowed)/write/edit/delete, glob,
  grep, bash (a real shell in the container), todo_write, test_agent, and
  the keyless web builtins — each with a user-friendly label served by the
  sandbox (`GET /studio/tools`) and rendered in the studio UI. End of turn,
  the guest syncs workspace edits and the conversation back over the
  authenticated control channel; test_agent builds via a guest→host RPC to
  the out-of-process build runner. The host-side chat loop, scan worker
  thread, and host tool implementations are removed — the SDK's
  `createServer` gains a `request` hook so the harness can serve the chat
  surface without a second HTTP server.
- cc71fab: Workers ship their own SDK runtime, and all studio builds run in the guest sandbox through the aai CLI's bundlers.

  - `buildWorker`'s wrapper entry now bundles the user's installed SDK runtime behind an `__aaiCreateRuntime` export; the guest harness builds sessions through that factory and embeds no runtime of its own, so platform SDK drift can no longer break deployed agents. Bundles without the factory are rejected at `bundle/load`.
  - The studio's out-of-process build subsystem (build runner/entry/protocol/cache, the import-allowlist worker build, the host client build, and the `studio_build` Modal Function) is deleted. `test_agent` builds the live workspace in the guest; Publish builds via the new host→guest `workspace/build` RPC, which also returns the bundle's config self-description — no throwaway inspection sandbox on the studio path.
  - The guest snapshot image now bakes the build toolchain (`@alexkroman1/aai-cli` + workspace-facing packages) next to the harness; versions derive from aai-guest's own dependencies.
  - `MAX_WORKER_SIZE` rises to 30 MB; `evalWorkerBundle` imports workers via a temp `file:` URL (the bundled runtime's CJS interop rejects `data:` URLs); the dev server opts out of runtime inlining to keep watch rebuilds fast.
  - Studio Publish now runs the literal `aai deploy` CLI inside the project's sandbox (`workspace/deploy`), and the CLI's output is posted into the chat so the coding agent sees deploy errors. `aai deploy` gains `--allow-missing-secrets` (server-side `credentialPolicy: "warn"` in the deploy body), and deploy responses now carry preflight `warnings`.
  - The studio's storage toggle and routes are removed — storage is CLI-only (`aai storage enable`). Deployed-agent secrets move to their own Secrets panel backed by the platform's `/:slug/secret` routes; every change posts a note into the chat (key names only).
  - `aai build` and `aai deploy` now type-check the project (`tsc --noEmit` with its own tsconfig and compiler; `--skipTypecheck` opts out), as does the studio's `test_agent`. Studio workspaces are completed into real projects in the guest (package.json, tsconfig.json, global.d.ts, vite.config.ts — scaffold-mirroring, existing files win).

### Patch Changes

- Updated dependencies [c36ad60]
- Updated dependencies [9b95fc9]
- Updated dependencies [5a599b2]
- Updated dependencies [e8fef4b]
- Updated dependencies [0c2bdbd]
- Updated dependencies [25938b2]
- Updated dependencies [0c2bdbd]
- Updated dependencies [0c2bdbd]
- Updated dependencies [6fb3bc3]
- Updated dependencies [55e045b]
- Updated dependencies [0c2bdbd]
- Updated dependencies [293da11]
- Updated dependencies [0c2bdbd]
- Updated dependencies [0c2bdbd]
- Updated dependencies [30914c9]
- Updated dependencies [0c2bdbd]
- Updated dependencies [0c2bdbd]
- Updated dependencies [5a599b2]
- Updated dependencies [01cecc1]
- Updated dependencies [9867aa3]
- Updated dependencies [d4c2a10]
- Updated dependencies [0c2bdbd]
- Updated dependencies [e8fef4b]
- Updated dependencies [293da11]
- Updated dependencies [e8fef4b]
- Updated dependencies [30914c9]
- Updated dependencies [fdd64ef]
- Updated dependencies [0c2bdbd]
- Updated dependencies [cc71fab]
  - @alexkroman1/aai@5.0.0
  - @alexkroman1/aai-ui@5.0.0
  - @alexkroman1/aai-cli@5.0.0
