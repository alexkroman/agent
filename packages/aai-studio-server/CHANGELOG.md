# aai-studio-server

## 0.11.7

### Patch Changes

- Updated dependencies [61fe5cd]
- Updated dependencies [61fe5cd]
- Updated dependencies [61fe5cd]
- Updated dependencies [61fe5cd]
- Updated dependencies [61fe5cd]
- Updated dependencies [61fe5cd]
  - aai-server@5.1.0
  - @alexkroman1/aai-runtime@13.1.0
  - @alexkroman1/aai@13.1.0
  - @alexkroman1/aai-ui@13.1.0
  - aai-studio-client@0.6.20

## 0.11.6

### Patch Changes

- 9e12bb2: Bump dependencies across the workspace: the ai SDK and its provider adapters, zod, vite, vitest, hono, the Supabase clients, xstate, undici, modal, @cartesia/cartesia-js and the build/lint toolchain.
  
  Two source changes come with it. The scripted fake language model emitted a bare-string stream finish reason where the v3 provider spec declares a { unified, raw } pair — harmless until ai@7.0.70 made automatic tool execution conditional on that value, after which a scripted tool call never ran; the fake's doGenerate half already had the pair. And protocol-compat.test.ts moves off zod's deprecated ZodTypeAny to ZodType.
- 5e5ae06: Sync to GitHub: bootstrap a repository with no commits through the Contents API, and list the repository picker newest-first.
- Updated dependencies [9e12bb2]
- Updated dependencies [9e12bb2]
- Updated dependencies [4647b84]
- Updated dependencies [4647b84]
- Updated dependencies [9584e2e]
- Updated dependencies [9584e2e]
- Updated dependencies [4647b84]
- Updated dependencies [b94fdd1]
- Updated dependencies [ef6c39c]
- Updated dependencies [b94fdd1]
- Updated dependencies [4647b84]
- Updated dependencies [ef6c39c]
  - @alexkroman1/aai@13.0.0
  - aai-server@5.0.0
  - aai-studio-client@0.6.19
  - @alexkroman1/aai-runtime@13.0.0
  - @alexkroman1/aai-ui@13.0.0

## 0.11.5

### Patch Changes

- 33ebdb4: Rebuild a GitHub sync commit onto a branch head that moved, instead of telling the user to try again. "That branch moved while the sync was running" answered every 409 and 422 in the push, so a tree GitHub would not accept or a ref name it would not create both read as a transient race and the retry advice never worked. Retryable ref conflicts are now retried by the sync itself; everything else keeps GitHub's own message.

## 0.11.4

### Patch Changes

- 78eccdd: Repair a GitHub App private key whose newlines were collapsed to spaces.
  
  The production key was pasted through a single-line field, arriving with 32
  spaces and zero newlines. `normalizePrivateKey` short-circuits on
  `includes("-----BEGIN")`, so it handed the value straight to OpenSSL, which
  refused it with `error:1E08010C:DECODER routines::unsupported` — at the LAST
  step of the install callback, after GitHub had already authorized the user, so
  it surfaced as "GitHub could not complete the connection" rather than as a
  misconfiguration. The repair is structural rather than a whitespace
  substitution: the PEM label legitimately contains spaces, so it reads the
  header and footer and re-wraps the body at 64. Deterministic and idempotent,
  because this value is also the HMAC key behind every install `state`.
- Updated dependencies [4507050]
  - @alexkroman1/aai-runtime@12.0.0
  - aai-server@4.0.0
  - @alexkroman1/aai@12.0.0
  - @alexkroman1/aai-ui@12.0.0
  - aai-studio-client@0.6.18

## 0.11.3

### Patch Changes

- Updated dependencies [b0a8a80]
  - aai-server@3.7.3

## 0.11.2

### Patch Changes

- 926ae11: Fix the studio's Connect GitHub button never becoming Sync: the connect flow went to the App's install page, which GitHub does not redirect back from once the App is installed, so the callback never ran. Connect now goes through /login/oauth/authorize, and the callback resolves the installation from the user token when the redirect names none.
- Updated dependencies [200537a]
  - aai-server@3.7.2

## 0.11.1

### Patch Changes

- Updated dependencies [f376585]
  - aai-server@3.7.1

## 0.11.0

### Minor Changes

- 67274e7: Add Sync to GitHub: connect a GitHub App installation to a studio account and push a project's workspace to a repository as one commit.

### Patch Changes

- Updated dependencies [36a3f22]
- Updated dependencies [0718b57]
- Updated dependencies [165f9b2]
- Updated dependencies [36a3f22]
- Updated dependencies [fe3b6d6]
- Updated dependencies [6bbef9b]
- Updated dependencies [63e1c8e]
- Updated dependencies [36a3f22]
- Updated dependencies [36a3f22]
- Updated dependencies [f10b6aa]
- Updated dependencies [623a8bb]
- Updated dependencies [0718b57]
- Updated dependencies [36a3f22]
- Updated dependencies [7ab47cf]
- Updated dependencies [36a3f22]
- Updated dependencies [36a3f22]
- Updated dependencies [31459e8]
  - @alexkroman1/aai@11.0.0
  - @alexkroman1/aai-runtime@11.0.0
  - aai-server@3.7.0
  - aai-studio-client@0.6.17
  - @alexkroman1/aai-ui@11.0.0

## 0.10.15

### Patch Changes

- Updated dependencies [f35bdf7]
  - @alexkroman1/aai-runtime@10.0.1
  - aai-server@3.6.20
  - @alexkroman1/aai@10.0.1
  - @alexkroman1/aai-ui@10.0.1
  - aai-studio-client@0.6.16

## 0.10.14

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
  - @alexkroman1/aai-runtime@10.0.0
  - @alexkroman1/aai@10.0.0
  - aai-server@3.6.19
  - @alexkroman1/aai-ui@10.0.0
  - aai-studio-client@0.6.15

## 0.10.13

### Patch Changes

- Updated dependencies [1ad4977]
- Updated dependencies [bee46bc]
- Updated dependencies [1e5170a]
  - @alexkroman1/aai@9.2.0
  - @alexkroman1/aai-runtime@9.2.0
  - aai-server@3.6.18
  - aai-studio-client@0.6.14
  - @alexkroman1/aai-ui@9.2.0

## 0.10.12

### Patch Changes

- Updated dependencies [041a5a2]
  - @alexkroman1/aai@9.1.0
  - @alexkroman1/aai-runtime@9.1.0
  - aai-server@3.6.17
  - aai-studio-client@0.6.13
  - @alexkroman1/aai-ui@9.1.0

## 0.10.11

### Patch Changes

