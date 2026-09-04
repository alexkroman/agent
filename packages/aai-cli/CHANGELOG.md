# @alexkroman1/aai-cli

## 15.0.0

### Major Changes

- 77b86d9: `aai start` replaces the scaffold's `server.mjs`, and `aai build --target` emits a host entry instead of committing one.
  
  The scaffold shipped ~300 lines of boot into every project — worker load, env resolution, schema DDL, client-dir probing, error classification, listen, signal handlers — so improving any of them reached only projects scaffolded afterwards. It is a command now: `npm start` runs `aai start`, and `@alexkroman1/aai-cli/start` publishes `createProjectServer()` for a custom or serverless host, which builds the `AgentServer` and binds nothing.
  
  `aai build --target <host>` writes the entry a host expects into the build output rather than the project. The target is detected from the host's own build environment (`VERCEL`), so a git-push deploy configures nothing; `node`, the default, emits nothing extra. The Vercel entry is `export default (await createProjectServer(...)).node`, which is that platform's documented Node WebSocket shape.
  
  Breaking for a scaffolded project: `server.mjs` is gone and `@alexkroman1/aai-cli` moves from devDependencies to dependencies, since `npm start` now runs it.

### Minor Changes

- ae5e069: `aai init` now shows a template selector when `--template` is omitted, listing every template the CLI ships with `simple` pre-selected. `--yes` and JSON mode still take the default without prompting.

### Patch Changes

- 77b86d9: Emit a Vercel deployment through the Build Output API (`.vercel/output/`) instead of an `api/` entry beside a generated `vercel.json`. Vercel reads `vercel.json` before running the build, so a config the build writes never applied to that deployment; the Build Output tree is read after it. The function is now assembled rather than traced, so `.aai/worker.mjs` and `.env.example` — both reached by paths no static tracer can follow — are present, the built client is CDN-served from `static/`, and a WebSocket upgrade arrives through Vercel's per-request context and is re-emitted onto the same server `aai dev` runs. Also cuts `@alexkroman1/aai-cli/start` off the build toolchain: it reached `build.ts` (hence vite and rolldown's native binding) for one path constant, which made the bundled entry fail on import.
- b92507b: Scaffolded templates: give the four prompt-only starters (code-interpreter, math-buddy, personal-finance, web-researcher) a unit-tier `agent.test.ts`, which `aai build` runs before it bundles, and make every `tools/` file default-export its tool rather than re-export it.
  
  The templates ship inside this package's tarball, so the carrier is named here rather than `aai-templates`, which reaches nobody on its own version (`guard-invariants` rule 20). Also tightens the repo's structural conventions, which changes no shipped behaviour: provider factory signatures and options interfaces, provider and channel descriptor purity, store factory return types, the `sdk/`→`host/` boundary, boundaries for `aai-studio-server` and `aai-evals`, and a test asserting the boundary matrix is total.
- Updated dependencies [29fbf01]
- Updated dependencies [f9c1a98]
- Updated dependencies [77b86d9]
- Updated dependencies [29fbf01]
- Updated dependencies [29fbf01]
- Updated dependencies [8dc4cbb]
- Updated dependencies [77b86d9]
- Updated dependencies [29fbf01]
  - @alexkroman1/aai-runtime@15.0.0
  - @alexkroman1/aai@15.0.0
  - @alexkroman1/aai-ui@15.0.0

## 14.0.0

### Patch Changes

- 79e3ea6: Collapse duplicated seams in the CLI: one command-tree walk behind both pre-parse guards, shared trailing-slash/capped-list/comparator/pluralization helpers, the platform arg group, and a resolve-once target for polling commands.
- Updated dependencies [a9c1577]
- Updated dependencies [292ae33]
- Updated dependencies [b5beca2]
- Updated dependencies [79e3ea6]
- Updated dependencies [292ae33]
- Updated dependencies [a9c1577]
- Updated dependencies [a1a4e1e]
- Updated dependencies [79e3ea6]
- Updated dependencies [1a093ea]
- Updated dependencies [79e3ea6]
- Updated dependencies [a9c1577]
- Updated dependencies [292ae33]
- Updated dependencies [79e3ea6]
- Updated dependencies [292ae33]
- Updated dependencies [79e3ea6]
- Updated dependencies [292ae33]
- Updated dependencies [5fc40e3]
- Updated dependencies [a9c1577]
- Updated dependencies [a9c1577]
- Updated dependencies [292ae33]
- Updated dependencies [ef096bb]
  - @alexkroman1/aai-runtime@14.0.0
  - @alexkroman1/aai@14.0.0
  - @alexkroman1/aai-ui@14.0.0

## 13.3.0

### Patch Changes

- 14c54ac: `aai test` no longer reports a pass over specs it did not run: an incomplete run fails with `incomplete_run` naming the files, the result carries `ran`/`unrun`/`complete` for CI to read, `--all` runs the whole suite, and `aai build`'s pre-build gate announces the same set. Scaffolded projects now wire `npm test` to their own vitest run so the CI entrypoint is the command that runs their suite.
- 14c54ac: aai secret put no longer blocks forever: the value source is decided by stdin rather than by the output mode, an idle stdin gives up after 10s naming both working forms, a value passed as an argument is refused instead of silently discarded, and `--help` documents the stdin contract. JSON-mode output is stripped of ANSI escapes, so a bundler's coloured diagnostic is legible in the envelope, and an unknown command is reported as a JSON result naming the command instead of a colour-escaped sentence on stderr.
- 14c54ac: aai build now gates on the project's whole test suite rather than agent.test.ts alone, and a declared-but-empty .env value is dropped instead of being handed to a provider as "" (which silently defeated the host-credential fallback). aai test gained the --all flag its own incomplete-run failure recommends.
- 14c54ac: aai dev: report a missing ASSEMBLYAI_API_KEY as a credential problem, not a login one. The failure now names the two purely local remedies (.env, a shell export) before `aai login`; the scaffold's .env.example documents the key the default pipeline needs; and the generated README runs the CLI through npm (it is a devDependency, not on PATH) and names `aai login` where publishing actually needs it.
- 14c54ac: Template specs assert invariants that survive customization: renaming an agent, swapping a provider stage, or adding a tool or workflow no longer fails a shipped test (and so no longer blocks `aai build`).
- Updated dependencies [14c54ac]
- Updated dependencies [25e42e8]
- Updated dependencies [78ed86c]
- Updated dependencies [130898e]
  - @alexkroman1/aai-runtime@13.3.0
  - @alexkroman1/aai-ui@13.3.0
  - @alexkroman1/aai@13.3.0

## 13.2.0

### Patch Changes

- Updated dependencies [4fb6b05]
- Updated dependencies [9cb7392]
- Updated dependencies [93ea30c]
  - @alexkroman1/aai@13.2.0
  - @alexkroman1/aai-runtime@13.2.0
  - @alexkroman1/aai-ui@13.2.0

## 13.1.0

### Patch Changes

- Updated dependencies [61fe5cd]
- Updated dependencies [61fe5cd]
- Updated dependencies [61fe5cd]
  - @alexkroman1/aai-runtime@13.1.0
  - @alexkroman1/aai@13.1.0
  - @alexkroman1/aai-ui@13.1.0

## 13.0.0

### Patch Changes

- 9584e2e: Parse third-party JSON in the recap-workflow, podcast-digest and call-audit workflow bodies with declared zod schemas instead of hand-rolled per-field guards, keeping every degradation path (a malformed payload, a missing optional field, a field of the wrong type) exactly as it was.
- b94fdd1: transcription-workflow: measure the upload's byte rate as an AVERAGE, and give the poll floor a comparison that means something.
  
  The streaming flow's adaptive sleep took its rate from two adjacent polls. The store publishes bytes an `UPLOAD_PART_BYTES` window at a time, so that difference is bimodal — zero (read as a stall, giving back the flat ceiling) or one whole 8 MiB window (an instantaneous burst tens of times the true average, collapsing the sleep to its floor) — and never a throughput. It now measures against the run's FIRST poll, which is also what removes a placement bug: the `previous = at` assignment sat after the sleep, so the `continue` taken on a batch of ready segments skipped it and the next rate was computed against a pre-batch view.
  
  `MIN_POLL_INTERVAL_MS` was 250ms and therefore dead: a durable sleep's deadline is computed before its journal write is issued and tested after that write returns, so at the measured 164-796ms of journal latency a 250ms sleep had already expired and did not sleep at all. It is 1000ms, and its doc now compares against the round trip of the machinery that implements the sleep rather than against a segment's transcription latency. Two more corrections in the same file: `MAX_IDLE_POLLS` is 20-40 minutes of silence rather than the five its doc claimed (a poll costs a delivery, not an interval), and an unreachable `remaining <= 0` arm is gone — the clamp below it already answered the floor for every input.
- Updated dependencies [9e12bb2]
- Updated dependencies [9e12bb2]
- Updated dependencies [4647b84]
- Updated dependencies [9584e2e]
- Updated dependencies [9584e2e]
- Updated dependencies [b94fdd1]
- Updated dependencies [ef6c39c]
- Updated dependencies [b94fdd1]
- Updated dependencies [4647b84]
- Updated dependencies [ef6c39c]
  - @alexkroman1/aai@13.0.0
  - @alexkroman1/aai-runtime@13.0.0
  - @alexkroman1/aai-ui@13.0.0

## 12.0.0

### Patch Changes

- Updated dependencies [4507050]
  - @alexkroman1/aai-runtime@12.0.0
  - @alexkroman1/aai@12.0.0
  - @alexkroman1/aai-ui@12.0.0

## 11.0.0

### Minor Changes