- 7a4e94b: Studio API pane: map every form control to the JSON that sets it, and drop the
  `/workflows/*` route table.
  
  A workflow app's front door is a form, and the pane documented the form's
  destination while leaving the correspondence to inference. The new "Every form
  field, over HTTP" card lists each control (`<TextField>`, `<TextAreaField>`,
  `<NumberField>`, `<SelectField>`, `<CheckboxField>`, `<FileField upload>`, plus
  the nested shapes that get no generated control), the JSON each contributes to
  the run input, and the one that needs a second call first — with each row
  carrying this agent's own property and sampled value where it declares one. The
  annotated SDK/`curl` pair beside it expands the same run body one property per
  line, labelled by the control it is.
  
  The route table now renders only on the public API page, whose reader has a slug
  and an integration to write. The studio pane has a Workflows tab beside it, so
  the openness sentence moves into the run card rather than going with the rows.
- Updated dependencies [dcb2050]
- Updated dependencies [cc317e4]
  - @alexkroman1/aai-runtime@9.0.2
  - aai-server@3.6.16
  - @alexkroman1/aai@9.0.2
  - @alexkroman1/aai-ui@9.0.2
  - aai-studio-client@0.6.12

## 0.10.10

### Patch Changes

- Updated dependencies [533e217]
- Updated dependencies [533e217]
  - @alexkroman1/aai-runtime@9.0.1
  - aai-server@3.6.15
  - @alexkroman1/aai@9.0.1
  - @alexkroman1/aai-ui@9.0.1
  - aai-studio-client@0.6.11

## 0.10.9

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
  - aai-server@3.6.14
  - aai-studio-client@0.6.10

## 0.10.8

### Patch Changes

- aai-server@3.6.13
  - @alexkroman1/aai@8.2.1
  - @alexkroman1/aai-runtime@8.2.1
  - @alexkroman1/aai-ui@8.2.1
  - aai-studio-client@0.6.9

## 0.10.7

### Patch Changes

- d703845: Fix five production failures found in one day of Modal logs. A pinned harness image now resolves from EITHER image source: setting GUEST_IMAGE_REGISTRY orphaned every `agents.harness_image_tag` recorded before the flip, because a tag is source-independent but the published IMAGE is not, so every agent deployed earlier answered 503 behind a Modal error whose exception text is empty. The boot capacity check now reads how the admin pool is ROUTED — with PLATFORM_POOLER_URL unset it printed `capacity ok — 0 spare` one line under the warning naming the 20 fleet-wide connections it was not counting, so the 53300 exhaustion those predict arrived unwarned. An unreachable Supabase Auth or Storage answers 503 rather than 500, and a storage failure keeps its cause instead of stopping at undici's `fetch failed`. And GET /robots.txt returns a policy rather than 400 from the slug validator.
- Updated dependencies [d703845]
  - aai-server@3.6.12

## 0.10.6

### Patch Changes

- Updated dependencies [b5c23a0]
  - aai-server@3.6.11

## 0.10.5

### Patch Changes

- Updated dependencies [690a623]
- Updated dependencies [690a623]
  - @alexkroman1/aai-runtime@8.2.0
  - aai-server@3.6.10
  - @alexkroman1/aai@8.2.0
  - @alexkroman1/aai-ui@8.2.0
  - aai-studio-client@0.6.8

## 0.10.4

### Patch Changes

- 95c7b66: Answer the four remaining studio guest RPCs with the sentence a validation issue carries, not the raw blob. `studio/sync-workspace`, `studio/agent-logs`, `studio/persist-chat` and the `workspace/deploy` response all interpolated `parsed.error.message` — which for a `ZodError` is `JSON.stringify(issues, null, 2)` — so one wrong field answered with a multi-line array of `{ code, origin, path }` objects. The first three reach the coding agent as an RPC rejection it is meant to act on; the fourth is rendered verbatim into the Publish menu, where a JSON dump is the only thing the user is told about a failed publish. `errorMessage(parsed.error)` renders the same issues as one line. Follow-up to the same fix in `aai-server`'s error handler.
- Updated dependencies [2f899e1]
- Updated dependencies [1789a55]
- Updated dependencies [c8d7f07]
  - @alexkroman1/aai@8.1.0
  - aai-server@3.6.9
  - @alexkroman1/aai-runtime@8.1.0
  - aai-studio-client@0.6.7
  - @alexkroman1/aai-ui@8.1.0

## 0.10.3

### Patch Changes

- Updated dependencies [6e104da]
  - aai-server@3.6.8

## 0.10.2

### Patch Changes

- Updated dependencies [83edc89]
- Updated dependencies [4c55d8a]
- Updated dependencies [1d58f53]
- Updated dependencies [6960bfa]
- Updated dependencies [c0e3d85]
- Updated dependencies [32bbb05]
- Updated dependencies [efa6152]
- Updated dependencies [01b790c]
- Updated dependencies [56b775c]
  - @alexkroman1/aai@8.0.0
  - aai-studio-client@0.6.6
  - @alexkroman1/aai-ui@8.0.0
  - @alexkroman1/aai-runtime@8.0.0
  - aai-server@3.6.7

## 0.10.1

### Patch Changes

- Updated dependencies [053b6f2]
  - aai-server@3.6.6

## 0.10.0

### Minor Changes

- ddbb905: Studio coding agent: a `read_logs` tool, so it can read what the agent it is building actually printed.
  
  A runtime failure — a tool throwing mid-call, a missing provider key, a response shape the code guessed wrong — only happens with a real caller on the line, and `test_agent` loads the bundle inside the coding agent's own sandbox where none of that is visible. The evidence existed (it is what the studio's Logs pane shows) and the agent's only route to it was asking the user to read it out.
  
  `read_logs` takes an ENVIRONMENT (`preview`, the default, or `production`) and never a slug: the guest RPCs the host, which resolves the project's own deployed agents from the workspace of the (scope, project) the sandbox is pinned to and reads the platform's owner-authenticated `GET /:slug/logs` with the account key those agents were deployed with. The host drains the guest's cursor-indexed ring forward and returns the TAIL, because the ring hands back its oldest lines first and "what just broke" is at the other end. Eviction is reported rather than swallowed, and each of the three empty states — never deployed, not running, running and silent — says which one it is, since they call for different next moves.

### Patch Changes

- abfc018: Stop teaching two imports that cannot resolve, and gate the docs that carried
  them.
  
  The studio's workflow preamble told its coding agent to bound a fan-out with
  `mapInBatches` from `@alexkroman1/aai/utils`. That name is on
  `@alexkroman1/aai/step`, so every workflow the studio generated from the
  instruction opened with an unresolvable import — and `mapInBatches` is itself
  the deprecated alias of `mapConcurrent`. The bullet also justified the bound by
  claiming a work-stealing pool "diverges on replay", which is the opposite of
  what `sdk/map-concurrent.ts` documents: a window over a shared cursor hands out
  the next index monotonically, so the Nth call issued is item N-1 however the
  calls settle, and that is why the batching it replaced could be dropped for a
  measured 6.7x p50 tail. The bullet now names `mapConcurrent`, the right
  subpath, and the rule that IS load-bearing — one step call per callback,
  issued synchronously.
  
  `@alexkroman1/aai/runtime` went away with the runtime package split, and four
  files kept importing it: both example servers, the host-server bench, and the
  prose in the root README. They name `@alexkroman1/aai-runtime` now, and each
  example's manifest declares what it actually imports at the version the
  workspace ships (they were pinned at `^5.10.0` against a 6.11.0 workspace, with
  no runtime dependency at all and `ws` — which the bench needs — undeclared).
  
  `check-doc-examples` could not have caught either. `SOURCE_GLOBS` never
  included `packages/aai-runtime`, so a published package's seven `@example`
  blocks were compiled by nothing, and `MARKDOWN_FILES` had one of the three
  runnable examples' READMEs plus none of that package's. All three are in now
  (160 examples, floor raised to 157), and `examples/host-server/README.md`'s
  opening fence — the one that carried the dead import — is checked rather than
  skipped as `js`.
  
  `UPLOAD_KEY_PREFIX` was declared twice with the same value, once in
  `aai-server/upload-bytes.ts` and once on `@alexkroman1/aai-runtime`'s root.
  The platform imports the runtime's now. The key SHAPES still differ on purpose
  — `uploadKey` interposes the slug because this route writes into a bucket
  shared by every tenant — but where uploads begin is one literal again.
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
- fbb18c3: Studio API page: document how to actually SEND a file. The upload routes were in the route table and every generated run body carried an upload id, but the only worked example of obtaining one was buried in the SDK start snippet. There is now a "Sending a file" card — generated from the agent's own listing, rendered only when a declared workflow takes an upload — leading with the client SDK (agent.upload / agent.uploadStream / agent.uploadInfo) and covering both orders: send the file and get an id back, or mint the id, start the run, and stream the bytes into it. The curl alternates really upload, leaving the id in a shell variable the run body expands.
- Updated dependencies [d98169a]
- Updated dependencies [abfc018]
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
- Updated dependencies [ddbb905]
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
  - aai-studio-client@0.6.5
  - aai-server@3.6.5
  - @alexkroman1/aai@7.0.0

## 0.9.0

### Minor Changes

- eb702d2: Studio: serve each project's API documentation at a public, sign-in-free page (/studio/api/<slug>), and link to it from the API tab.

### Patch Changes

- 11e4892: Calling a deployed agent is now one client, and the studio's API page is written
  in it. `createAgentClient` (`@alexkroman1/aai/workflow-api`) is a superset of
  `createWorkflowApiClient`: every workflow route plus `config()`, the front-door
  read (`GET /client-config`) that had no client at all — so a caller stops
  building two things, one of which was a `fetch` and a hand-written URL join.
  
  Two new calls cover the streams. `follow(runId)` and `followOutput(runId)` are
  async iterables — `for await (const run of agent.follow(id))` — and they hold the
  two protocol rules a hand-written SSE loop gets wrong, neither of which looks
  like a bug when it goes wrong: the state stream hands the client back with an
  `idle` frame after its own duration cap (a run may sleep for hours, so that is a
  re-open, not an ending), and one output read is bounded by the tail it saw (so the
  next read has to resume from an absolute index). A stream that ends with the run
  unsettled throws rather than reading as a run that finished. `watch` and
  `streamOutput` still resolve the raw `Response`, which is what a caller writing
  its own polling fallback needs; there is deliberately no fallback inside the
  iterators. `readEventStream` is the SSE parser under them, now public — the
  browser client's private copy is deleted rather than duplicated.
  
  `WorkflowApiClientOptions.token` and `.timeoutMs` accept an explicit `undefined`,
  so `token: process.env.AAI_WORKFLOW_API_TOKEN` compiles under
  `exactOptionalPropertyTypes` instead of needing a `!`.
  
  The API pane and the public page at `/studio/api/<slug>` now lead with the SDK in
  every section, with `curl` and `aai workflow` one disclosure away, and each route
  row names the call that makes it. An upload-carrying input renders as the
  `agent.upload(...)` call and a reference to its id rather than as a placeholder
  string, and the page reads the agent through the same client it documents.
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
- Updated dependencies [279a986]
- Updated dependencies [298f3f2]
- Updated dependencies [aec3aa8]
- Updated dependencies [1602a0e]
  - @alexkroman1/aai@6.11.0
  - aai-server@3.6.4
  - aai-studio-client@0.6.4
  - @alexkroman1/aai-ui@6.11.0

## 0.8.3

### Patch Changes

- Updated dependencies [5556ed5]
- Updated dependencies [eda6060]
  - @alexkroman1/aai@6.10.1
  - aai-server@3.6.3
  - aai-studio-client@0.6.3
  - @alexkroman1/aai-ui@6.10.1

## 0.8.2

### Patch Changes

- Updated dependencies [1a76804]
  - @alexkroman1/aai@6.10.0
  - aai-server@3.6.2
  - aai-studio-client@0.6.2
  - @alexkroman1/aai-ui@6.10.0

## 0.8.1

### Patch Changes

- Updated dependencies [866d17f]
- Updated dependencies [9d45c1e]
  - aai-server@3.6.1
  - @alexkroman1/aai@6.9.1
  - aai-studio-client@0.6.1
  - @alexkroman1/aai-ui@6.9.1

## 0.8.0

### Minor Changes

- b5fa695: Studio: an API pane generated from each agent's own workflow schemas, Workflows and Database panes of their own, and Preview renamed to Playground
- 9134a61: Studio: the Playground tab is now labelled UI, and secrets move out of Settings into a Secrets pane of their own — a name/value form with the value in a password field, a live/on-next-deploy list with confirm-before-delete, and the .env paste box kept for bulk adds
- f802fac: Databases are off by default: a studio project now has no ctx.db until it is enabled in Settings, and the Database pane appears only once it is.

### Patch Changes

- Updated dependencies [ebd3c39]
- Updated dependencies [203c2d4]
- Updated dependencies [46db894]
- Updated dependencies [bbde9f9]
- Updated dependencies [a8e74a9]
- Updated dependencies [46db894]
- Updated dependencies [9134a61]
- Updated dependencies [f802fac]
- Updated dependencies [46db894]
  - @alexkroman1/aai-ui@6.9.0
  - @alexkroman1/aai@6.9.0
  - aai-server@3.6.0
  - aai-studio-client@0.6.0