- 36a3f22: Warn at `aai build` and `aai deploy` about a COMPUTED workflow identity, and hold this repo's own shipped bodies to the same thing as `guard-invariants` rule 32.
  
  `ctx.step`, `ctx.sleep` and `ctx.waitFor` all key a journal ROW by their first argument, and a body is replayed — so a computed identity mints a row no earlier walk reached, after which the engine either re-executes the step or refuses the run. On a one-line body a coin flip interpolated into a step name ran the side effect twice in 7 of 10 runs, with all 10 reporting `completed`.
  
  The reason a check is needed at all is that the TYPE system provably misses this shape. All three methods constrain their identity with `Literal<Name>` (`string extends Name ? never : Name`), which refuses a name that has widened to `string` — and a template literal's type is a template-literal type rather than `string`, so ``ctx.step(`charge-${coin}`, charge)`` compiles cleanly. Verified against the real `WorkflowCtx`.
  
  It stands at ZERO, in the repo and in every shipped template, and that is structural rather than lucky: identity is `(name, occurrence)` and the counter is per name, so a fan-out reuses one literal — `ctx.step("transcribeSegment", …)` inside the loop is the shipped seven-way one. A false-positive floor is a test: the scan runs over all fourteen templates and requires no findings, every template being a project somebody scaffolds and then builds. The template count is floored too, since a glob that stopped resolving is that assertion passing over nothing.
  
  It WARNS rather than failing the build, same posture and same call site as `agentConfigWarnings`, because one shape is legitimate — a name interpolating a `const` string is the same on every walk. On `deploy` the findings join `warnings` rather than only being notified, so they reach studio Publish, which reads the result and never stdout.
  
  Rule 30's other half — the scan for the non-deterministic READS themselves — is deliberately NOT ported to user projects, and the measurement is why: a faithful port reports exactly this repo's seven baselined occurrences and nothing else, and all seven are correct code (a read inside a step-called helper, the boundary `link-digest`'s own comment explains a line cannot see). A user's project has no baseline, so that port is a 100% false-positive rate on the only measurable corpus. Deciding the boundary needs a real parse, and a native parser cannot join a published CLI's runtime dependencies.
  
  The pattern is duplicated between the two halves because neither can import the other — the gate script is plain node run over this repo, the CLI ships to users — so a test reads the gate's identity list out of its source and probes the CLI half with each name, making a divergence a failure.

### Patch Changes

- 14b1d2d: Give every voice template a one-click new-conversation control. The three templates that pass a custom `component:` render no `<Controls>`, so dispatch-center and retail had no way back to a fresh conversation without going through the start screen; each now carries its own button, and infocom-adventure's [N]ew Game deals a new game in one click with [Q]uit keeping the hang-up. A new case in template-page-mount.test.ts holds the line.
- Updated dependencies [36a3f22]
- Updated dependencies [0718b57]
- Updated dependencies [165f9b2]
- Updated dependencies [36a3f22]
- Updated dependencies [fe3b6d6]
- Updated dependencies [6bbef9b]
- Updated dependencies [63e1c8e]
- Updated dependencies [36a3f22]
- Updated dependencies [f10b6aa]
- Updated dependencies [623a8bb]
- Updated dependencies [7ab47cf]
- Updated dependencies [36a3f22]
- Updated dependencies [36a3f22]
- Updated dependencies [31459e8]
  - @alexkroman1/aai@11.0.0
  - @alexkroman1/aai-runtime@11.0.0
  - @alexkroman1/aai-ui@11.0.0

## 10.0.1

### Patch Changes

- Updated dependencies [f35bdf7]
  - @alexkroman1/aai-runtime@10.0.1
  - @alexkroman1/aai@10.0.1
  - @alexkroman1/aai-ui@10.0.1

## 10.0.0

### Major Changes

- dd699c7: Delete the DevKit's build pipeline. `aai build` no longer compiles a `workflows/` directory or embeds `__aaiWorkflowCode`/`__aaiStepCode`, and `workflow` leaves the CLI and the scaffold.

### Patch Changes

- dd699c7: Report the two bundler-config invariants in `buildWorker` as named `InvariantViolation`s rather than generic errors, so a Vite output shape this module's own config makes impossible is distinguishable from a build failure a user can act on.
- dd699c7: Fix three `aai dev` defects: the Vite proxy's `/workflows` prefix no longer swallows the project's own `workflows/` source directory (a file that exists on disk is served by Vite, everything else still proxies to the agent server), Vite binds the same loopback address the backend does instead of resolving `localhost` to IPv6-only, and `aai workflow` takes `--agent <url>` to target a server you are running yourself — with an undeployed project now naming that instead of asking you to log in.
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
  - @alexkroman1/aai-ui@10.0.0

## 9.2.0

### Patch Changes

- Updated dependencies [1ad4977]
- Updated dependencies [bee46bc]
- Updated dependencies [1e5170a]
  - @alexkroman1/aai@9.2.0
  - @alexkroman1/aai-runtime@9.2.0
  - @alexkroman1/aai-ui@9.2.0

## 9.1.0

### Patch Changes

- Updated dependencies [041a5a2]
  - @alexkroman1/aai@9.1.0
  - @alexkroman1/aai-runtime@9.1.0
  - @alexkroman1/aai-ui@9.1.0

## 9.0.2

### Patch Changes

- Updated dependencies [dcb2050]
- Updated dependencies [cc317e4]
  - @alexkroman1/aai-runtime@9.0.2
  - @alexkroman1/aai@9.0.2
  - @alexkroman1/aai-ui@9.0.2

## 9.0.1

### Patch Changes

- Updated dependencies [533e217]
- Updated dependencies [533e217]
  - @alexkroman1/aai-runtime@9.0.1
  - @alexkroman1/aai@9.0.1
  - @alexkroman1/aai-ui@9.0.1

## 9.0.0

### Minor Changes

- af284a7: Add `aai dev --watch`. File watching was reachable only through an undocumented AAI_DEV_WATCH variable, while the guide shipped into every scaffolded project promised hot reload.
- b386453: Add `aai storage enable --tier <storage|workflow>`, so an agent with no durable workflows is provisioned with a smaller per-role Postgres connection entitlement (4 rather than 10). Re-running with a different tier reconciles an existing database's limit without rotating the credential the resident guest is holding.

### Patch Changes

- 98be232: Pay down escape-hatch and conditional-spread debt: a typed fake session socket in the guest harness replaces eight `as never` casts and lets `lazyRuntime` drop its `as unknown as WebSocket`, `handleNotification` now takes the unvalidated frame shape it actually defends against, and nineteen truthiness-guarded conditional spreads over optional identifiers become `omitUndefined` — which also makes a session resume pass `resumeFrom` on the same test the runtime logs `resumed` with.
- 841f460: `aai test` now names the project spec files it did not run, instead of skipping them silently — a scaffolded `retail` project reported 67 passing tests while 211 of its 278 never ran.
- 044236f: Make a deployed agent's session state durable, and stop reporting an absent run as a server error. The runtime read the platform pair (`AAI_PUBLIC_BASE_URL`/`AAI_GUEST_TOKEN`) out of the AGENT's env, where the platform never puts it, so every deployed agent fell back to the memory backend and a session did not survive its sandbox restarting; uploads fell back to local for the same reason. A 404 from platform run storage now becomes the DevKit's own `WorkflowRunNotFoundError`, so GET/DELETE/wake on an unknown run answer 404/`cancelled:false`/`woken:0` instead of 500. The browser client reports a refusal close's own reason instead of discarding it, and a dev-mode `aai init` pins the third-party deps it shares with the linked workspace so two copies of xstate cannot fail the typecheck gate.
- af284a7: Pin `reporters: ["default"]` in the scaffolded project's vitest config, so a coding agent running `aai test` still sees a passing test's console output.
- 841f460: aai test now names unrun spec files even when there is no agent.test.ts
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
- Updated dependencies [7dd348f]
- Updated dependencies [01046b6]
- Updated dependencies [841f460]
- Updated dependencies [b238ba0]
- Updated dependencies [6796ae3]
- Updated dependencies [5bac92d]
- Updated dependencies [841f460]
- Updated dependencies [9e41442]
- Updated dependencies [841f460]
- Updated dependencies [18dfb1c]
- Updated dependencies [13b610f]
- Updated dependencies [044236f]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [95be1ca]
- Updated dependencies [c871232]
- Updated dependencies [857c3d9]
- Updated dependencies [6796ae3]
- Updated dependencies [6d360a7]
- Updated dependencies [841f460]
- Updated dependencies [af284a7]
- Updated dependencies [4743746]
- Updated dependencies [444e209]
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
  - @alexkroman1/aai-ui@9.0.0

## 8.2.1

### Patch Changes

- b9d9098: aai publish: honor --skipTypecheck end-to-end (it was silently ignored — the in-sandbox deploy always type-checked), and fail with the real reason when the entry agent.ts is dropped for exceeding the file cap instead of a later "No agent.ts found".
- @alexkroman1/aai@8.2.1
  - @alexkroman1/aai-runtime@8.2.1
  - @alexkroman1/aai-ui@8.2.1

## 8.2.0

### Patch Changes

- Updated dependencies [690a623]
- Updated dependencies [690a623]
  - @alexkroman1/aai-runtime@8.2.0
  - @alexkroman1/aai@8.2.0
  - @alexkroman1/aai-ui@8.2.0

## 8.1.0

### Patch Changes

- Updated dependencies [2f899e1]
- Updated dependencies [1789a55]
  - @alexkroman1/aai@8.1.0
  - @alexkroman1/aai-runtime@8.1.0
  - @alexkroman1/aai-ui@8.1.0

## 8.0.0

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

## 7.0.0

### Patch Changes

- 8c2190f: Link @alexkroman1/aai-runtime to the working tree in dev-mode `aai init`, and emit a JSON result for an unknown option in JSON mode.
- 6fadb69: Templates: dispatch-center, retail and solo-rpg now declare their dialog order with dialog() instead of prose plus hand-rolled guards. retail's requiresAuth boolean becomes a per-tool when, and the transfer to a human is a terminal state so every tool refuses afterwards — which the policy asked for and nothing enforced. solo-rpg drops the redundant phase field, gates the roll tools on a character existing, makes burn_momentum's burn window a state rather than a null check, and makes game over final. dispatch-center gates its six mutating incident and resource tools on something having been logged, and every converted tool's result now carries the position it landed in and what that position expects next.
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
- 3b3b833: Fail the workflow build when the flow bundle would require a Node builtin, instead of deploying a workflow that dies at replay with `require is not defined`
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
- Updated dependencies [d98169a]
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

## 6.11.0

### Minor Changes

- 1334239: Add the call-audit template: a workflow app with ffmpeg on both sides of the model. It levels any recording with a two-pass loudnorm, maps its pauses with silencedetect, cuts the transcription fan-out inside those pauses rather than every 90 seconds (so there is no segment overlap and no seam-stitching), and masters the spoken audit to MP3. transcription-workflow's classic flow now converts non-PCM recordings itself instead of telling the caller to run ffmpeg, so an m4a off a phone works.

### Patch Changes

- 9c73674: Fix the scaffold's SIGINT/SIGTERM handler crashing on shutdown. `server.mjs` registered an `async` listener with `process.once`, and `process` discards what a listener returns — so a `server.close()` that rejected became an unhandled rejection, i.e. a stack trace and a nonzero exit on Ctrl-C instead of the clean shutdown the handler exists for. The listener is synchronous now and reports a failed shutdown on its own. Every project `aai init` created carries the old handler; `biome.json` excludes `**/scaffold`, so no linter could have caught it.
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
  - @alexkroman1/aai-ui@6.11.0

## 6.10.1

### Patch Changes

- Updated dependencies [5556ed5]
  - @alexkroman1/aai@6.10.1
  - @alexkroman1/aai-ui@6.10.1

## 6.10.0

### Patch Changes

- Updated dependencies [1a76804]
  - @alexkroman1/aai@6.10.0
  - @alexkroman1/aai-ui@6.10.0

## 6.9.1

### Patch Changes

- Updated dependencies [9d45c1e]
  - @alexkroman1/aai@6.9.1
  - @alexkroman1/aai-ui@6.9.1

## 6.9.0

### Patch Changes

- Updated dependencies [ebd3c39]
- Updated dependencies [203c2d4]
- Updated dependencies [bbde9f9]
- Updated dependencies [a8e74a9]
  - @alexkroman1/aai-ui@6.9.0
  - @alexkroman1/aai@6.9.0

## 6.8.0

### Patch Changes

- Updated dependencies [c7bb199]
  - @alexkroman1/aai-ui@6.8.0
  - @alexkroman1/aai@6.8.0

## 6.7.2

### Patch Changes

- Updated dependencies [7f2637c]
- Updated dependencies [088eee6]
  - @alexkroman1/aai@6.7.2
  - @alexkroman1/aai-ui@6.7.2

## 6.7.1

### Patch Changes

- Updated dependencies [c46dac6]
  - @alexkroman1/aai@6.7.1
  - @alexkroman1/aai-ui@6.7.1

## 6.7.0

### Patch Changes

- 54fe7b1: Show the transcription template's total latency: the transcription-workflow desk now times each submission from the press of Transcribe to the finished run — across the upload and the run alike — and prints the split against the run's own elapsed, so the three modes can be compared on the number a reader actually waits for.
- Updated dependencies [9882411]
  - @alexkroman1/aai@6.7.0
  - @alexkroman1/aai-ui@6.7.0

## 6.6.0

### Patch Changes

- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
  - @alexkroman1/aai@6.6.0
  - @alexkroman1/aai-ui@6.6.0

## 6.5.1

### Patch Changes

- Updated dependencies [58788ee]
- Updated dependencies [e2c2cda]
- Updated dependencies [153264f]
- Updated dependencies [153264f]
  - @alexkroman1/aai@6.5.1
  - @alexkroman1/aai-ui@6.5.1

## 6.5.0

### Patch Changes

- Updated dependencies [4da4327]
- Updated dependencies [4da4327]
  - @alexkroman1/aai@6.5.0
  - @alexkroman1/aai-ui@6.5.0

## 6.4.0

### Patch Changes

- 5288539: Scale the transcription template's segment fan-out by BYTES in flight, and raise it from 8 to 32 for ordinary formats. A `503` from the sync endpoint says `queue wait timed out; server at capacity` — requests queue rather than being refused, and one fails only when it waited out the queue's deadline — so the fan-out is limited by total work in flight, which at this segment length is dominated by upload bytes. Measured against one account: 320 concurrent 5-second clips (51 MB) and 64 concurrent 92-second 16 kHz mono segments (188 MB) both drew zero `503`s, while the same 5,888 audio-seconds at 48 kHz stereo (1.13 GB) drew 20, and 320 small requests summing to 941 MB drew 64. So neither the request count nor the audio duration is the cap; admitted bytes land at 753-883 MB across request counts differing 5x. `BYTES_IN_FLIGHT` is 640 MB and `segmentConcurrency(format)` divides it, clamped at 32 — the measured wall-clock knee (27.5s against 43.3s at 8 over 1h37m of audio), past which 48 pays retries and 64 is slower. A fixed 32 was safe only for the format it was measured on: the same width is 565 MB of 48 kHz stereo and 1.28 GB at the segment-size ceiling.
- Updated dependencies [5288539]
  - @alexkroman1/aai@6.4.0
  - @alexkroman1/aai-ui@6.4.0

## 6.3.1

### Patch Changes

- Updated dependencies [dd29277]
  - @alexkroman1/aai@6.3.1
  - @alexkroman1/aai-ui@6.3.1

## 6.3.0

### Patch Changes

- Updated dependencies [b04af38]
- Updated dependencies [2e103d8]
  - @alexkroman1/aai@6.3.0
  - @alexkroman1/aai-ui@6.3.0

## 6.2.0

### Patch Changes

- Updated dependencies [295e8db]
  - @alexkroman1/aai@6.2.0
  - @alexkroman1/aai-ui@6.2.0

## 6.1.0

### Patch Changes

- Updated dependencies [c4791cc]
- Updated dependencies [c4791cc]
- Updated dependencies [296b6c3]
  - @alexkroman1/aai@6.1.0
  - @alexkroman1/aai-ui@6.1.0

## 6.0.0

### Major Changes

- e923c72: Rename the four `-desk` templates. The three that declare a durable workflow become `recap-workflow`, `research-workflow` and `transcription-workflow`, so the suffix says what the template demonstrates. `plan-desk` becomes `plan-and-execute` rather than `plan-workflow`: it declares no workflow at all — it is the LangGraph plan-and-execute port, a voice agent whose loop is driven one tool call at a time — so naming it after a mechanism it does not use would mislead, and naming it after the pattern it ports is what a reader arriving with that mental model will look for. `aai init -t <name>` and the studio's starter list take the new names; the agents' spoken greetings still say "desk", which is a thing a caller reaches rather than a template name.

### Minor Changes

- d5667c4: aai build and aai deploy now compile a project's workflows/ directory into the two artifacts a guest needs to run durable workflows, with the Workflow DevKit left external so both stay small enough to ride the agent bundle.
- 8cb603d: Self-hosting runs the built worker, and a template's `tools/` reach a user's own project.
  
  `npm start` now builds first (a `prestart` script) and `server.mjs` boots
  `.aai/worker.mjs` — the same artifact `aai publish` uploads — instead of importing
  `agent.ts`. A tool is registered by existing, and that enumeration happens where the
  bundle is assembled, so the old entrypoint served an agent with none of its tools and
  no error anywhere. `aai build` therefore leaves its worker on disk, `aai eject` writes
  `prestart` alongside `start`, and the `registerHooks` shim is gone (the bundle inlines
  the `?raw` and attribute-less JSON imports it existed to teach Node).
  
  Fixes five templates — `pizza-ordering`, `plan-and-execute`, `retail`, `support-line`,
  `travel-concierge` — whose specs imported a monorepo-internal path that does not exist
  in a scaffolded project, breaking `aai test` and `aai build` for anyone who scaffolded
  them. `@alexkroman1/aai/testing` gains **`withDiscoveredTools(def, modules)`**, which is
  how a spec in any project gets the def a deployed agent runs:
  
  ```ts
  const agentDef = withDiscoveredTools(authored, import.meta.glob("./tools/*.ts", { eager: true }));
  ```
  
  Removes the unused `loadToolModules` from `@alexkroman1/aai/manifest`: there is one way
  to build a tool registry, over already-loaded modules, and no runtime directory scan.
- 8cb603d: A file in `tools/` is now the tool. Tool files default-export their tool and are discovered at build time — `worker-bundler.ts` enumerates `tools/*.ts` and emits static imports, so a file that exists is a tool the model can call and there is no registration step to forget. Forgetting a `tools:` map line used to be silent: the file compiled, every check passed, and the tool never reached the model. The six shipped templates drop 62 map entries and their imports; `toolRegistry`/`withTools` (`@alexkroman1/aai/manifest`) own the name grammar, the default-export requirement, the flat-only rule and duplicate detection, each a build error naming the file. Retires the `template-tools` konsistent convention, which checked an export name nothing reads any more.
- c46e8ad: Add four templates ported from popular LangChain/LangGraph agents. Three are voice agents: travel-concierge (the customer-support bot's specialist-desk delegation, with every booking staged for a spoken confirmation before it applies), support-line (self-RAG/CRAG document grading, query rewriting and a groundedness check before anything is said out loud), and plan-and-execute (plan-and-execute, one step per tool call so the caller can redirect between them, with real web search in the executor). The fourth, redline, is a workflow app: the reflection agent's write/critique/revise loop as a page over a durable run, exiting on the critic's journaled verdict.

### Patch Changes

- d764fc6: The workflow step bundle carries a `createRequire` shim, so a step importing a package with a CommonJS dependency loads instead of throwing `Dynamic require of "node:assert" is not supported` before its first line runs.
- f086dfe: Simplify the three workflow templates: research-workflow types its run snapshot with WorkflowOutputOf, transcription-workflow drops two single-use result types and a hand-rolled hash, and every file step now agrees on one shape.
- 549b5db: Proxy the workflow HTTP API and dedupe React in `aai dev`, so a `page: "static"` workflow app works locally
- 16bec88: Workflow hooks report a failure's own message rather than `[object Object]` when a rejection is message-bearing without being an `Error` — `useWorkflowRun` and `useWorkflows`/`useWorkflowSubmit` now unwrap it with the SDK's `errorMessage` instead of a local `instanceof Error` ternary.
- e923c72: Enforce the two flatness rules that were documented and unenforced. A nested tool file (`tools/billing/refund.ts`) was SKIPPED by a one-level readdir, so the project built an agent with none of its tools and no error anywhere; discovery is recursive now and `toolRegistry` rejects the nested path naming the file, keeping one implementation of the rule. A `system-prompt/` DIRECTORY fell through to the framework default with nothing saying why the prompt had no effect; it is refused, naming the file to rename it to. Both were verified broken before the fix — the same silent absence discovery exists to kill, arriving through the discoverer rather than the registry.
- Updated dependencies [d81c752]
- Updated dependencies [4afb67c]
- Updated dependencies [0e99e1d]
- Updated dependencies [ae9e607]
- Updated dependencies [3df649f]
- Updated dependencies [263d86a]
- Updated dependencies [9fe4d07]
- Updated dependencies [b5fdd60]
- Updated dependencies [8c3c835]
- Updated dependencies [a9497a3]
- Updated dependencies [e923c72]
- Updated dependencies [8cf6ffa]
- Updated dependencies [3df649f]
- Updated dependencies [d325a71]
- Updated dependencies [a9497a3]
- Updated dependencies [0f7c4da]
- Updated dependencies [e923c72]
- Updated dependencies [d5667c4]
- Updated dependencies [0f7c4da]
- Updated dependencies [49ac025]
- Updated dependencies [f086dfe]
- Updated dependencies [d2a6b0d]
- Updated dependencies [0c411f4]
- Updated dependencies [d764fc6]
- Updated dependencies [d764fc6]
- Updated dependencies [cd03641]
- Updated dependencies [714cb82]
- Updated dependencies [eb0da5f]
- Updated dependencies [5e568e0]
- Updated dependencies [304347b]
- Updated dependencies [f037d0b]
- Updated dependencies [50282d6]
- Updated dependencies [6182917]
- Updated dependencies [0f7c4da]
- Updated dependencies [8ecbe38]
- Updated dependencies [02d90e3]
- Updated dependencies [9f74c34]
- Updated dependencies [61c6630]
- Updated dependencies [16bec88]
- Updated dependencies [97339d9]
- Updated dependencies [742bebf]
- Updated dependencies [c48f243]
- Updated dependencies [d5667c4]
- Updated dependencies [16bec88]
- Updated dependencies [e4fd8c5]
  - @alexkroman1/aai@6.0.0
  - @alexkroman1/aai-ui@6.0.0

## 5.14.0

### Patch Changes

- 66b588a: Fix `aai init` failing at its install step under pnpm's release-age quarantine (`minimumReleaseAge`, on by default in pnpm 11). The scaffold pins the newest SDK release and this repo publishes several times a day, so no version satisfying the pinned range was ever old enough to clear the window and resolution failed outright. The scaffolded `pnpm-workspace.yaml` now exempts `@alexkroman1/*` from the quarantine, leaving every third-party dependency under whatever window the user configured.
- Updated dependencies [df41665]
- Updated dependencies [24e8178]
  - @alexkroman1/aai@5.14.0
  - @alexkroman1/aai-ui@5.14.0

## 5.13.2

### Patch Changes

- Updated dependencies [4ba7ab3]
  - @alexkroman1/aai-ui@5.13.2
  - @alexkroman1/aai@5.13.2

## 5.13.1

### Patch Changes

- Updated dependencies [7e92c96]
  - @alexkroman1/aai@5.13.1
  - @alexkroman1/aai-ui@5.13.1

## 5.13.0

### Patch Changes

- Updated dependencies [5cfe26b]
- Updated dependencies [90e5c15]
- Updated dependencies [cdc8e54]
- Updated dependencies [db4b0fb]
- Updated dependencies [ce45435]
- Updated dependencies [cdc8e54]
  - @alexkroman1/aai@5.13.0
  - @alexkroman1/aai-ui@5.13.0

## 5.12.0

### Minor Changes

- c49f501: Run the credential preflight and a bundle smoke test in the CLI at deploy time. The platform no longer extracts or stores an agent config, so aai deploy now imports the worker it just built: a bundle whose top level throws fails in your project directory instead of as a sandbox that never starts, and missing provider credentials are reported as a warning naming the keys. Deploys also send the agent name as a slug hint.
- c49f501: Export the CLI's project-config writers as a public subpath (`@alexkroman1/aai-cli/project-config`), so the studio guest's Publish stops hand-writing the config home and the `.aai/project.json` pin with JSON.stringify. One writer per on-disk format keeps the 0600 atomic-rename write and the pin's merge semantics.

### Patch Changes

- 42cf8ab: aai test now requires an agent project like every other project-scoped command: it was the one calling setup() without the agent guard, so in a directory with no agent.ts it found no test file, reported passed/skipped and exited 0 — a green result for a project that isn't there. And JSON mode now keeps its one-result-line stdout contract on citty's own argument errors: a missing positional or an unknown subcommand wrote a human usage block to stdout and no JSON at all, which is the normal scripted case since JSON mode is auto-detected on a pipe. The specific reason still goes to stderr, and --help is still the human block whatever the mode.
- 42cf8ab: aai dev no longer breaks JSON mode's one-result-line stdout contract: the SDK's default logger is console-backed and console.log is stdout, so the runtime's own diagnostics (the multi-line Session mode resolved dump at startup, every later warning) landed above the single JSON line. JSON mode is auto-detected on a pipe, so that was the normal case — aai dev > dev.log, a process supervisor, a container. The runtime now logs through a logger the command chooses, which writes to stderr with its structured context intact once output is silenced; human mode keeps the console logger untouched.
- db3fb48: Keep a failed log write from taking the dev server down: reporting a successful restart no longer sits inside the listen try/catch, where a throwing notifier (stderr closed by a piped `aai dev`) was reported as a failed listen and tore down a server that had already bound.
- c49f501: aai secret and aai publish now set secrets on a linked project's preview agent as well as its production one, matching what the studio's Secrets panel already did. Previously a key set from the CLI reached production alone, so the preview agent the same publish created failed at its first session.
- Updated dependencies [db3fb48]
- Updated dependencies [42cf8ab]
- Updated dependencies [c49f501]
- Updated dependencies [db3fb48]
- Updated dependencies [a91c3bc]
- Updated dependencies [db3fb48]
- Updated dependencies [c49f501]
- Updated dependencies [9fded19]
- Updated dependencies [348fa16]
- Updated dependencies [db3fb48]
- Updated dependencies [9fded19]
  - @alexkroman1/aai@5.12.0
  - @alexkroman1/aai-ui@5.12.0

## 5.11.0

### Minor Changes

- 678acea: Scaffold a self-hosted `server.mjs` and an `npm start` script into every
  project, so any agent runs on your own infrastructure without the CLI, a
  bundler, or a platform account. Adds `aai eject` to retrofit both into
  projects created before this.

### Patch Changes

- f06e2b7: Print the visible project list when `aai pull` finds no such studio project, so a login scoped to the wrong account names itself instead of looking like a missing project.
- Updated dependencies [e8d5e15]
  - @alexkroman1/aai@5.11.0
  - @alexkroman1/aai-ui@5.11.0

## 5.10.1

### Patch Changes

- f941665: Install pnpm with npm in the Modal service image instead of corepack. Node stopped shipping corepack in its official distributions at 25, so the 24 to 26 base-image bump broke every deploy at the first build step with 'corepack: not found' (exit status 127). aai init's dependency-install failure now points at npm install -g pnpm rather than a corepack command that does not exist on Node 25+.
  - @alexkroman1/aai@5.10.1
  - @alexkroman1/aai-ui@5.10.1

## 5.10.0

### Patch Changes

- b037dd6: Enable the V8 compile cache for the aai bin and drop the redundant --experimental-strip-types NODE_OPTIONS from aai test; pass --singleThreaded to project typechecks (~2x faster under a one-core reservation).
- d569226: Serialize global-config updates across processes so a concurrent command can no longer discard the API key `aai login` just saved, and surface `aai dev` rebuild failures on stderr instead of silencing them when stdout is a pipe.
- fbccb3e: Forward an optional retryDelay through DeleteOpts so retry-path tests don't sleep real wall-clock time
- Updated dependencies [b125465]
- Updated dependencies [1731876]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [fb7b545]
- Updated dependencies [b125465]
- Updated dependencies [c7617df]
- Updated dependencies [b125465]
- Updated dependencies [520900f]
- Updated dependencies [b125465]
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
  - @alexkroman1/aai-ui@5.10.0

## 5.9.0

### Minor Changes

- f5e2c54: Require `aai login`: an exported ASSEMBLYAI_API_KEY no longer authenticates the CLI. Non-interactive callers point AAI_CONFIG_DIR at a config dir holding a logged-in key; in a project the variable stays a provider credential for `aai dev`.

### Patch Changes

- @alexkroman1/aai@5.9.0
- @alexkroman1/aai-ui@5.9.0

## 5.8.1

### Patch Changes

- 3ddfbfc: aai pull merges the scaffold's package.json under the pulled workspace's own, so a pulled studio project installs the toolchain (vite, @vitejs/plugin-react, @tailwindcss/vite) its vite.config.ts imports instead of failing on the first aai dev.
  - @alexkroman1/aai@5.8.1
  - @alexkroman1/aai-ui@5.8.1

## 5.8.0

### Patch Changes

- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
  - @alexkroman1/aai@5.8.0
  - @alexkroman1/aai-ui@5.8.0

## 5.7.0

### Minor Changes

- 56efab9: Require `aai login` (or ASSEMBLYAI_API_KEY) instead of prompting for a pasted key, and name the server when login can't reach it

### Patch Changes

- 56efab9: Never resolve the developer's real global config dir under vitest, and isolate the config dir for CLIs the e2e suite spawns
- 56efab9: Skip non-UTF-8 files on push and workspace sync instead of silently corrupting them
- 56efab9: Report skipped files in JSON results, clear the studio link on delete, reject unknown flags, and unwrap nested server errors
- 56efab9: Validate the repo-controlled slug in .aai/project.json for every command, not just the slug-scoped ones
- Updated dependencies [56efab9]
- Updated dependencies [1c034af]
  - @alexkroman1/aai@5.7.0
  - @alexkroman1/aai-ui@5.7.0

## 5.6.0

### Minor Changes

- dd90edc: Guard the `-preview` slug suffix at the deploy boundary. That suffix is owned by the studio's auto-preview deploys and reaped hourly by the orphan-preview sweep, so a CLI caller that claimed it by accident would lose the agent — and any app-database data — on a schedule no redeploy could undo. `aai deploy` now rejects a requested `*-preview` slug unless the new `--allow-preview-slug` flag is passed (set only by the studio's own in-guest deploy).
- 5cd6d50: Replace Supabase magic-link email sign-in with GitHub OAuth, and rework `aai login` as a device-link flow: the CLI no longer signs in (or creates accounts) itself — it opens the studio with a one-shot link code that a signed-in browser session approves, then exchanges the code for the account's stored API key. The `GET /studio/account/key` route is removed in favor of the one-shot exchange.
- 29fa487: The CLI and the studio are now one workflow: new `aai list`, `aai pull`, `aai push`, and `aai publish` commands round-trip a project's source through its studio workspace (fast-forward-checked pushes, scaffold-completed pulls), `aai delete` deletes the studio project with a server-side cascade to its deployed agents, and the user-facing `aai deploy` command is gone — production deploys run exclusively through the studio's Publish path (the hidden `deploy` subcommand remains as the internal mechanism the project sandbox executes). `.env` values now sync as agent secrets during `aai publish`.

### Patch Changes

- e2a473a: Harden the aai login device link: the terminal and the browser approval gate now show a matching confirmation code (a phished approval link has a visible mismatch), and the studio stashes the ?cli-link code in per-tab sessionStorage and strips it from the URL at page load so it never rides the GitHub OAuth redirect chain.
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [753665a]
- Updated dependencies [77b0a80]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [8b622e8]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [8b622e8]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [77b0a80]
  - @alexkroman1/aai@5.6.0
  - @alexkroman1/aai-ui@5.6.0

## 5.5.1

### Patch Changes

- Updated dependencies [1a6f800]
  - @alexkroman1/aai@5.5.1
  - @alexkroman1/aai-ui@5.5.1

## 5.5.0

### Minor Changes

- ae89dd9: Email login via Supabase Auth, for the studio and the CLI. The studio's browser bearer is now a session token (magic-link sign-in) resolved server-side to the user's stored AssemblyAI key (`user-key:<uid>` in Vault); connecting that key is the mandatory onboarding step after sign-in — every AssemblyAI key on the platform is user-provided, and the browser never holds one. `aai login` drives the same flow from the terminal via Supabase email OTP and saves the fetched key in the CLI config. A dev-token auth implementation keeps local dev Supabase-free. The guest chat surface is gated by a broker-minted per-session token instead of the caller's key. Slug-ownership hashes drop argon2id for plain SHA-256 digests (high-entropy machine keys need no slow hash), removing `@node-rs/argon2` and the verify cache. Raw API-key bearers keep working on every route.
- cecafd3: Add the retail agent template: a 15-tool port of the tau2-bench retail domain with a syncState-driven customer-file UI.

### Patch Changes

- e7a6f43: Retail template: pin the layout to the viewport so the Hold/End call controls stay visible instead of scrolling off-screen
- Updated dependencies [a57905b]
- Updated dependencies [030b55f]
- Updated dependencies [966aeed]
- Updated dependencies [6cca475]
- Updated dependencies [d303cfb]
- Updated dependencies [41d53ae]
  - @alexkroman1/aai@5.5.0
  - @alexkroman1/aai-ui@5.5.0

## 5.4.0

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

## 5.3.0

### Patch Changes

- a9ff1d1: Document StartScreen as a wrapper component in the scaffold authoring guide: it requires `children`, and writing it self-closing is a TS2741 build error. Adds a minimal client.tsx example alongside the component table.
- Updated dependencies [27c5963]
- Updated dependencies [27c5963]
  - @alexkroman1/aai@5.3.0
  - @alexkroman1/aai-ui@5.3.0

## 5.2.0

### Minor Changes

- be1ed53: Ship the agent templates inside the CLI tarball instead of fetching them from GitHub at init time. `aai init` now works offline, and templates are pinned to the installed CLI version rather than tracking `main`. This also puts them inside the studio's guest sandbox, where the coding agent can read them for worked examples.

### Patch Changes

- @alexkroman1/aai@5.2.0
- @alexkroman1/aai-ui@5.2.0

## 5.1.1

### Patch Changes

- ded8b64: Internal cleanup of the CLI: shared slug-scoped API request helper (secret/storage now share the not-deployed 404 hint), shared package-bin resolution, aai build moved to its own entry point owning the test/typecheck gates, single source for the agent.ts entry name and repo URL, and assorted dead-weight removal (duplicated error helpers, copy-paste spinner branches, misleading lazy import in the dev server).
- Updated dependencies [e47a187]
- Updated dependencies [b829155]
- Updated dependencies [ab577dc]
  - @alexkroman1/aai-ui@5.1.1
  - @alexkroman1/aai@5.1.1

## 5.1.0

### Patch Changes

- Updated dependencies [8fb0a0d]
- Updated dependencies [ac21a90]
- Updated dependencies [3bc83bb]
  - @alexkroman1/aai@5.1.0
  - @alexkroman1/aai-ui@5.1.0

## 5.0.1

### Patch Changes

- Updated dependencies [fb4c14c]
  - @alexkroman1/aai-ui@5.0.1
  - @alexkroman1/aai@5.0.1

## 5.0.0

### Major Changes

- 9867aa3: Simplify the build pipeline: one Vite worker bundler for dev/deploy/studio (the Rolldown dev fast-path is gone), workers self-describe their config via a generated \_\_aaiConfig wrapper entry and the platform extracts it in a guest sandbox at deploy time (the deploy body no longer carries agentConfig, and 'aai deploy' no longer evaluates agent code on the host), and raw-text imports now use Vite's native ?raw suffix — update 'import prompt from "./x.md"' to 'import prompt from "./x.md?raw"'.

### Minor Changes

- cc71fab: Workers ship their own SDK runtime, and all studio builds run in the guest sandbox through the aai CLI's bundlers.

  - `buildWorker`'s wrapper entry now bundles the user's installed SDK runtime behind an `__aaiCreateRuntime` export; the guest harness builds sessions through that factory and embeds no runtime of its own, so platform SDK drift can no longer break deployed agents. Bundles without the factory are rejected at `bundle/load`.
  - The studio's out-of-process build subsystem (build runner/entry/protocol/cache, the import-allowlist worker build, the host client build, and the `studio_build` Modal Function) is deleted. `test_agent` builds the live workspace in the guest; Publish builds via the new host→guest `workspace/build` RPC, which also returns the bundle's config self-description — no throwaway inspection sandbox on the studio path.
  - The guest snapshot image now bakes the build toolchain (`@alexkroman1/aai-cli` + workspace-facing packages) next to the harness; versions derive from aai-guest's own dependencies.
  - `MAX_WORKER_SIZE` rises to 30 MB; `evalWorkerBundle` imports workers via a temp `file:` URL (the bundled runtime's CJS interop rejects `data:` URLs); the dev server opts out of runtime inlining to keep watch rebuilds fast.
  - Studio Publish now runs the literal `aai deploy` CLI inside the project's sandbox (`workspace/deploy`), and the CLI's output is posted into the chat so the coding agent sees deploy errors. `aai deploy` gains `--allow-missing-secrets` (server-side `credentialPolicy: "warn"` in the deploy body), and deploy responses now carry preflight `warnings`.
  - The studio's storage toggle and routes are removed — storage is CLI-only (`aai storage enable`). Deployed-agent secrets move to their own Secrets panel backed by the platform's `/:slug/secret` routes; every change posts a note into the chat (key names only).
  - `aai build` and `aai deploy` now type-check the project (`tsc --noEmit` with its own tsconfig and compiler; `--skipTypecheck` opts out), as does the studio's `test_agent`. Studio workspaces are completed into real projects in the guest (package.json, tsconfig.json, global.d.ts, vite.config.ts — scaffold-mirroring, existing files win).

### Patch Changes

- 0c2bdbd: Scaffolded projects get a vitest.config.ts separate from vite.config.ts, so running tests no longer depends on the client build's plugin imports resolving, and globals work with or without an explicit vitest import.
- 5a599b2: The build/deploy typecheck gate now resolves TypeScript from the project's own node_modules by walking up, instead of `require.resolve`, which also consulted Node's global paths (NODE_PATH, ~/.node_modules) and so could typecheck a project against a compiler it never declared.
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
- Updated dependencies [30914c9]
- Updated dependencies [0c2bdbd]
- Updated dependencies [0c2bdbd]
- Updated dependencies [01cecc1]
- Updated dependencies [d4c2a10]
- Updated dependencies [0c2bdbd]
- Updated dependencies [e8fef4b]
- Updated dependencies [293da11]
- Updated dependencies [e8fef4b]
- Updated dependencies [30914c9]
- Updated dependencies [fdd64ef]
- Updated dependencies [0c2bdbd]
  - @alexkroman1/aai@5.0.0
  - @alexkroman1/aai-ui@5.0.0

## 4.0.0

### Patch Changes

- Updated dependencies [3e21af9]
- Updated dependencies [9ad4e51]
- Updated dependencies [b50b0e9]
- Updated dependencies [b50b0e9]
- Updated dependencies [577b17a]
- Updated dependencies [527c401]
- Updated dependencies [3125c8d]
  - @alexkroman1/aai@4.0.0
  - @alexkroman1/aai-ui@4.0.0

## 3.2.0

### Patch Changes

- Updated dependencies [9c9eadb]
- Updated dependencies [9c9eadb]
- Updated dependencies [9c9eadb]
- Updated dependencies [9c9eadb]
- Updated dependencies [9c9eadb]
  - @alexkroman1/aai@3.2.0
  - @alexkroman1/aai-ui@3.2.0

## 3.1.0

### Patch Changes

- Updated dependencies [369f950]
- Updated dependencies [1749ca4]
  - @alexkroman1/aai-ui@3.1.0
  - @alexkroman1/aai@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [bb02ded]
- Updated dependencies [2b395b3]
- Updated dependencies [d917095]
- Updated dependencies [08f2937]
- Updated dependencies [bb02ded]
- Updated dependencies [2236275]
- Updated dependencies [2236275]
- Updated dependencies [2236275]
- Updated dependencies [eb9f662]
- Updated dependencies [6cac47f]
  - @alexkroman1/aai@3.0.0
  - @alexkroman1/aai-ui@3.0.0

## 2.0.0

### Patch Changes

- Updated dependencies [377ecd3]
- Updated dependencies [e17fdc4]
- Updated dependencies [4051d7a]
- Updated dependencies [6047231]
- Updated dependencies [7fc476d]
- Updated dependencies [41b5dad]
- Updated dependencies [ed4f2e7]
- Updated dependencies [89a032d]
- Updated dependencies [158d5d5]
  - @alexkroman1/aai@2.0.0
  - @alexkroman1/aai-ui@2.0.0

## 1.16.0

### Patch Changes

- Updated dependencies [c261662]
- Updated dependencies [da2662a]
- Updated dependencies [5ea4cba]
  - @alexkroman1/aai@1.16.0
  - @alexkroman1/aai-ui@1.16.0

## 1.15.0

### Patch Changes

- Updated dependencies [9ffec74]
- Updated dependencies [f87ff84]
  - @alexkroman1/aai@1.15.0
  - @alexkroman1/aai-ui@1.15.0

## 1.14.0

### Patch Changes

- Updated dependencies [1c57e05]
- Updated dependencies [4469856]
- Updated dependencies [f389673]
  - @alexkroman1/aai@1.14.0
  - @alexkroman1/aai-ui@1.14.0

## 1.13.1

### Patch Changes

- Updated dependencies [f662e45]
  - @alexkroman1/aai@1.13.1
  - @alexkroman1/aai-ui@1.13.1

## 1.13.0

### Patch Changes

- Updated dependencies [2b3c0e0]
- Updated dependencies [cbb8b71]
  - @alexkroman1/aai@1.13.0
  - @alexkroman1/aai-ui@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [83be5b2]
- Updated dependencies [bd4405a]
  - @alexkroman1/aai@1.12.0
  - @alexkroman1/aai-ui@1.12.0

## 1.11.0

### Patch Changes

- fbcb755: Drop the direct esbuild dependency: the CLI now bundles with Rolldown end to end.

  - `aai dev`'s fast worker builds (`_dev-bundler.ts`) run on Rolldown — the native bundler Vite 8 itself uses, so the dependency dedupes to zero extra install weight. Fresh builds land in tens of ms, so the old incremental esbuild context is no longer needed; non-compile failures still fall back to the cold Vite path.
  - Deploy/studio worker minification switches from `minify: "esbuild"` (which loaded esbuild as Vite's optional peer) to Vite 8's native `"oxc"` minifier. The studio inherits this automatically via `@alexkroman1/aai-cli/worker-bundler`.
  - The scaffold keeps its pnpm build-script approval for esbuild: the CLI no longer pulls it in, but esbuild remains an optional peer of vite, so projects whose lockfile ever resolved it (upgrades from an older CLI) still install it and need its postinstall approved.

- Updated dependencies [310eedb]
- Updated dependencies [a6bb262]
- Updated dependencies [d72c86b]
- Updated dependencies [163cb6f]
  - @alexkroman1/aai@1.11.0
  - @alexkroman1/aai-ui@1.11.0

## 1.10.0

### Minor Changes

- 5dc18a2: Security, correctness, and CLI-behavior fixes from a full package review.

  Security hardening:

  - The global `config.json` (which stores the API key) is now written with
    `0600` permissions (dir `0700`); an existing world-readable config is
    tightened on the next write.
  - Loopback origins supplied by a repo's `.aai/project.json` are no longer
    implicitly trusted with the API key — approve them with `--server` like any
    other origin. Dev mode is unaffected.
  - The `slug` from `.aai/project.json` is validated against the platform slug
    shape before being interpolated into request paths, and
    `aai secret delete` URL-encodes the secret name.
  - `AAI_TEMPLATES_REF` is validated as a git-ref shape.

  Behavior fixes:

  - `ensureApiKey` fails fast with a clear error instead of prompting when
    there is no TTY (the hidden prompt used to swallow piped stdin — e.g. the
    secret value in `echo "$V" | aai secret put NAME --json` — and hang).
  - A typo'd flag (`aai -v`, `aai --hlep`) no longer silently triggers a
    production deploy; only a truly bare `aai` runs the default command, and an
    implicit deploy now asks for confirmation on a TTY.
  - `aai dev` no longer unconditionally demands an AssemblyAI key — the key is
    only requested when the agent's providers need it (`aai init --skip-api` is
    now a deprecated no-op; platform commands resolve the key after the
    server-trust check).
  - Deploy env semantics: an `ASSEMBLYAI_API_KEY` declared in `.env`
    deliberately wins over the CLI login key (the login key is a floor,
    matching the server's `defaultEnv` merge).
  - A deploy that succeeds but fails to write `.aai/project.json` now surfaces
    the slug loudly instead of reading as a failed deploy; a deploy failure
    during `aai init` warns and keeps the scaffolded project instead of failing
    the whole init.
  - `aai dev`: signal handlers install before startup so Ctrl-C during boot is
    clean; Vite uses `strictPort` so the printed URL can't point at the wrong
    server; the giget template extraction dir is cleaned up on success.

  Internals/deps: single `ensureApiKey` owner, `_delete.ts` merged into
  `delete.ts`, dead `sessionId` config field and unused `./types` subpath
  export removed, `dotenv` replaced by `node:util` `parseEnv`, `consola`
  replaced by `picocolors`, `execa` bumped to v10, zod kept off the CLI
  startup path.

### Patch Changes

- Updated dependencies [c147d23]
- Updated dependencies [3fe3eff]
- Updated dependencies [5ddca41]
- Updated dependencies [133642f]
- Updated dependencies [fec3fa2]
- Updated dependencies [678556f]
- Updated dependencies [8a5ee8f]
  - @alexkroman1/aai-ui@1.10.0
  - @alexkroman1/aai@1.10.0

## 1.9.2

### Patch Changes

- fff8cc1: Resolve React from the client build's root so publishing a UI works in the production image, where aai-ui's peer copy is pruned
  - @alexkroman1/aai@1.9.2
  - @alexkroman1/aai-ui@1.9.2

## 1.9.1

### Patch Changes

- Updated dependencies [713025a]
  - @alexkroman1/aai@1.9.1
  - @alexkroman1/aai-ui@1.9.1

## 1.9.0

### Minor Changes

- 882e7d9: Host mode now inherits the deployed agent's `stt`/`llm`/`tts` provider config, so a `?host=1` session runs the operator's configured pipeline (e.g. AssemblyAI Universal-3.5 Pro STT + LLM + TTS, with agent_context/voice_focus) with only the client's system prompt, greeting, and tools injected — instead of falling back to the default S2S path. The dev server passes its loaded agent as `hostBaseAgent`.
- e2ee4fd: Add voice-agent host mode: external clients can inject system prompt + tool schemas via config.host and receive tool calls to execute (tool_result), enabling harness-driven agents.

### Patch Changes

- 56e96b5: Simplify CLI internals: per-command API key gating (--help and aai test/build no longer prompt; --skip-api now effective), server URLs normalized against trailing slashes, deploy/getServerInfo share one resolution path, faster bundling (worker eval no longer waits on the client build; parallel file copies/reads), and remove duplicated template/deploy test scaffolding.
- 38a2553: Replace hand-rolled HTTP, retry, cache, and child-process plumbing with ofetch, p-retry + is-network-error, quick-lru, and execa
- 394867e: Fix a Cartesia TTS connect failure crashing the whole host process. `client.tts.websocket()` only returns the socket after connect resolves, so on a connect-time failure (e.g. the account is out of credits) the promise rejects before an `error` listener can be bound — and cartesia-js's `TTSEmitter._onError` does a bare `Promise.reject` (a fatal unhandled rejection) when the socket errors with no listener. The adapter now constructs `new TTSWS(client)` directly and binds the `error` listener before connecting, so the failure flows through the normal `tts_connect_failed` path and degrades only that session. As defense-in-depth, the `aai dev` host entry now installs a log-only `unhandledRejection` guard (mirroring aai-server).
- 82f8253: Faster dev/deploy loop: dev server builds the new server before closing the old one (failed builds keep serving), the file watcher ignores dot-directories like .git (while .env stays watched), deploy bundles are minified and gzip-compressed, and aai test runs the project-local vitest binary instead of npx.
- 578a840: dev: add uncaughtException guard so one bad session can't crash the whole host
- Updated dependencies [0235618]
- Updated dependencies [4758dfc]
- Updated dependencies [0f72bef]
- Updated dependencies [bc62b75]
- Updated dependencies [7e67c24]
- Updated dependencies [8817f3f]
- Updated dependencies [394867e]
- Updated dependencies [8004ff8]
- Updated dependencies [262f1e7]
- Updated dependencies [257a372]
- Updated dependencies [0bdb115]
- Updated dependencies [578a840]
- Updated dependencies [c5a5351]
- Updated dependencies [0235618]
- Updated dependencies [0235618]
- Updated dependencies [a252842]
- Updated dependencies [bbb9d73]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [a413caf]
- Updated dependencies [d718fe9]
- Updated dependencies [2898f21]
- Updated dependencies [882e7d9]
- Updated dependencies [e2ee4fd]
- Updated dependencies [9750db7]
- Updated dependencies [0d024e0]
- Updated dependencies [cb2821c]
- Updated dependencies [9aed108]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [ab38293]
- Updated dependencies [d718fe9]
- Updated dependencies [968c917]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [860bb7d]
- Updated dependencies [82f8253]
- Updated dependencies [d718fe9]
- Updated dependencies [7240ce5]
- Updated dependencies [f22b0f4]
- Updated dependencies [0bb1a20]
- Updated dependencies [7d4a193]
- Updated dependencies [5bf4d41]
- Updated dependencies [ad295be]
- Updated dependencies [d22d9f8]
- Updated dependencies [8f2093b]
- Updated dependencies [296a874]
- Updated dependencies [752af3d]
- Updated dependencies [38f02fa]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [82f8253]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [2fd1078]
- Updated dependencies [711edeb]
- Updated dependencies [fd5a54e]
- Updated dependencies [a413caf]
- Updated dependencies [3db093f]
- Updated dependencies [0c57887]
- Updated dependencies [79e51cb]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [0235618]
- Updated dependencies [cf56703]
- Updated dependencies [115a88e]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
  - @alexkroman1/aai@1.9.0
  - @alexkroman1/aai-ui@1.9.0

## 1.8.3

### Patch Changes

- Updated dependencies [6b61892]
  - @alexkroman1/aai-ui@1.8.3
  - @alexkroman1/aai@1.8.3

## 1.8.2

### Patch Changes

- Updated dependencies [bb06b4e]
  - @alexkroman1/aai@1.8.2
  - @alexkroman1/aai-ui@1.8.2

## 1.8.1

### Patch Changes

- Updated dependencies [ba8effb]
- Updated dependencies [f4cc5ef]
  - @alexkroman1/aai@1.8.1
  - @alexkroman1/aai-ui@1.8.1

## 1.8.0

### Patch Changes

- Updated dependencies [a7384ad]
- Updated dependencies [cc013df]
  - @alexkroman1/aai@1.8.0
  - @alexkroman1/aai-ui@1.8.0

## 1.7.1

### Patch Changes

- Updated dependencies [3c711da]
  - @alexkroman1/aai@1.7.1
  - @alexkroman1/aai-ui@1.7.1

## 1.7.0

### Patch Changes

- Updated dependencies [07b4263]
- Updated dependencies [b79855d]
  - @alexkroman1/aai@1.7.0
  - @alexkroman1/aai-ui@1.7.0

## 1.6.1

### Patch Changes

- Updated dependencies [da84b47]
  - @alexkroman1/aai@1.6.1
  - @alexkroman1/aai-ui@1.6.1

## 1.6.0

### Patch Changes

- Updated dependencies [149786b]
- Updated dependencies [fd3a167]
- Updated dependencies [c8707d6]
- Updated dependencies [877348c]
  - @alexkroman1/aai@1.6.0
  - @alexkroman1/aai-ui@1.6.0

## 1.5.1

### Patch Changes

- Updated dependencies [fbb3816]
  - @alexkroman1/aai@1.5.1
  - @alexkroman1/aai-ui@1.5.1

## 1.5.0

### Patch Changes

- 178260a: Remove unused runBuildCommand wrapper
- Updated dependencies [58c5c75]
- Updated dependencies [868b85e]
- Updated dependencies [a361363]
- Updated dependencies [58c5c75]
- Updated dependencies [58c5c75]
  - @alexkroman1/aai@1.5.0
  - @alexkroman1/aai-ui@1.5.0

## 1.4.5

### Patch Changes

- Updated dependencies [07dc8fb]
- Updated dependencies [2ca5d1f]
  - @alexkroman1/aai@1.4.5
  - @alexkroman1/aai-ui@1.4.5

## 1.4.4

### Patch Changes

- Updated dependencies [9bd219f]
- Updated dependencies [74341a4]
  - @alexkroman1/aai-ui@1.4.4
  - @alexkroman1/aai@1.4.4

## 1.4.3

### Patch Changes

- Updated dependencies [62d5a99]
  - @alexkroman1/aai@1.4.3
  - @alexkroman1/aai-ui@1.4.3

## 1.4.2

### Patch Changes

- Updated dependencies [f877a6f]
  - @alexkroman1/aai@1.4.2
  - @alexkroman1/aai-ui@1.4.2

## 1.4.1

### Patch Changes

- Updated dependencies [63de397]
  - @alexkroman1/aai@1.4.1
  - @alexkroman1/aai-ui@1.4.1

## 1.4.0

### Minor Changes

- d3b39ef: Wire pluggable STT/LLM/TTS providers through the managed-platform sandbox. Previously providers were defined as live Vercel AI SDK / SDK-client instances in agent.ts, which meant the bundle shipped '@ai-sdk/anthropic' etc. into the guest Deno sandbox — the SDK's eager ANTHROPIC_BASE_URL env read crashed under '--allow-env'-free Deno. The server's createRuntime() also ignored stt/llm/tts entirely, so pipeline mode never activated in production. Now factories under @alexkroman1/aai/{stt,tts,llm} return '{ kind, options }' descriptors (JSON-serializable, no AI-SDK imports). The host resolves them to real openers at session start via a new resolver. IsolateConfig carries mode + descriptors through deploy, and sandbox.ts threads them into createRuntime. The agent bundle is now ~66 KB with zero AI-SDK code.

### Patch Changes

- @alexkroman1/aai@1.4.0
- @alexkroman1/aai-ui@1.4.0

## 1.3.2

### Patch Changes

- 3181117: Stop giget from dumping a stray '<owner>-<repo>' folder (alexkroman-agent) into the user's cwd during 'aai init'. Pass an explicit tmp 'dir' so the template tarball extracts outside the working directory.
  - @alexkroman1/aai@1.3.2
  - @alexkroman1/aai-ui@1.3.2

## 1.3.1

### Patch Changes

- 66cbc95: Fix pnpm install failure when scaffolding pipeline-simple template. The template's package.json was replacing the scaffold's, leaving a workspace:\* marker that pnpm cannot resolve outside the monorepo. Pipeline-mode SDKs (ai, assemblyai, @ai-sdk/anthropic, @cartesia/cartesia-js) now live in the scaffold's package.json. Also surface pnpm's actual stdout/stderr on install failure instead of the opaque 'Command failed' wrapper.
- Updated dependencies [5a9f3d5]
  - @alexkroman1/aai@1.3.1
  - @alexkroman1/aai-ui@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies [c95212a]
- Updated dependencies [f1a9764]
- Updated dependencies [f1a9764]
- Updated dependencies [0231114]
- Updated dependencies [8a79282]
- Updated dependencies [f1a9764]
  - @alexkroman1/aai@1.3.0
  - @alexkroman1/aai-ui@1.3.0

## 1.2.3

### Patch Changes

- 6a44b5b: Republish after the 1.2.2 release workflow failed (broken lockfile under `pnpm/action-setup@v6`). Also: `aai init` now skips deploy when `pnpm install` fails, so users see the real install error instead of a cryptic Rolldown `@alexkroman1/aai` resolution failure.
- Updated dependencies [6a44b5b]
  - @alexkroman1/aai@1.2.3
  - @alexkroman1/aai-ui@1.2.3

## 1.2.2

### Patch Changes

- Updated dependencies [534122c]
  - @alexkroman1/aai@1.2.2
  - @alexkroman1/aai-ui@1.2.2

## 1.2.1

### Patch Changes

- Updated dependencies [7af69b8]
  - @alexkroman1/aai@1.2.1
  - @alexkroman1/aai-ui@1.2.1

## 1.2.0

### Patch Changes

- Updated dependencies [ed0dfbb]
- Updated dependencies [231ebc1]
  - @alexkroman1/aai@1.2.0
  - @alexkroman1/aai-ui@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [5cda7c5]
- Updated dependencies [41fab1a]
- Updated dependencies [f342260]
  - @alexkroman1/aai@1.1.0
  - @alexkroman1/aai-ui@1.1.0

## 1.0.6

### Patch Changes

- 27faac9: Fix missing CSS in scaffolded agents: remove client.tsx and index.html from scaffold, serve pre-built default UI when no custom client exists, provide fallback index.html via Vite plugin for custom clients
  - @alexkroman1/aai@1.0.6
  - @alexkroman1/aai-ui@1.0.6

## 1.0.5

### Patch Changes

- b3bafa7: Fix missing CSS in scaffolded agents: remove client.tsx and index.html from scaffold, serve pre-built default UI when no custom client exists, provide fallback index.html via Vite plugin for custom clients
  - @alexkroman1/aai@1.0.5
  - @alexkroman1/aai-ui@1.0.5

## 1.0.4

### Patch Changes

- e6c2310: Fix giget stale template cache causing defineClient build error on repeat init
  - @alexkroman1/aai@1.0.4

## 1.0.3

### Patch Changes

- 50cd113: Fix scaffold missing client.tsx and route pnpm install through safe-chain

  - Add client.tsx to scaffold with correct `client` import from aai-ui (fixes build failure from stale `defineClient` reference)
  - Detect safe-chain on PATH and route pnpm install through it with `--safe-chain-skip-minimum-package-age` to avoid blocking newly published packages
  - @alexkroman1/aai@1.0.3

## 1.0.2

### Patch Changes

- a3d3835: Force all libraries and the server to publish/deploy after the 1.0.1
  release failure. Restores the `@alexkroman1/` scope on publishable
  packages so npm accepts the publish, and bumps `aai-server` to trigger
  the Fly.io deploy job in the release workflow.
- Updated dependencies [76d25d4]
- Updated dependencies [a3d3835]
  - @alexkroman1/aai@1.0.2

## 1.0.1

### Patch Changes

- b4ff42e: Redeploy aai-server and refresh client/CLI/SDK releases
- Updated dependencies [5517333]
- Updated dependencies [5d55c12]
- Updated dependencies [b4ff42e]
  - aai@1.0.1

## 1.0.0

### Minor Changes

- befca9a: Simplify agent surface area: directory-based agent format with agent.json, tools/_.ts, hooks/_.ts replacing defineAgent/Zod
- d06b4fd: Remove global ASSEMBLYAI_API_KEY — each agent provides its own key via .env
- 0456e37: Replace esbuild with Vite library mode, unify dev/prod on tools.ts + agent.json
- 94bc25a: Prompt for AssemblyAI API key once on first use, store globally in ~/.config/aai/config.json
- 192d8ae: Fix deploy pipeline, streamline scaffold, improve dev CLI workflow
- 7b451c7: Extract agent config at build time and defer V8 isolate boot until custom tool/hook execution
- 26d9d44: Remove template selection from aai init — always scaffolds the simple template
- bb87a1d: Add structured JSON output for all CLI commands (auto-detected in non-TTY, --json flag)

### Patch Changes

- 9211c65: Add default aai-ui client served by the server when no custom client is deployed. Remove zod externalization from the worker bundler — zod 4 works natively in Deno sandboxes. Update S2S API endpoint and fix load test event handling.
- f6e7a5c: BREAKING: Align SDK naming with S2S API

  - `instructions` → `systemPrompt` in AgentOptions/AgentDef
  - `DEFAULT_INSTRUCTIONS` → `DEFAULT_SYSTEM_PROMPT`
  - `onTurn` → `onUserTranscript` hook
  - Protocol events renamed: `transcript` → `user_transcript_delta`, `turn` → `user_transcript`, `chat` → `agent_transcript`, `chat_delta` → `agent_transcript_delta`, `tts_done` → `reply_done`, `tool_call_start` → `tool_call`

- 05f8759: Replace hand-rolled utilities with dependencies: dotenv for .env parsing, mime-types and escape-html in dev server, p-debounce for file watcher
- fa7b928: Change default dev server port from 8787 to 8080
- Updated dependencies [8ecb7d1]
- Updated dependencies [3bd18a9]
- Updated dependencies [befca9a]
- Updated dependencies [9211c65]
- Updated dependencies [b9b5c02]
- Updated dependencies [99db30d]
- Updated dependencies [5cc9550]
- Updated dependencies [4c1cd20]
- Updated dependencies [ab98c61]
- Updated dependencies [837e34f]
- Updated dependencies [f6e7a5c]
- Updated dependencies [7669733]
- Updated dependencies [14d0653]
- Updated dependencies [9d2141b]
- Updated dependencies [05f8759]
- Updated dependencies [1678546]
- Updated dependencies [5fd5cb3]
- Updated dependencies [64d83b6]
- Updated dependencies [6d3ec72]
  - aai@1.0.0

## 0.12.3

### Patch Changes

- 55afc5c: Fix release workflow to trigger CI on version PRs
- 68f4d84: Make more cross platform
- Updated dependencies [4ebd7b6]
- Updated dependencies [68f4d84]
  - @alexkroman1/aai@0.12.3

## 0.12.2

### Patch Changes

- 5900685: Add centralized error handling to CLI commands
- 5e3538c: Skip changeset-status pre-push hook on changeset-release branches to fix release workflow
- 59a9a10: Use pnpm for scaffolded projects and accept --server flag on all commands
  - @alexkroman1/aai@0.12.2

## 0.12.1

### Patch Changes

- 1b8b757: Fix changesets version command and sync scaffold versions during release
- f4762a1: Externalize zod from agent bundles, remove storage cache, improve CI reliability
- 1b960da: Remove zod dependency
- Updated dependencies [f4762a1]
  - @alexkroman1/aai@0.12.1

## 0.12.0

### Patch Changes

- e2f72a2: Auto-sync scaffold package.json versions with workspace packages during release
- Updated dependencies [99e62c3]
  - @alexkroman1/aai@0.12.0

## 0.11.1

### Patch Changes

- Updated dependencies [c25ee7e]
  - @alexkroman1/aai@0.11.1

## 0.11.0

### Minor Changes

- 491ec37: CLI overhaul: remove generate command, unify output style, template descriptions

  - Remove `generate` and `run` commands and AI SDK dependencies
  - Unify CLI output to use @clack/prompts style consistently
  - Add template descriptions shown as hints in `aai init` select prompt
  - Fix deploy slug mismatch between bundle and deploy steps
  - Clean deploy error messages (no stack traces)
  - Add `@alexkroman1/aai-cli` to scaffold devDependencies
  - Remove fly.toml from scaffold
  - Use cyanBright for all URLs in CLI output
  - Remove eventsource-parser patch
  - Add link-workspace-packages to .npmrc
  - Fix Dockerfile: run esbuild install script, remove patches references

### Patch Changes

- Updated dependencies [491ec37]
  - @alexkroman1/aai@0.11.0

## 0.10.4

### Patch Changes

- 6f6a43e: Harden platform security and refactor to @hono/zod-validator

  - Fix crash in sandbox-network when host.internal hit without handler
  - Add Zod validation to KV bridge (isolate→host) replacing raw JSON.parse
  - Refactor deploy, secret, and KV handlers to use @hono/zod-validator middleware
  - Fix type errors in \_harness-runtime.ts and sandbox.ts
  - Remove factory.ts, inline into orchestrator
  - Add 185 new security tests for cross-agent isolation, SSRF, and trust boundaries

- Updated dependencies [6f6a43e]
  - @alexkroman1/aai@0.10.4

## 0.10.3

### Patch Changes

- 8d5f616: Use Hono builtins for WebSocket, security headers, and HTML escaping

  - Replace manual WebSocketServer + upgrade handling with @hono/node-ws
  - Replace custom escapeHtml() with Hono's html tagged template
  - Replace manual CSP string with secureHeaders middleware
  - Fix aai rag to use local dev server in dev mode
  - Fix vector upsert model loading in local dev mode
  - Add missing aws4fetch dependency for unstorage S3 driver

- Updated dependencies [8d5f616]
  - @alexkroman1/aai@0.10.3

## 0.10.2

### Patch Changes

- Updated dependencies [9de059e]
- Updated dependencies [1397f37]
  - @alexkroman1/aai@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies [aa23a1c]
  - @alexkroman1/aai@0.10.1

## 0.10.0

### Minor Changes

- Replace LanceDB with sqlite-vec for vector storage, add `generate` CLI command, extract templates to giget, local dev mode improvements, auth cleanup, and graceful shutdown fixes

### Patch Changes

- Updated dependencies
  - @alexkroman1/aai@0.10.0

## 0.9.4

### Patch Changes

- Release all packages with version increment
- Updated dependencies
  - @alexkroman1/aai@0.9.4

## 0.9.3

### Patch Changes

- Fix dependencies
  - @alexkroman1/aai@0.9.3

## 0.9.2

### Patch Changes

- Fixed dependencies
  - @alexkroman1/aai@0.9.2

## 0.9.1

### Patch Changes

- Update
- Updated dependencies
  - @alexkroman1/aai@0.9.1

## 0.9.0

### Minor Changes

- Updated toolchain

### Patch Changes

- Updated dependencies
  - @alexkroman1/aai@0.9.0