## 0.7.11

### Patch Changes

- Updated dependencies [c7bb199]
  - @alexkroman1/aai-ui@6.8.0
  - aai-server@3.5.19
  - aai-studio-client@0.5.11
  - @alexkroman1/aai@6.8.0

## 0.7.10

### Patch Changes

- Updated dependencies [7eb8b85]
- Updated dependencies [7f2637c]
- Updated dependencies [088eee6]
  - aai-server@3.5.18
  - @alexkroman1/aai@6.7.2
  - @alexkroman1/aai-ui@6.7.2
  - aai-studio-client@0.5.10

## 0.7.9

### Patch Changes

- Updated dependencies [c46dac6]
  - @alexkroman1/aai@6.7.1
  - aai-server@3.5.17
  - aai-studio-client@0.5.9
  - @alexkroman1/aai-ui@6.7.1

## 0.7.8

### Patch Changes

- Updated dependencies [9882411]
  - @alexkroman1/aai@6.7.0
  - aai-server@3.5.16
  - aai-studio-client@0.5.8
  - @alexkroman1/aai-ui@6.7.0

## 0.7.7

### Patch Changes

- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
  - @alexkroman1/aai@6.6.0
  - aai-server@3.5.15
  - aai-studio-client@0.5.7
  - @alexkroman1/aai-ui@6.6.0

## 0.7.6

### Patch Changes

- 58788ee: Internal quality pass: give repeated shapes one home each, remove stranded code, and hoist redundant work out of render and streaming paths. No API or behaviour change.
- e2c2cda: Fix four production errors from an hour of Modal logs: a 30s proxy deadline that aborted healthy uploads (27 x 503), a parallel-upload part that treated a retryable 503 as a refusal, a 5xx whose cause was never logged, and an aborted request logged as an agent failure.
- Updated dependencies [58788ee]
- Updated dependencies [e2c2cda]
- Updated dependencies [153264f]
- Updated dependencies [153264f]
  - @alexkroman1/aai@6.5.1
  - aai-server@3.5.14
  - aai-studio-client@0.5.6
  - @alexkroman1/aai-ui@6.5.1

## 0.7.5

### Patch Changes

- Updated dependencies [4da4327]
- Updated dependencies [4da4327]
  - @alexkroman1/aai@6.5.0
  - aai-server@3.5.13
  - aai-studio-client@0.5.5
  - @alexkroman1/aai-ui@6.5.0

## 0.7.4

### Patch Changes

- Updated dependencies [5288539]
  - @alexkroman1/aai@6.4.0
  - aai-server@3.5.12
  - aai-studio-client@0.5.4
  - @alexkroman1/aai-ui@6.4.0

## 0.7.3

### Patch Changes

- Updated dependencies [dd29277]
  - @alexkroman1/aai@6.3.1
  - aai-server@3.5.11
  - aai-studio-client@0.5.3
  - @alexkroman1/aai-ui@6.3.1

## 0.7.2

### Patch Changes

- Updated dependencies [b04af38]
- Updated dependencies [2e103d8]
- Updated dependencies [5d99fa4]
  - @alexkroman1/aai@6.3.0
  - aai-server@3.5.10
  - aai-studio-client@0.5.2
  - @alexkroman1/aai-ui@6.3.0

## 0.7.1

### Patch Changes

- Updated dependencies [295e8db]
  - @alexkroman1/aai@6.2.0
  - @alexkroman1/aai-ui@6.2.0
  - aai-server@3.5.9
  - aai-studio-client@0.5.1

## 0.7.0

### Minor Changes

- 320268c: Studio: switch between building a voice agent and a static workflow app on the new-project screen. The hero's position picks the starter examples and is stamped on the project, where it selects the coding agent's system prompt — workflow projects default to a workflowApp() in the shape of the transcription-workflow template.

### Patch Changes

- c4791cc: Studio actions no longer write into the chat: Publish, secret changes and the Database switch each posted a first-person user message into the conversation ("I set the secret X…", "I published the project with the Publish button…"). Each pane reports its own outcome instead — the Publish menu renders the CLI output, the Secrets card clears its draft only on success — and the coding agent's preamble now says it will not see a publish or a secret change rather than promising a note.
- 16bec88: The studio's Workflows card reads the SDK's `WorkflowRunSnapshot`, `WorkflowSummary` and `isTerminal` instead of a local restatement, so a field added to a run snapshot reaches the card and a new run status cannot be silently classified as live. `errorText` unwraps message-bearing non-`Error` rejections through the SDK's `errorMessage`. (aai-studio-server is named so the client's `dist/` actually ships — it has no release of its own.)
- c4791cc: Split the local-dev sentinel in two: SUPABASE_DB_URL decides where platform state lives (no memory tier beside a real database), AAI_LOCAL_DEV=1 declares a local run. pnpm dev:aai-server resolves the local Supabase stack and a repo-root .env itself; studio sign-in offers the methods GoTrue reports, so email+password works locally with no OAuth app; boot verifies pg_cron instead of creating it. Studio projects get a database by DEFAULT (absent means on; the opt-out is an explicit false), and `@workflow/world-postgres` is no longer bundled into the guest harness — it ships on-disk Drizzle migrations the bundle cannot carry, so the durable Postgres workflow world could never start.
- 4f5d9eb: Reorder the studio Settings pane: Work locally, Phone number, Database, Secrets, then Danger zone
- bb54679: Count app databases in the platform connection budget, check it against the real instance at boot, and cap concurrent SSE streams per caller scope. MAX_CONTAINERS drops to 5 while the per-container input caps rise to 200/400 — measured, one replica holds 2,000 concurrent streams with no degradation and they cost zero database connections, so a replica is cheap in the scarce resource.
- Updated dependencies [320268c]
- Updated dependencies [16bec88]
- Updated dependencies [c4791cc]
- Updated dependencies [bb54679]
  - aai-studio-client@0.5.0
  - aai-server@3.5.8

## 0.6.8

### Patch Changes

- df41665: Studio Settings gains a Phone number card: the per-carrier webhook URLs for the published agent, with each carrier's signing secret named and reported as live, saved-but-undelivered, or missing.
- 0f76c59: Studio: recover a chat turn sent to a spun-down sandbox instead of failing it. The chat transport now targets the project's current session lease per request and re-sends a turn once on the re-brokered sandbox, so a message typed into a tab whose sandbox had been idle-evicted lands instead of showing a fetch error until the page is reloaded.
- e73d50d: Studio: drop the "this preview updates automatically as you edit" banner from the Preview pane. It rendered on every unpublished project — i.e. nearly always — restating the pane's own name above a Publish control already in the top bar. The failed-build banner is unchanged.
- Updated dependencies [df41665]
- Updated dependencies [24e8178]
  - @alexkroman1/aai@5.14.0
  - aai-server@3.5.7
  - aai-studio-client@0.4.13
  - @alexkroman1/aai-ui@5.14.0

## 0.6.7

### Patch Changes

- 9ceb71a: Studio chat now shows a project's conversation as soon as it is opened, instead of holding the whole panel until the sandbox is brokered. The 'Starting sandbox…' wait moves to the foot of the transcript, where it gates sending only — the composer stays typable and hands whatever was written to the live chat. A broker failure keeps the history up too, with its reason and Try again in the same place.

## 0.6.6

### Patch Changes

- 4ba7ab3: Studio: a preview build in flight takes the whole Preview pane (first build and rebuild alike) instead of a banner over a stale page; secrets can be saved before anything is published and reach both the preview and production agents as each deploy claims its slug; the Database card reports how many tables, rows, and bytes each environment's schema holds.
- Updated dependencies [4ba7ab3]
  - @alexkroman1/aai-ui@5.13.2
  - aai-server@3.5.6
  - aai-studio-client@0.4.12
  - @alexkroman1/aai@5.13.2

## 0.6.5

### Patch Changes

- Updated dependencies [7e92c96]
  - @alexkroman1/aai@5.13.1
  - aai-server@3.5.5
  - aai-studio-client@0.4.11
  - @alexkroman1/aai-ui@5.13.1

## 0.6.4

### Patch Changes

- 9303ba8: Supabase audit fixes: deprovision an app database on the cluster its stored locator names (a change to APP_DB_URLS otherwise dropped on the wrong one and stranded tenant data); join the orphan-preview sweep on a stored generated column so it stops detoasting every workspace document once an hour; cascade chat and session rows from their workspace; make the Vault put idempotent under a lost create race; cap the token verify cache at the token exp; report a never-joining Realtime channel; refuse boot on a missing or public Storage bucket; and add sweeps for unreferenced blobs, runaway tenant queries and pg_cron run history.
- Updated dependencies [2ec1efd]
- Updated dependencies [5cfe26b]
- Updated dependencies [9303ba8]
- Updated dependencies [90e5c15]
- Updated dependencies [cdc8e54]
- Updated dependencies [db4b0fb]
- Updated dependencies [9303ba8]
- Updated dependencies [ce45435]
- Updated dependencies [cdc8e54]
- Updated dependencies [2ec1efd]
  - aai-server@3.5.4
  - @alexkroman1/aai@5.13.0
  - aai-studio-client@0.4.10
  - @alexkroman1/aai-ui@5.13.0

## 0.6.3

### Patch Changes

- Updated dependencies [49d63cd]
  - aai-server@3.5.3

## 0.6.2

### Patch Changes

- 18c0aa7: Let the Preview pane report a preview the platform is not serving, so a tab that stays open recovers instead of polling a dead slug forever
- Updated dependencies [6b18703]
- Updated dependencies [65eab69]
  - aai-server@3.5.2

## 0.6.1

### Patch Changes

- 42cf8ab: Studio front-end: the gate card — the studio's last-resort error screen — was a fixed 420px and put the server's own error text through no wrapping guard, so an upstream message carrying one unbroken token (a URL, a request id, a base64 fragment) blew the card past the viewport: measured 1266px of content in a 338px column. It is now a max-width that also fits a narrow window, and both the message and the detail break long tokens. The top bar could not shrink below ~830px either, so the action buttons ran off the right edge of any window narrower than that; the published-URL link now yields first and the wordmark hides below lg, which clears it down to ~690px.
- 7cf76d3: Keep the studio UI alive across a Modal deploy: serve the app shell no-store (it names content-hashed assets that only exist in the image it was built into, and those are served immutable), and recover a tab whose chunks were deleted by the rollout — one guarded reload on a failed lazy import or Vite modulepreload error instead of a blank page.
- Updated dependencies [9a7916a]
- Updated dependencies [a7fc229]
- Updated dependencies [65dca0b]
- Updated dependencies [db3fb48]
- Updated dependencies [42cf8ab]
- Updated dependencies [7cf76d3]
- Updated dependencies [c49f501]
- Updated dependencies [db3fb48]
- Updated dependencies [7cf76d3]
- Updated dependencies [a91c3bc]
- Updated dependencies [db3fb48]
- Updated dependencies [a87bd05]
- Updated dependencies [c49f501]
- Updated dependencies [9fded19]
- Updated dependencies [348fa16]
- Updated dependencies [db3fb48]
- Updated dependencies [9fded19]
  - aai-server@3.5.1
  - aai-studio-client@0.4.9
  - @alexkroman1/aai@5.12.0
  - @alexkroman1/aai-ui@5.12.0

## 0.6.0

### Minor Changes

- 443dbfc: Remove the split-services deployment. There is now ONE Modal app (aai-server-web) serving both surfaces from the aai-studio-server entry. Deletes the aai-studio-web app, the STUDIO_UPSTREAM_URL reverse proxy (createStudioProxy/gracefulEventStream), the AAI_SERVICE=studio mode, and aai-server's own entry point — aai-server is now a library with no build. The split was never wired in production, so the combined branch was the only one that ever ran. isStudioPath moves to aai-server/studio-paths.ts. CI now deploys when EITHER server package version bumps, since the one app runs the studio entry.

### Patch Changes

- 443dbfc: Unpin the Modal region for both web services so containers are placed by capacity. A pinned region (us-east-2) confined the always-warm agent replica to one region's spare capacity; when it ran dry Modal placed nothing and the app sat at deployed with zero tasks, requests hung with zero bytes, and no container logs existed at all because no container was ever created.
- Updated dependencies [443dbfc]
- Updated dependencies [443dbfc]
  - aai-server@3.5.0

## 0.5.8

### Patch Changes

- Updated dependencies [e8d5e15]
  - @alexkroman1/aai@5.11.0
  - aai-server@3.4.8
  - @alexkroman1/aai-ui@5.11.0
  - aai-studio-client@0.4.8

## 0.5.7

### Patch Changes

- f941665: Install pnpm with npm in the Modal service image instead of corepack. Node stopped shipping corepack in its official distributions at 25, so the 24 to 26 base-image bump broke every deploy at the first build step with 'corepack: not found' (exit status 127). aai init's dependency-install failure now points at npm install -g pnpm rather than a corepack command that does not exist on Node 25+.
- Updated dependencies [f941665]
  - aai-server@3.4.7
  - @alexkroman1/aai@5.10.1
  - @alexkroman1/aai-ui@5.10.1
  - aai-studio-client@0.4.7

## 0.5.6

### Patch Changes

- 6b4a6d8: Run the platform on Node 26: the Modal service image, the guest sandbox base image, the repo's pinned toolchain, and CI all move from 24 to 26, matching the `@types/node` major the workspace already type-checks against. Published SDK packages keep `engines.node: >=24` so consumers on the previous LTS are unaffected.
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
- Updated dependencies [3a6a510]
- Updated dependencies [520900f]
- Updated dependencies [b125465]
- Updated dependencies [c524b76]
- Updated dependencies [b125465]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [6b4a6d8]
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
  - aai-server@3.4.6
  - aai-studio-client@0.4.6
  - @alexkroman1/aai-ui@5.10.0

## 0.5.5

### Patch Changes

- aai-server@3.4.5
- @alexkroman1/aai@5.9.0
- @alexkroman1/aai-ui@5.9.0
- aai-studio-client@0.4.5

## 0.5.4

### Patch Changes

- ba1aacd: Read preview-queue jobs back when the driver returns jsonb as a string, instead of archiving every job as unreadable
  - aai-server@3.4.4
  - @alexkroman1/aai@5.8.1
  - @alexkroman1/aai-ui@5.8.1
  - aai-studio-client@0.4.4

## 0.5.3

### Patch Changes

- d140e9b: Make auto preview deploys durable with a pgmq-backed queue instead of in-process state
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
  - aai-server@3.4.3
  - @alexkroman1/aai@5.8.0
  - @alexkroman1/aai-ui@5.8.0
  - aai-studio-client@0.4.3

## 0.5.2

### Patch Changes

- Updated dependencies [56efab9]
- Updated dependencies [842d229]
- Updated dependencies [1c034af]
- Updated dependencies [1908738]
  - @alexkroman1/aai@5.7.0
  - aai-studio-client@0.4.2
  - aai-server@3.4.2
  - @alexkroman1/aai-ui@5.7.0

## 0.5.1

### Patch Changes

- d0475b5: Regenerate a project's preview when opening it finds the preview agent gone: the wake-up's sandbox warm-up now doubles as an existence check, and a 404 from the client-config broker clears the stale previewHash stamp and schedules a redeploy instead of leaving the pane pointing at a deleted agent forever.
- Updated dependencies [fb288d2]
- Updated dependencies [9da9f65]
  - aai-server@3.4.1
  - aai-studio-client@0.4.1

## 0.5.0

### Minor Changes

- 5cd6d50: Replace Supabase magic-link email sign-in with GitHub OAuth, and rework `aai login` as a device-link flow: the CLI no longer signs in (or creates accounts) itself — it opens the studio with a one-shot link code that a signed-in browser session approves, then exchanges the code for the account's stored API key. The `GET /studio/account/key` route is removed in favor of the one-shot exchange.
- 29fa487: Studio scope unification and workspace source sync: raw API keys stored via the account route reverse-map to the owning studio user (`key-user:<sha256(key)>`), so a linked CLI shares the browser's project scope; new `PUT /studio/projects/:project/source` replaces a workspace's file map atomically with a files-hash fast-forward token (`sourceHash` now returned by project GET/SSE payloads); deleting a studio project cascades to its deployed and preview agents through the shared `deleteAgentResources` core, ownership-gated per slug.

### Patch Changes

- 77b0a80: Evict idle studio coding-agent sandboxes after 5 minutes instead of 15, matching the agent guest's own idle self-exit.
- 93e7694: Landing on a studio project now wakes its preview: the once-per-open session broker call reschedules a stale preview deploy (one dropped by a replica restart no longer leaves the pane on "Updating preview…" until the next edit) and warms the preview agent's sandbox through the platform's client-config broker, so an idle-evicted preview is booting before the Preview pane's iframe asks for it.
- 77b0a80: Fix four sandbox-lifecycle defects found by stress testing: a stale studio chat token signing the user out, a silent TTS drain timeout, an unhandled publish-sandbox failure, and an unreachable guest idle-exit override.
- 1673d91: Allow the Supabase auth origin in the studio page's connect-src, so magic-link sign-in is not blocked by CSP (it failed as a bare "Failed to fetch" with nothing on the server)
- c3f3c9a: Pin `SANDBOX_POOL_SIZE=0` in both Modal apps' image env: the warm sandbox pool stays disabled in production (no pre-warmed guest sandboxes). The `aai-server` Secret must not set `SANDBOX_POOL_SIZE`, since Secret values override image env and would silently re-enable the pool.
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [e2a473a]
- Updated dependencies [753665a]
- Updated dependencies [77b0a80]
- Updated dependencies [5cd6d50]
- Updated dependencies [77b0a80]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [8b622e8]
- Updated dependencies [29fa487]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [8b622e8]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [c3f3c9a]
  - @alexkroman1/aai@5.6.0
  - aai-studio-client@0.4.0
  - aai-server@3.4.0
  - @alexkroman1/aai-ui@5.6.0

## 0.4.1

### Patch Changes

- Updated dependencies [ea63c42]
- Updated dependencies [1a6f800]
  - aai-studio-client@0.3.4
  - @alexkroman1/aai@5.5.1
  - aai-server@3.3.1
  - @alexkroman1/aai-ui@5.5.1

## 0.4.0

### Minor Changes

- 6cca475: Storage redesign: each agent is one Postgres row (aai_platform.agents) — slug, credential hashes, config, content hashes, deploy version — committing content-addressed immutable blobs (blobs/<sha256>) in Storage. The row upsert is the deploy's atomic publish point; manifest.json/config.json and the slug_epochs table are gone (the deploy version is the cross-replica invalidation signal). Secret and storage changes no longer restart sandboxes: they take effect on the next deploy or sandbox rebuild.
- ae89dd9: Email login via Supabase Auth, for the studio and the CLI. The studio's browser bearer is now a session token (magic-link sign-in) resolved server-side to the user's stored AssemblyAI key (`user-key:<uid>` in Vault); connecting that key is the mandatory onboarding step after sign-in — every AssemblyAI key on the platform is user-provided, and the browser never holds one. `aai login` drives the same flow from the terminal via Supabase email OTP and saves the fetched key in the CLI config. A dev-token auth implementation keeps local dev Supabase-free. The guest chat surface is gated by a broker-minted per-session token instead of the caller's key. Slug-ownership hashes drop argon2id for plain SHA-256 digests (high-entropy machine keys need no slow hash), removing `@node-rs/argon2` and the verify cache. Raw API-key bearers keep working on every route.

### Patch Changes

- b425548: Simplify platform server internals: shared memoized-async helper, one broker dependency set, workspace lock moved inside mutateWorkspace, studio project middleware, cached user-key resolution, and dead-code removal
- Updated dependencies [a57905b]
- Updated dependencies [030b55f]
- Updated dependencies [966aeed]
- Updated dependencies [6cca475]
- Updated dependencies [afe0b6d]
- Updated dependencies [dcb1f99]
- Updated dependencies [c567faa]
- Updated dependencies [d303cfb]
- Updated dependencies [41d53ae]
- Updated dependencies [6cca475]
- Updated dependencies [ae89dd9]
- Updated dependencies [b425548]
  - @alexkroman1/aai@5.5.0
  - @alexkroman1/aai-ui@5.5.0
  - aai-server@3.3.0
  - aai-studio-client@0.3.3

## 0.3.4

### Patch Changes

- Updated dependencies [cb2de62]
- Updated dependencies [08dbc81]
- Updated dependencies [2198e2e]
- Updated dependencies [2198e2e]
- Updated dependencies [4076382]
- Updated dependencies [1d76583]
- Updated dependencies [5174cb2]
- Updated dependencies [2d7913d]
- Updated dependencies [aafe175]
  - @alexkroman1/aai@5.4.0
  - @alexkroman1/aai-ui@5.4.0
  - aai-studio-client@0.3.2
  - aai-server@3.2.6

## 0.3.3

### Patch Changes

- Updated dependencies [65a1a92]
- Updated dependencies [27c5963]
- Updated dependencies [27c5963]
- Updated dependencies [01d8a5f]
  - aai-studio-client@0.3.1
  - @alexkroman1/aai@5.3.0
  - aai-server@3.2.5
  - @alexkroman1/aai-ui@5.3.0

## 0.3.2

### Patch Changes

- e6e9cbf: Default the studio coding agent's LLM to gpt-5.5 on the AssemblyAI LLM Gateway (gpt-5-mini stays second; the EU default remains claude-sonnet-4-6)
- ffaae91: Give studio-spawned guest sandboxes the same burst-range resources as the agent app — test_agent and Publish builds run on them
- 2cedec1: Post-write type diagnostics in the studio coding agent: every successful write_file/edit_file type-checks the workspace (cold tsgo, coalesced) and appends hint-annotated diagnostics to the tool result; the standalone check_types tool is removed in favor of this plus test_agent.
- 99f3655: Stop cutting live calls on deploy, and make a deploy reach every replica.

  - A deploy/secret/storage mutation now **retires** the superseded sandbox
    instead of terminating it: it is detached from its slot synchronously (so no
    new session can be brokered onto it) and its remaining calls drain in the
    background before it shuts down, bounded by `SANDBOX_RETIRE_DRAIN_MS`.
  - The slot's idle timer now checks the slug epoch as well as the session
    count, so a deploy that landed on another replica is picked up within
    `IDLE_SANDBOX_MS` instead of only at that replica's next session broker.
    Previously a sandbox with continuous traffic was never reclaimed at all.
  - The shutdown drain counts sessions inside the guest sandboxes, not just
    WebSockets to the server process. Sessions dial the sandbox tunnel
    directly, so the old count always read zero and scale-in tore down live
    calls immediately despite a 120s drain budget.

- Updated dependencies [99f3655]
  - aai-server@3.2.4
  - @alexkroman1/aai@5.2.0
  - @alexkroman1/aai-ui@5.2.0

## 0.3.1

### Patch Changes

- Updated dependencies [ee903c5]
  - aai-server@3.2.3

## 0.3.0

### Minor Changes

- a96e9f8: Studio preview mode: edits auto-deploy to a per-project preview agent; Publish is production-only.

  - Every settled edit (the coding agent's turn-complete workspace sync — now flagged `done: true`, the analog of opencode's `session.idle` / codex's `agent-turn-complete` — and editor file writes/deletes) schedules a coalesced, fire-and-forget deploy of the workspace to `<project>-preview` through the same in-guest `aai deploy` path Publish uses. Mid-turn checkpoints never trigger deploys, so half-finished trees are never previewed.
  - The Live tab is renamed Preview and frames the preview agent, keyed by a `previewVersion` token so a fresh preview reloads the iframe exactly once; the client polls while a preview deploy is in flight, and failed preview builds surface their CLI output in the pane banner.
  - The production URL in the top bar stays a plain link that opens the deployed agent in a new tab, and the Secrets panel mirrors writes to the preview slug so previews run with the same third-party keys.

### Patch Changes

- b4cec81: Simplify aai-server internals: shared matchAnyHash/withLock/sleep/answerUpgrade/brokerSessionUrl helpers, epoch-guarded cache helper with in-flight manifest sharing, safeJsonParse adoption, OwnedMap.owns at slot identity checks, and removal of dead options and stale comments
- 31cdbaf: Tag Modal sandboxes with a role (agent, preview, studio, studio-publish, inspect, pool) alongside the slug, and re-tag pooled sandboxes on acquire, so the Modal dashboard distinguishes production agents from previews, studio sessions, and warm-pool spares
- Updated dependencies [e47a187]
- Updated dependencies [b829155]
- Updated dependencies [d78137f]
- Updated dependencies [a96e9f8]
- Updated dependencies [b4cec81]
- Updated dependencies [ab577dc]
- Updated dependencies [31cdbaf]
  - @alexkroman1/aai-ui@5.1.1
  - @alexkroman1/aai@5.1.1
  - aai-studio-client@0.3.0
  - aai-server@3.2.2

## 0.2.4

### Patch Changes

- 38c1b97: Auto-create studio projects from the first chat message with server-generated v0-style names (prompt-derived base + random suffix) at shareable /studio/chat/<name> URLs; slugless CLI deploys now generate slugs from the agent's config name via the same shared generator.
- Updated dependencies [675ac6d]
- Updated dependencies [38c1b97]
- Updated dependencies [0b39214]
  - aai-studio-client@0.2.1
  - aai-server@3.2.1

## 0.2.3

### Patch Changes

- 57c8b03: Forward Modal container stop signals to the node server so guest-sandbox teardown actually runs on scale-in/redeploy — orphaned sandboxes no longer linger as 2-3 MiB sleep-infinity shells for the ~20-minute orphan + idle window on every deploy
- Updated dependencies [8fb0a0d]
- Updated dependencies [fa3f3fd]
- Updated dependencies [ac21a90]
- Updated dependencies [3bc83bb]
- Updated dependencies [57c8b03]
  - @alexkroman1/aai@5.1.0
  - aai-server@3.2.0
  - @alexkroman1/aai-ui@5.1.0

## 0.2.2

### Patch Changes

- fb4c14c: Resolve the public origin through aai-server/public-origin instead of the in-container request URL, so studio Publish deploys over https and keeps its Authorization header, and the bare-slug redirect stops downgrading the scheme. Version bump so both Modal apps redeploy.
- Updated dependencies [fb4c14c]
- Updated dependencies [fb4c14c]
  - aai-server@3.1.2
  - @alexkroman1/aai-ui@5.0.1
  - @alexkroman1/aai@5.0.1

## 0.2.1

### Patch Changes

- 23a3a5d: Fix Modal containers crashing at startup with ModuleNotFoundError: mount scripts/modal_image.py into the container image via add_local_python_source so the deploy script's import resolves when Modal re-imports it inside the container.
- Updated dependencies [23a3a5d]
  - aai-server@3.1.1

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
- fdd64ef: New package: the studio service (browser coding agent, workspace builds) split out of aai-server, with its own Modal app, scaling policy, and changeset-gated CI deploys. Also hosts the combined single-process entry used by local dev.
- 293da11: The studio LLM now runs exclusively on the caller's own AssemblyAI API key
  (the request bearer) via the LLM Gateway — the platform holds no studio LLM
  credential: the `ASSEMBLYAI_API_KEY`/`ANTHROPIC_API_KEY` host fallbacks,
  `STUDIO_LLM_PROVIDER`, and the chat 503-when-unconfigured path are removed
  (`STUDIO_LLM_MODEL`/`STUDIO_LLM_REGION` remain as host model config). With
  `web_search` now keyless, the dev-boot key check (`assertDevKeys`) is
  removed from both services.
- cc71fab: Workers ship their own SDK runtime, and all studio builds run in the guest sandbox through the aai CLI's bundlers.

  - `buildWorker`'s wrapper entry now bundles the user's installed SDK runtime behind an `__aaiCreateRuntime` export; the guest harness builds sessions through that factory and embeds no runtime of its own, so platform SDK drift can no longer break deployed agents. Bundles without the factory are rejected at `bundle/load`.
  - The studio's out-of-process build subsystem (build runner/entry/protocol/cache, the import-allowlist worker build, the host client build, and the `studio_build` Modal Function) is deleted. `test_agent` builds the live workspace in the guest; Publish builds via the new host→guest `workspace/build` RPC, which also returns the bundle's config self-description — no throwaway inspection sandbox on the studio path.
  - The guest snapshot image now bakes the build toolchain (`@alexkroman1/aai-cli` + workspace-facing packages) next to the harness; versions derive from aai-guest's own dependencies.
  - `MAX_WORKER_SIZE` rises to 30 MB; `evalWorkerBundle` imports workers via a temp `file:` URL (the bundled runtime's CJS interop rejects `data:` URLs); the dev server opts out of runtime inlining to keep watch rebuilds fast.
  - Studio Publish now runs the literal `aai deploy` CLI inside the project's sandbox (`workspace/deploy`), and the CLI's output is posted into the chat so the coding agent sees deploy errors. `aai deploy` gains `--allow-missing-secrets` (server-side `credentialPolicy: "warn"` in the deploy body), and deploy responses now carry preflight `warnings`.
  - The studio's storage toggle and routes are removed — storage is CLI-only (`aai storage enable`). Deployed-agent secrets move to their own Secrets panel backed by the platform's `/:slug/secret` routes; every change posts a note into the chat (key names only).
  - `aai build` and `aai deploy` now type-check the project (`tsc --noEmit` with its own tsconfig and compiler; `--skipTypecheck` opts out), as does the studio's `test_agent`. Studio workspaces are completed into real projects in the guest (package.json, tsconfig.json, global.d.ts, vite.config.ts — scaffold-mirroring, existing files win).

### Patch Changes

- 52d60d6: Studio coding agent: edit_file gains replaceAll for cross-file renames, and a todo_write task-list tool (with prompt guidance) tracks multi-step requests
- a2c387a: Move the studio_build Modal Function into the studio app (aai-studio-web) so the build entry's code and its deployment version together — a changeset touching aai-studio-server previously redeployed the studio service but left the agent app's studio_build function running the old entry.
- 293da11: Run the studio coding agent's CPU-bearing tool work off the main thread:
  `grep`'s regex scan and `edit_file`'s fuzzy matching + Myers diff now
  execute on a dedicated scan worker thread with a hard
  `worker.terminate()` deadline (2s). Previously both ran model-controlled
  input through superlinear algorithms on the server's event loop, where a
  catastrophic regex (`(a+)+$`) could pin every session on the process
  indefinitely and a large mostly-different edit stalled it for ~7s — and
  the per-tool pTimeout cannot stop either, since a promise race needs the
  event loop the computation is pinning. Worker failures cross the thread
  boundary as classified wire data and rehydrate to the same
  `StudioGrepError`/`StudioEditError` the sync implementations throw; the
  presentation diff additionally self-elides at 500ms (jsdiff `timeout`) so
  an oversized-but-legit edit still applies. Invalid globs now surface as
  actionable `StudioGrepError`s instead of unclassified throws.
- 78af4d2: Developer mode on macOS now runs guest sandboxes in local Apple containers (via the container CLI) instead of Modal; SANDBOX_BACKEND overrides the selection.
- Updated dependencies [fdd64ef]
- Updated dependencies [c36ad60]
- Updated dependencies [9b95fc9]
- Updated dependencies [5a599b2]
- Updated dependencies [fdd64ef]
- Updated dependencies [fdd64ef]
- Updated dependencies [e8fef4b]
- Updated dependencies [0c2bdbd]
- Updated dependencies [25938b2]
- Updated dependencies [df753ce]
- Updated dependencies [fdd64ef]
- Updated dependencies [0c2bdbd]
- Updated dependencies [fdd64ef]
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
- Updated dependencies [a2c387a]
- Updated dependencies [d4c2a10]
- Updated dependencies [338a61e]
- Updated dependencies [0c2bdbd]
- Updated dependencies [e8fef4b]
- Updated dependencies [293da11]
- Updated dependencies [e8fef4b]
- Updated dependencies [fdd64ef]
- Updated dependencies [293da11]
- Updated dependencies [30914c9]
- Updated dependencies [fdd64ef]
- Updated dependencies [0c2bdbd]
- Updated dependencies [cc71fab]
- Updated dependencies [78af4d2]
  - aai-server@3.1.0
  - @alexkroman1/aai@5.0.0
  - @alexkroman1/aai-ui@5.0.0
  - aai-studio-client@0.2.0
