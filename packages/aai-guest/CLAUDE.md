# packages/aai-guest — guest harness guide

The Node entrypoint that runs the complete agent inside each Modal Sandbox
(private package). How the host spawns and supervises it is in
`packages/aai-server/CLAUDE.md`; the studio coding agent that runs in studio
mode is in `packages/aai-studio-server/CLAUDE.md`.

## The harness: one binary, two modes

The Node guest entry point (runs inside a Modal Sandbox) runs the COMPLETE
agent. ONE BINARY, TWO MODES, selected by the spawner via `AAI_GUEST_MODE`
(behavior selection, never a security boundary — capability is what the host
delivers):
  **agent mode** (deployed agents — see "Agent guests are servers") boots
  from files delivered at exec time and serves only the public session
  surfaces — `/websocket` for browsers and `/phone` for carrier media streams,
  both from the SDK's own `createRuntimeServer` — plus the token-gated
  `/manage/status` + `/manage/drain` pair (`harness-agent-mode.ts`);
  **studio mode** serves
  `/ws` (bearer-token host control channel — JSON-RPC
  `workspace/deploy` (Publish's in-guest `aai deploy`), `status`,
  `studio/session-init`; guest→host
  `studio/sync-workspace`, `studio/persist-chat` — bundle loading and tool
  trials are harness-internal now, driven by the in-guest coding agent,
  not RPC),
  `/session` (PUBLIC client voice sessions, connected directly by
  browsers — the embedded SDK runtime drives STT/LLM/TTS in-guest), and
  `/studio/chat` + `/studio/tools` (the studio coding agent's PUBLIC chat
  surface, bearer-gated by the broker-minted per-session chat token — see
  `packages/aai-studio-server/CLAUDE.md`), plus `POST /studio/session-init`,
  the HTTP twin of the `studio/session-init` RPC gated by the per-sandbox
  HOST token, for the replica that does not hold this guest's single control
  socket (see
  `packages/aai-studio-server/CLAUDE.md`, "One studio sandbox per project,
  fleet-wide").
  `harness.ts` (servers + dispatch), `harness-agent-mode.ts` (agent-server
  boot, manage surface, idle/drain lifecycle), `trial.ts` (run_code
  executor + one-shot tool trials), `harness-rpc.ts` (guest→host request
  proxy), `studio-session-init.ts` (the HTTP install route + the guest's own
  (scope, project) identity pin), `studio-http.ts` (shared CORS + bounded
  body read for both `/studio/*` surfaces),
  `studio-agent.ts`/`studio-chat.ts`/`studio-tools.ts`/`studio-edit.ts`/`studio-grep.ts`
  (the in-guest coding agent), `studio-build.ts` (in-guest workspace
  builds through the aai CLI bundlers), `studio-publish.ts` (Publish =
  the literal `aai deploy` CLI, run in-sandbox), `limits.ts` (constants —
  import-free except the workspace caps, re-exported from
  `@alexkroman1/aai/workspace-files` so the CLI's push, this sync and
  the platform's validation cannot disagree). The harness embeds NO agent
  runtime — every worker
  bundle ships its own (`__aaiCreateRuntime`, see "User-shipped runtime"
  below) — and tsdown bundles the harness (server shell + studio coding
  agent) into the single `dist/harness.mjs` the server resolves via
  `aai-guest/harness` and bakes into the snapshot image, keeping the build
  toolchain (`@alexkroman1/aai-cli`, the client-build plugins) EXTERNAL:
  it resolves at runtime from the node_modules next to the harness

**Error text comes from the SDK's `errorMessage`, never a local copy.** This
package had three implementations of it at once: a local `errMsg` in
`harness-rpc.ts` used at 33 sites, a hand-inlined ternary in
`studio-session-init.ts`, and — in `harness-crash-guards.ts` — the real
`errorMessage` from `@alexkroman1/aai`, imported under an alias. The local
one was strictly weaker: `errorMessage` also unwraps a non-`Error` object
carrying a string `message`, which is exactly what a thrown value looks like
after crossing this module's own JSON-RPC boundary, and `errMsg` rendered
those as `[object Object]`. One name, one import, and the behaviour is
covered once in `sdk/utils.test.ts`.

**The two files a Publish writes for the CLI come from the CLI'S OWN
writers** (`@alexkroman1/aai-cli/project-config` — `writeConfigHome` and
`updateProjectConfig`). `studio-publish.ts` used to `JSON.stringify` both the
dir-local config home and `.aai/project.json`, so their shapes agreed with the
schemas the CLI parses them back with only by coincidence — and the two
properties that matter are not visible in the JSON at all: the config home
holds the caller's API key and is written **0600 through an atomic rename**
(which TIGHTENS an older world-readable file rather than leaving it), and the
project pin is **merged, never replaced** (`.aai/project.json` also carries the
studio link fields, which a whole-document write drops). Reaching for the
toolchain is safe on this path specifically because `resolveCliEntry()` runs
first and has already failed the publish cleanly if it is not there — so the
dynamic import is deliberately AFTER it. Anything else this package writes for
the CLI to read belongs in that subpath too, not in a `JSON.stringify` here.

## The coding agent is an ordinary `agent()`

The studio builds voice agents with this SDK, and for a long time it was the
one agent in the repo that did not use it. `studio-chat.ts` assembled a
`streamText` call by hand: it resolved the LLM descriptor itself, adapted the
SDK's web builtins into AI SDK tools through a context whose `db` and
`generate` both rejected, wrapped every tool in its own 120s deadline, carried
its own copy of tool-call repair, and re-derived the step budget. Every one of
those is something `agent()` plus `createTextAgent`
(`@alexkroman1/aai-runtime`) already is — so each was a second implementation
of a shipped rule, free to drift from it, in the process whose whole job is to
demonstrate the SDK.

`studio-agent.ts` is the definition now (`text: true`, the session's system
prompt, the gateway model, `maxSteps`, `builtinTools`, and the four tool
families), and `studio-chat.ts` is the HTTP surface plus one turn's delivery.
What that moved into the SDK, in the order it bites:

- **Tools are SDK `ToolDef`s** (`tool()` from `@alexkroman1/aai`), so they run
  through `executeToolCall` like any agent's: Standard Schema validation,
  argument coercion, `ctx` (`env`/`state`/`db`/`generate`/`messages`/`signal`),
  the per-call deadline, and a THROW shaped into `{"error": …}` the model can
  read. A spec must therefore call `runTool` (`_test-utils.ts`) rather than
  `execute` directly — several of them depend on that shaping, and reaching
  past it asserts against a path production does not take.
- **The web builtins are NAMED, not adapted.** `builtinTools:
  ["visit_webpage", "get_page_design", "web_search"]` is the whole of it.
- **`generate_design_inspiration` uses `ctx.generate`** instead of taking a
  `LanguageModel` beside the one the turn runs on — one way to reach the
  model, so the brief cannot be generated by a different one than the reply.
- **The 120s tool deadline is `toolTimeoutMs`** on `createTextAgent`, not a
  wrapper around the merged set. The SDK's own default is 30s, which is a
  VOICE budget; these tools install packages and type-check workspaces.
- **Tool-call repair is the SDK's**, and the studio's cheap JSON-salvage tier
  went WITH it (`aai/host/tool-call-repair.ts`) rather than being left behind:
  a whole source file inside a JSON string is not a studio-shaped problem, it
  is just the largest tool argument anything sends.

One behaviour CHANGED rather than moved, and it is the SDK's rule arriving:
the step budget is now `maxSteps + 1` with `toolChoice: "none"` forced on the
extra step. `stopWhen: stepCountIs(80)` alone ended a capped turn wherever the
budget ran out — including straight after a tool result, with nothing said —
and that turn completed *successfully*, so the user saw the agent simply stop.
The reserved step still has every tool result in context and no move left but
to answer. (Same rule and same code as the voice pipeline; see
`DEFAULT_MAX_STEPS` in `packages/aai/CLAUDE.md`.)

Two things stayed here, because they are genuinely the studio's: the
**wall-clock turn budget** (`studio-turn-budget.ts`, passed as an extra
`stopWhen` — the agent's step cap still applies alongside it) and
**compaction** (`studio-compaction.ts`, in the turn's `prepareStep`, which the
SDK composes its reserved final-answer step over rather than replacing).

**Compaction is TWO TIERS, and the cheap one is the SDK's `pruneMessages`.** The
bulk in a build loop is tool RESULTS — a tsc dump or a build log, one per attempt
— and the original implementation reached straight for an LLM summarizer, paying
a call to compress text whose location was already known. `pruneMessages` drops
exactly those (older than the recent window, removed in PAIRS by `toolCallId`, so
nothing is orphaned), deterministically and free; the summarizer runs only if the
estimate is still over budget, which is the long-conversation case it was really
for. Tier 1 is acceptable as a substitute because `streamText` emits the agent's
TEXT alongside its tool-call, so pruning keeps the narrative ("attempt 3: fixing
the import") and drops only the payload.

**Its cut points have to fall on turn boundaries**, which the index-based version
did not. Tier 2 splices `[...leading, summary, ...recent]` into a conversation
shaped assistant(tool-call) / tool(result), alternating — so a `recent` window
beginning on a tool message emitted a result whose call went into the summary, and
both providers reject an unmatched tool result outright. Same failure `capLlm`
documents in `aai/host/transports/pipeline-history.ts`, by a different route. One
check covers both cuts: a cut at index `i` is safe iff `messages[i]` is not a
`tool` message, because an assistant carrying tool-calls is always followed
immediately by its results — so that test also rules out the mirror-image
error, a call nothing answers. Both boundaries move OUTWARD, so an adjustment
only ever keeps more verbatim.

`STUDIO_TOOL_LABELS` and `MUTATING_TOOLS` are checked against
`createStudioAgent`'s real tool surface, not a hand-merged copy of it — the
merge they used to be compared against was a second place the tool set was
written down.

**The post-write checker is built ONCE, in `createStudioAgent`, and handed to
both write-shaped tool families** (`createStudioTools`, `createTemplateTools`)
as `diagnostics`. It hangs off a `createCoalescingRunner`, and the entire point
of that runner is that concurrent writes share ONE follow-up compiler pass —
which two independent runners cannot do. Both factories used to call
`createPostWriteDiagnostics(deps.typecheck)` for themselves, so a parallel burst
of `write_file` + `use_template` silently paid two `tsc` runs where the module
doc promises "worst case two checks, never one per file". Pass the CHECKER down,
never the `typecheck` function.

**The scripts a check can speak for are one set**, `isScriptFile` in
`studio-syntax.ts`. It was written out three times — the syntax gate, the
post-write diagnostics, the post-copy check — two of them commented as mirroring
one of the others, which is the shape a set takes just before it stops
mirroring.

**A "toolchain unavailable" verdict is never remembered.** `loadTransformer`
memoizes the resolve and CLEARS the memo on rejection, exactly as `loadToolchain`
does in `studio-build.ts` — and for a sharper reason than "the image might have
no toolchain", which is permanent anyway: `createRequire` is anchored at the
WORKSPACE, which a session re-install deletes and rebuilds, so a resolve racing
one can fail transiently. Caching that `null` disabled the write-time syntax gate
for the life of the process, silently, and every later write was accepted
unparsed — the one failure the module exists to prevent. Note this is not covered
by a test: vitest patches `createRequire`, so `require.resolve("vite")` succeeds
from any directory and the failure cannot be provoked in that tier.

**Every child that runs workspace-authored code gets a scrubbed env.**
`workspaceChildEnv()` (`studio-spawn.ts`) is a 24-name ALLOW-list, and `bash`,
`runNpm` and the workspace TEST RUN all take it; the in-guest deploy child takes
`cliChildEnv()`, which is stricter still — `PATH` plus the three names
`os.tmpdir()` reads, that last part being what keeps the CLI bundler's ~8 MB
`mkdtemp` off the microVM's 512 MiB RAM disk. The
test run was the one spawn site outside the policy for a while, and the files it
executes are the coding agent's own `*.test.ts`. It is defence in depth rather
than a boundary — `bash` can read `/proc/<pid>/environ` regardless — which is
exactly why it should be uniform: an exception here is not a smaller hole, it is
an unexplained one.

## One claim on the workspace at a time — turns AND re-installs

`createTurnGate` (`studio-turn-stream.ts`) holds a single process-wide claim,
taken through `enterTurn()`. TWO things take it, and the second is the one that
was missing: a chat turn, and `initStudioSession`.

The turn half is the older story — two tabs streamed turns into one sandbox, two
agents edited one workspace, and the settles raced, so the loser's turn was
absent from the stored conversation. The second turn is REFUSED (423) rather
than queued, because a waiting request would run with a conversation snapshot
taken before the turn it waited for and would clobber it on settle anyway; the
queue that makes sense is the one in the tab, where messages are re-read at
dispatch.

The re-install half is what `POST /studio/chat`-only gating missed.
`initStudioSession` opens with `materializeWorkspace`, which is an `rm -rf` of a
path that is CONSTANT PER PROCESS — so a refresh or a second tab sending
`studio/session-init` to the live sandbox deleted the very directory the
in-flight turn's tools had closed over. Every edit since the last checkpoint
gone; a tool handed ENOENT one call after reporting success; `buildWorkspaceDir`
given a half-populated tree, so the agent started "fixing" phantom build errors;
and `settleTurn` syncing the mixed result back with `done: true`, which is what
auto preview deploys key off. So a session-init that cannot take the claim keeps
the live tree and re-points the session at it, taking only the new config (chat
token, system prompt, model).

**Keeping the tree is the CORRECT answer, not merely the safe one.** Mid-turn
the guest's tree is ahead of the store, so resetting to the store's files is
restoring a stale snapshot over newer work. The tab that asked for the install
still gets a working session; its first turn is refused 423 until the running
one finishes, which the browser already handles
(`aai-studio-client/src/resilient-fetch.ts`).

**Take the claim, do not read a flag.** The gate carried a `busy` reader that no
production code ever consumed — a test affordance in the shape of an API — and
reading it here would still have left the mirror race open, a turn starting
while the tree is half materialized. Holding it across the whole preparation
closes both directions, which is why `TurnGate` is now `enter()` alone.

## A workspace's own package.json is REIFIED, not just read

`studio-workspace-deps.ts` runs `npm install --omit=dev` in the workspace when
anything its `dependencies` declare is missing, and it runs wherever a workspace
is prepared to be built: `initStudioSession`, `deployWorkspaceDir` (Publish),
and `buildWorkspaceDir` (`test_agent`).

**Declaring a dependency used to be the easy half.** The only thing that ever
put a package on disk was `add_dependency` running in that exact directory, in
that exact session — and a workspace directory survives neither boundary it has
to cross. `materializeWorkspace` opens with `rm -rf`, so a session RE-install (a
page refresh, a replica taking the session over) deletes `node_modules` while
package.json goes on declaring what used to be in it; Publish builds a FRESH
directory from the store snapshot (`withBuildDir`) that never had one; and a
project pushed with `aai push` arrives with a manifest whose dependencies were
only ever installed on a laptop. The worker bundle is built
`ssr: { noExternal: true }` — everything is bundled, because the guest that
loads it has no node_modules — so the missing package is not externalized but a
hard `Rolldown failed to resolve import "ms"`, naming a dependency the manifest
plainly declares. **The agent tested fine and Publish died**, which is the worst
shape that failure could take.

**The whole mechanism is one `npm install`, and that is only viable because the
workspace manifest declares nothing but the workspace's own packages.** The
platform's six (`WORKSPACE_DEPENDENCIES` in `studio-project-shape.ts`) resolve
from the toolchain `node_modules` above every workspace, and leaving them
undeclared is what keeps this cheap: npm reifies whatever manifest it reads, so
adding one small package costs **451ms and 28 KB** without them against **25s
and 156 MB** with. They used to be pinned in purely so they could be READ, and
that one documentary choice is what made everything expensive — including
`add_dependency`, which dropped from **28s / 202 MB to 3.8s / 28 MB** when they
came out. Both readers it served are covered elsewhere: the studio prompt lists
what is preinstalled, and `aai pull` fills the manifest in per entry from the
scaffold (`mergeScaffoldManifest`), which is where a laptop's versions belong.

That also retired `reconcileWorkspacePins`, whose whole job was keeping those
pins fresh so a stale one could not materialize an old SDK over the baked copy.

**An intermediate version of this staged each missing package into a separate
shared manifest one directory up and ran npm once per package**, to work around
the reification the pins forced. It needed spec validation, per-package runs,
un-staging, failure memoization, per-process scoping and a hoist/shadow check —
seven mechanisms, all downstream of declaring six packages that did not need
declaring. If any of them looks necessary again, check first whether the
manifest has grown platform-owned entries.

What remains, and why:

- **`--omit=dev`.** `devDependencies` are the toolchain (vite, typescript,
  vitest, the `@types/*`), baked into the image. `ensureProjectShape` writes
  none, but a pushed project carries the scaffold's whole block.
- **A budget, and a shorter one for session-init.** The host abandons
  session-init at 30s (`ADOPT_TIMEOUT_MS`) or 60s (`SESSION_INIT_TIMEOUT_MS`)
  and it runs on EVERY page open, so that path passes
  `SESSION_INSTALL_BUDGET_MS` (20s): a slow registry degrades the install —
  reported through the warning, which is non-fatal — rather than failing the
  session.
- **A per-directory lock with an acquire deadline.** npm takes no lock of its
  own. The deadline is why the no-op path must NOT take the lock: a call with
  no work could otherwise fail on contention.
- **Presence, not version satisfaction, decides "missing".** That is npm's own
  rule for a tree it already reified — `npm install` is what reconciles a
  changed spec, and every path that changes one runs back through here.
- **A failed install WARNS, it does not throw.** A manifest can name a package
  no source file imports, and failing a publish over one would regress against
  the build that used to succeed by ignoring the manifest. The warning is
  prepended to a FAILING build or publish only (`withDependencyWarning`) —
  it is usually that failure's cause and reads far better than the bundler's
  bare "failed to resolve import", while putting it on a green one would train
  the reader to skip the line.

**A missing dependency's first symptom is TS2307, and it has a hint**
(`studio-diagnostics.ts`). `Cannot find module 'date-fns'` fires at the
typecheck gate before the bundler says anything, and the hint names
`add_dependency` — because installing is only half of what that tool does, and
the half that matters here is RECORDING the package in package.json, which is
what makes it survive a refresh and a Publish.

**Lockfiles do not sync** (`snapshotWorkspace` passes `isLockfile`). This is the
guest's one departure from its own walk, and it is not cosmetic: `npm install`
leaves a `package-lock.json` measured at **92 KB after one dependency and 101 KB
after three** — the bulk of every turn's sync payload, ~40% of the 256 KB
per-file cap, a file `read_file` can spend context on, and, since `aai pull`
materializes whatever the row holds, an npm lockfile landing in a project whose
package.json declares pnpm. `walkWorkspace` still shows it, because that one
backs `list_files`/`grep`; only the SYNC has a reason to drop it. Push's other
local-only rule, `.env`, deliberately does NOT apply here — the coding agent may
have written that file itself.

## The `run_code` executor (`trial.ts`)

- Executes **only inside the guest sandbox** (Modal/Node): the harness wires
  its in-sandbox executor into the runtime as `RuntimeOptions.runCode`
  (`run_code` is in `SANDBOX_ONLY_BUILTINS`). The old host-side `node:vm`
  execution was removed — `node:vm` is not a security boundary; the Modal
  container is.
- The host-side `execute` (`builtin-run-code.ts`) is a guard for the
  self-hosted path (`aai dev`), which has no sandbox — it refuses rather
  than evaluating attacker-influenceable code in the host process.
- The executor is a `new Function` async wrapper **inside a worker thread**:
  code runs with the **same authority as the rest of the sandboxed agent** —
  open egress, filesystem, env, child processes — and nothing more. There is
  deliberately no in-process capability stripping; the container is the whole
  boundary. (This is why the tool description promises only "output from
  console.log", not "no network/filesystem" — that claim would be false now.)
- **5-second execution timeout, enforced by `terminate()`, not by a promise
  race.** This is the one thing about `run_code` worth reading twice. The
  executor used to run in the harness process under `pTimeout`, and that bounds
  nothing a timer can outlive: an async IIFE runs SYNCHRONOUSLY up to its first
  `await`, so model-authored code with no `await` in it — `while (true) {}` —
  never yields, and the timer that was supposed to stop it can never be reached
  to fire. It wedged the WHOLE GUEST: `/health` stopped answering, every
  concurrent voice session on that sandbox stalled, and `createIdleController`'s
  interval never ticked, so the guest could not even self-exit and burned to
  Modal's lifetime cap. A worker thread is the only thing in Node that can be
  stopped mid-loop. The costs are priced in: one isolate spawn (tens of ms) per
  call, and no shared globals BETWEEN calls — the model's code gets its own
  `process.env` copy, and a `setInterval` it leaves behind dies with the worker
  instead of pinning the harness alive.
- **The worker body is a string constant, not a sibling file**, because the
  harness ships as one bundled artifact (`codeSplitting: false`) with no second
  file to start a worker from. The model's code travels as `workerData` and is
  never spliced into that source — a quote in the agent's program must not be
  able to end the harness's.

## Why the buffer lives in the guest

`harness-logs.ts` tees both process streams into a bounded, cursor-indexed ring
(`createLogBuffer`, `@alexkroman1/aai-runtime`) and `GET /manage/logs` serves
it — the source behind the studio's Logs pane and `aai logs`.

**The obvious alternative does not work on this platform.** A guest's stdout has
always reached the host (`startGuestLogging` drains both streams into the
platform's log the moment the process exists); what it could never reach is the
person who wrote the tool. Buffering it host-side, next to that relay, fails for
the same reason `sandbox-directory.ts` exists: a sandbox is resident on ONE
replica, and a replica that does not hold it never proxies for the one that does
— it looks the sandbox up and dials the sandbox's own tunnel. So a host-side
buffer is readable from exactly one replica of N, chosen by which one happened
to spawn the guest. A buffer in the GUEST is reachable from all of them, by the
same URL everything else uses.

**What that costs, said plainly.** The ring dies with the sandbox, and an agent
guest self-exits on idle — so this is "what my agent printed recently", never
"what it printed last Tuesday". And a bundle that throws at LOAD exits before
the server binds, so its stderr is only in the host log; the studio reports that
case through `previewError` instead.

**The coding agent reads ANOTHER guest's ring, and never its own.** `read_logs`
(`studio-logs-tool.ts`) is the studio agent's window onto the agent it is
BUILDING — a tool throwing on a live call, a missing provider key, the
`console.error` on the branch nobody exercised, none of which `test_agent` can
see, because it loads the bundle in this sandbox. It is a host RPC
(`studio/agent-logs`) rather than a fetch: the logs belong to the project's
deployed preview or production sandbox, and this guest knows neither its slug
nor the platform origin. So the guest names an ENVIRONMENT and the host resolves
the rest from the (scope, project) this sandbox is pinned to — see "The guest
never names a slug" in `aai-studio-server/studio-agent-logs.ts`.

**Capture is a `write` tee, not a console patch.** `console.log`, an uncaught
exception's trace, and a dependency writing straight to the fd all funnel
through `process.stdout.write` / `process.stderr.write`; patching `console`
catches only the first, and the traces are the half worth reading. The original
write still runs, so the host relay and Modal's own log see what they always
saw. `main()` installs it before anything else can write — every line produced
earlier is a line the pane cannot show.

## Turning a deployed guest's debug logging ON

`AAI_DEBUG` on the PLATFORM SERVER's env is forwarded into an agent guest's boot
env by `agentBootEnv` (`aai-server/warm-harness.ts`), following
`AAI_GUEST_IDLE_EXIT_MS`: read from the server's own environment, forwarded only
when set, and otherwise absent. It is not env inheritance — a guest inherits
nothing, which is the property that keeps platform credentials out of a tenant
container and makes an agent that wrongly reads `process.env` fail locally the
same way it fails in production.

**It was unreachable before, and the reason generalizes.**
`debugLoggingEnabled` (`aai-runtime/runtime-config.ts`) is a module-level `const`
over `process.env`, read at import time; a deployed agent's OWN env arrives as
the boot file at `AAI_AGENT_ENV_PATH` and is parsed into an object handed to the
runtime, never merged into `process.env`. So every debug line in the runtime was
dead in every deployed guest — including `platform-rpc.ts`'s per-call
`{ label, route, traceId, status, elapsedMs }`, the only decomposition of the
guest→platform journal RPC anything measures, and the guest is the only place
that RPC happens. **Any future knob the runtime reads off `process.env` has the
same problem and needs the same one-line forward.**

Three things about the knob:

- **It takes effect at guest BOOT only.** The flag is read once at module load,
  so setting it on the server does nothing to a resident guest — the guest has to
  respawn (a redeploy, or an idle self-exit) before the value is read. Do not
  spend an hour on this.
- **It is per REPLICA, not per slug.** The value is the server's own, so it arms
  every agent guest that replica goes on to spawn.
- **One spelling, and one flag.** `LOG_LEVEL=DEBUG` — which
  `debugLoggingEnabled` also accepts — is NOT forwarded: it is a generic name a
  hosting stack sets for its own reasons, and forwarding it would make the
  platform's own log level arm per-message logging inside a tenant's guest.
  `AAI_DEBUG_PARTIALS` is not forwarded either, deliberately: it is one line per
  ~200 ms of speech and the runtime leaves it off even under `AAI_DEBUG=1` so the
  turn-level lines stay readable.

Read the output back off the host log (`startGuestLogging` drains both guest
streams into it) or through the guest's own ring — `aai logs`, above.

## The manage token is derived, not random

`AAI_GUEST_TOKEN` is HMAC over the sandbox's fleet-wide name
(`aai-server/guest-token.ts`), not `randomBytes(32)`.

Random put the token in one replica's closure and nowhere else, which quietly
made the whole `/manage/*` surface REPLICA-LOCAL — fine while its only callers
were retirement (which owns the resident) and a diagnostic probe, and four
requests in five wrong for a user-facing log pane. Deriving it from
`agentSandboxName(slug, version)` — already the identity `sandboxes.create`
races on — lets every replica compute the same answer from a slug and a version
it reads out of the agents row.

Three properties are preserved: unguessable without the platform secret,
distinct per sandbox, and rotated on redeploy (the version is in the name). What
is given up is rotation on RESPAWN of the same version — a guest rebuilt after
an idle exit gets its predecessor's token. Small, and the token never leaves the
platform. An unset `AAI_GUEST_TOKEN_SECRET` falls back to a per-process key,
which is exactly the old behaviour, and boot announces it.

## A phone call is an ordinary session

The SDK's `aai/host/telephony/` — so `packages/aai/CLAUDE.md` owns the code, and
this guide holds the detail because the process that serves `/phone` in
production is this harness (and, under `aai dev`, the same
`createRuntimeServer`). Both of the other guides are at their length caps; the
platform's TwiML webhook route stays in `packages/aai-server/CLAUDE.md`,
"Telephony".

`WS /phone` (`host/telephony/`) accepts a carrier's bidirectional media
stream — Twilio Media Streams, Telnyx media streaming — and runs it as an
ordinary session. `createRuntimeServer` serves it by default, so `aai dev`, a
self-hosted server and every deployed agent all answer phone calls with no
per-agent configuration — the platform route above is only what points a carrier
at it.

**Nothing in the session stack knows about telephony, and that is the whole
design.** `ServerSession` talks to a `ClientSink`; `wireSessionSocket` talks to
a `SessionWebSocket`. So the adapter is a socket-shaped SHIM
(`createTelephonyBridge`) that speaks the client protocol on one side and the
carrier's JSON framing on the other, handed straight to
`runtime.startSession`. Turn-taking, barge-in, tool calls, the audio pacer and
its ordering rules, session eviction, keepalives, start timeouts and teardown
are not reimplemented for phone — a call gets them because it runs the same
code the browser does. Resist adding a telephony branch anywhere below the
bridge; if one seems necessary, the bridge is the wrong shape.

Four things that are easy to get wrong here, each of which was a decision:

- **Pacing stays ON.** A carrier accepts audio far faster than it plays it and
  buffers the rest — exactly the shape that made unpaced host-mode sessions
  destroy 36% of all agent audio (see "Host-mode audio pacing" in
  `packages/aai-cli/CLAUDE.md`): the
  backlog builds on the FAR side, where `PacedAudioSink.clear()` cannot reach
  it. So the bridge sets no `audioLeadMs` and a barge-in additionally sends the
  carrier's own `clear` frame, which is the only way to drop what it already
  holds. Without that frame the caller talks over an agent that keeps speaking
  for seconds after being interrupted.
- **The rates are LEARNED from the `config` frame**, not configured. The first
  thing any runtime sends a session is `{ sampleRate, ttsSampleRate }`, so the
  bridge builds its converters from that — which lets one adapter serve a
  16 kHz pipeline agent and a 24 kHz S2S agent, and avoids plumbing a rate
  through `createRuntimeServer`, whose runtime is a LAZY facade in the guest harness
  and cannot answer a rate question before the first session exists.
- **Downsampling must low-pass first, and both converters are STATEFUL**
  (`telephony/resample.ts`) — decimating without the filter folds everything
  above 4 kHz back into the speech band, and rebuilding a converter per 20 ms
  chunk puts a click at every boundary, 50 a second. That module's doc carries
  the measurement; `telephony/mulaw.ts`'s carries why the G.711 curve is kept
  sample-exact rather than approximated.
- **This does not contradict "the host does not resample"** (see the S2S
  section). That rule says rate conversion belongs at the EDGE, because every
  client owns its own rate and asking it to send the advertised one is cheaper
  and more honest. A carrier is the one client that cannot comply — 8 kHz
  μ-law is what the PSTN carries — and the bridge IS the edge. The rule put
  the conversion exactly here.

Adding a carrier is one `CarrierCodec` in `telephony/carriers.ts` and nothing
else — that module's doc owns the two properties every codec owes (decoding
NEVER throws, and a media frame on a non-`inbound` track is DROPPED) and why
these frames are narrowed by hand rather than by a Zod schema.

**Known gaps**, both deliberate: no `mark` frames, so `playback_progress` is
unused and the pipeline falls back to its open-loop estimate; and DTMF is
ignored rather than surfaced as a custom event.

## Dev/prod parity

**The guest IS the dev server — and the runtime IS the user's.** The
harness wraps the same `createRuntimeServer` (`aai/host/server.ts`) that `aai dev`
runs — health, `client-config`, and `/websocket` sessions — adding (per
mode) the `/manage/*` request hook or the `/ws` control channel, plus a
lazy runtime facade (`lazyRuntime` in `aai-guest/harness.ts`: the runtime
is built on the first session — a `test_agent` load carries an empty env).
The runtime itself comes from the BUNDLE (see "User-shipped runtime"
below), so dev and prod run the identical SDK version: the one in the
user's lockfile. In agent mode the bundle arrives at exec time — a file or
a signed URL, hash-verified either way (`harness-bundle-source.ts`); the
studio's test_agent loads its build in-guest through the same loader.
There is **no deploy-time inspection mode**: the platform stores no agent
config and never asks a bundle to describe itself (see "The platform stores
no agent config" in `packages/aai-server/CLAUDE.md`). Either way it
loads from a temp-file `file:` URL.

## User-shipped runtime

The worker bundle ships its own SDK runtime. `buildWorker`'s generated
wrapper entry exports `__aaiCreateRuntime` — a factory over the *user's
installed* SDK's `createRuntime`, bundled in with the provider SDKs (an SSR
Vite build: server resolve conditions, `node:` builtins external, dynamic
imports inlined via `codeSplitting: false`) — and the harness builds every
session through it. The harness embeds no runtime at all, so **platform SDK
drift can never break a deployed agent**: it runs exactly the runtime
version it was built and tested against, the same one `aai dev` ran.

- The harness↔bundle contract is deliberately tiny (`CreateGuestRuntime` in
  `aai-guest/harness-types.ts`): `{ env, db?, runCode?, publicUrl? }` in,
  `{ startSession, shutdown }` out. Keep it that way — everything else
  (provider resolution, tool dispatch, session state) is the bundle's SDK's
  business, on the bundle's SDK's version.

  **The membership rule is "a capability or a fact the HARNESS alone holds"**,
  which is what keeps "tiny" a principle rather than a number. `runCode` is the
  executor only a sandbox has. `publicUrl` is the URL only the SPAWNER knows —
  a guest's own origin is a loopback port behind a tunnel that changes on every
  respawn, which is exactly why the DevKit's `hook.url` is unusable off-box; it
  arrives as `AAI_PUBLIC_BASE_URL` in the exec env and `ensureRuntime`
  translates it into the SDK's own option name, so the SDK never learns an
  `AAI_*` key (see "Durable workflows" in `packages/aai-server/CLAUDE.md`).
  Every field is OPTIONAL for the same reason it is additive: an older bundle
  ignores what it does not read, and a newer bundle handed nothing degrades — an
  absent `publicUrl` makes `ctx.workflows.publicWebhookUrl` throw naming the
  option rather than failing the boot.
- A bundle without the factory is rejected at load ("rebuild with a
  current @alexkroman1/aai-cli"); there is no embedded-runtime fallback.
- Deploy artifacts are therefore ~8 MB minified before user code
  (`MAX_WORKER_SIZE` is 30 MB), and `evalWorkerBundle` imports workers via
  a temp `file:` URL — the bundled runtime's CJS interop calls
  `createRequire(import.meta.url)`, which rejects `data:` URLs.
- **That temp file is UNLINKED as soon as the import resolves.** Each load wrote
  ~8 MB into `tmpdir()` under a name unique per load (Node caches the module
  registry by URL, so a repeat load needs a new one) and nothing ever removed
  them — while the tool description tells the coding agent to run `test_agent`
  after every meaningful change, in a sandbox that lives for hours. Deleting is
  safe once `import()` has resolved: the module is compiled and instantiated,
  and the bundle's own `createRequire(import.meta.url)` uses the path only as a
  resolution ANCHOR. The one thing given up is Node printing the source line
  under a stack frame from inside the bundle. The module-registry retention is
  unavoidable; the on-disk copy was not.
- The dev server passes `runtime: false` to `buildWorker`: it builds its
  runtime in-process from the same installed SDK anyway, and inlining the
  runtime on every watch rebuild would make reloads multi-second.
  `aai build` / `aai deploy` / studio builds always ship it.

**Known remaining asymmetries**, none closable without larger work:

| Divergence | Direction | Why it stands |
| --- | --- | --- |
| Modal memory/CPU limits (`SANDBOX_MEMORY_LIMIT_MB`, `SANDBOX_CPU_LIMIT`) | works in dev, fails in prod | `aai dev` runs tools in the host process with no caps; a memory-hungry tool OOMs only when deployed. |
| `run_code` | fails in dev, works in prod | The host-side guard refuses rather than evaluating in-process. Fail-closed, so harmless. |
| `withHostCredentialFallback` (`providers/host-env.ts`) | works in dev, fails in prod | Deliberate ergonomic: an exported `ANTHROPIC_API_KEY` should work for `aai dev`. Two guards keep the cliff visible: the dev server warns when a required key resolved from the shell only (`agentEnvWarnings` in `_dev-server.ts` — it won't survive `aai deploy`, which uploads `.env`), and `aai deploy` preflights required credentials against the env it is about to upload (`aai-cli/_preflight.ts`), so the gap surfaces as a deploy-time warning naming the key rather than as an auth error at first session. It WARNS rather than rejects — the CLI cannot see secrets already stored server-side. |
| Durable-run backing (BYO `DATABASE_URL` in dev vs the platform's own database in prod) | different BACKEND, not a stricter one | Dev opens the DevKit's postgres world wherever the developer points it. A deployed guest reaches run storage, the queue, session state and upload records over HTTP and opens no tenant connection at all — so the per-app schema+role this row used to describe, and `ctx.db` with it, are gone. |
| Platform sandboxes need Modal credentials in production only | prod is stricter | `aai dev` runs tools in-process; the platform spawns real Modal sandboxes in production (`MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`), and an isolation-free child process in local dev — see `packages/aai-server/CLAUDE.md`, "Modal sandbox notes". |

## Agent guests are servers (no control channel)

DEPLOYED AGENTS spawn as servers (`spawnAgentServer` in sandbox-vm.ts;
guest side in `aai-guest/harness-agent-mode.ts`). The whole
platform↔deployed-agent contract, frozen per deploy by the harness image
pin and versioned by `GUEST_CONTRACT_VERSION` (additive changes only):

- **Boot**: the spawner writes the agent env as a FILE into the fresh sandbox
  (`sb.filesystem.writeText` on Modal, a scratch dir on the subprocess
  backend), then execs the harness with `AAI_GUEST_MODE=agent` + the artifact
  locations + the bundle's sha-256. The BUNDLE arrives one of two ways and the
  spawner picks by naming one env var or the other — `AAI_BUNDLE_PATH` for a
  file written the same way, or **`AAI_BUNDLE_URL` for a time-boxed signed
  Storage URL the guest fetches itself**, which is production's path and keeps
  ~8 MB from crossing the platform twice per cold spawn (see
  `packages/aai-server/CLAUDE.md`, "The guest fetches its own bundle"). The
  guest hash-verifies the bundle either way against `AAI_BUNDLE_SHA256` — the
  agents row's own record of what the deploy published — so it trusts the HASH
  and never the transport, and a mismatch is a hard boot failure rather than a
  silently different agent. It then loads the bundle BEFORE listening, and
  scrubs the env file. The two shapes are mutually exclusive on the wire on
  purpose: there is no precedence rule for either side to get wrong, and no way
  to point a guest at a path nobody wrote.

  Readiness is the guest's public `/health` answering 200 —
  polled by the host, raced against guest-process exit so a boot crash
  fails the spawn immediately with the guest's stderr in the host log
  (relayed from the moment the process exists — see `startGuestLogging`;
  draining only once the guest was READY discarded exactly the output that
  explains a boot failure).

  **How long a guest may take to boot and how long a CLIENT waits for it are
  separate budgets.** They were one number, so an agent whose top-level code
  blocks — never ready — hung every broker call for the full
  `AGENT_HEALTH_TIMEOUT_MS` (120s) before its 503, permanently. The broker
  caps its own wait at `BROKER_READY_TIMEOUT_MS` (20s, env overridable; 0
  waits for the whole boot budget) and answers 503 while the boot CONTINUES:
  the sandbox is already attached to its slot and reports `alive()` while
  pending, so the next call joins the SAME readiness promise instead of
  spawning a second sandbox. Tripping it on a healthy-but-slow boot costs one
  client reconnect, not a failure — `session-core.ts` re-brokers per attempt
  and only an ANSWERED lookup latches anything.
- **Ongoing surface**: `GET /manage/status` (live session count +
  draining + contractVersion — an operator/debugging probe; nothing
  host-side gates on it anymore) and
  `POST /manage/drain` (`?deadlineMs=` carries the retire budget the guest
  enforces itself), both gated by the per-sandbox bearer
  from the exec env. Nothing else — no WebSocket, no RPC, no host
  connection. The guest's public `/client-config` doubles as the broker's
  name/greeting source (proxied — see `packages/aai/CLAUDE.md`,
  "Pre-connection client config").
- **Lifecycle is guest-owned — the host runs NO idle machinery**: the agent
  guest self-exits after `AGENT_IDLE_EXIT_MS` (5 min; override by setting
  `AAI_GUEST_IDLE_EXIT_MS` on the SERVER, which `agentBootEnv` forwards into
  the guest's exec env — a guest reads only what it is handed at exec, so
  setting it on the platform process is what reaches BOTH backends) with
  zero sessions —
  this IS idle reclamation, not a backstop (the host's per-slot idle timers
  were deleted); the exit surfaces host-side as `onSandboxLost`, which
  detaches the slot, and the next broker call rebuilds it. A drained guest
  refuses new direct-dial sessions (close 1013 → the client re-brokers) and
  exits the moment it empties or at its drain deadline.

  **"Busy" is sessions PLUS running durable-workflow WALKS**
  (`createWorkflowActivity`, counted by `createIdleController` for both the idle
  window and a drain). A run the platform woke this sandbox for has no session
  at all (`aai-server/CLAUDE.md`, "Waking a run whose sandbox is gone"), so
  counting sessions alone made the wake nearly worthless: the guest exited five
  minutes into an hour-long run, mid-step, leaving the job locked until
  graphile-worker's 4-hour expiry let another worker rescue it.
  A drain's DEADLINE still wins — bounded work, not unbounded.

  **The unit is the WALK, and this guide used to recommend the bug**: it said
  settlement was "the response's `close` rather than `finish`, so an aborted
  callback releases the count". `close` really is the safer of those two, and
  both are facts about an HTTP RESPONSE rather than about the work — the
  platform aborts a delivery's `fetch` at `QUEUE_DELIVERY_TIMEOUT_MS` (60s) and
  the abort closes the response without stopping the walk. So a step longer
  than the idle window **never completed in production**: `inFlight` hit zero at
  60s, the guest exited `AGENT_IDLE_EXIT_MS` later mid-upload, and a fresh
  sandbox started the same 552 MB file again, forever. The parking gate is what
  made it reachable — before it, each redelivery started its own walk, so the
  count stayed up by accident at the price of duplicate provider calls.
  `createWorkflowActivity`'s doc carries the log timeline; the counter takes the
  work now (`activity.walk(() => deliver(runId))`) and settles in the walk's own
  `finally`. Two consequences worth knowing: a PARK is credited nothing (it never
  calls the walker, and crediting it would keep a guest alive for a walk nothing
  can see the health of — a leak in place of a livelock), and a walk whose promise
  never settles pins this guest until `SANDBOX_TIMEOUT_SECS`, which is deliberate
  — the bound a step ought to have is its own deadline.

  **A workflow guest also publishes a wake HINT** — the earliest time its queue
  could next have claimable work, written into its own `ctx.db` schema for the
  platform's wake sweep to read (`aai/host/workflow-wake-hint.ts`). Published
  once at boot (so a hint a killed guest never wrote is repaired by any boot)
  and after every queue callback, which is exactly when the answer changed.
  Only for an agent that declares workflows AND has a database: the local world's
  queue is in memory, so there is nothing outside the process to wake it for.
- **Redeploys hand over BLUE-GREEN** (`handoverSlot` in
  sandbox-resolve.ts): the agents-row change event boots the NEW deploy's
  sandbox and waits for its readiness before detaching the old one, so a
  redeploy never leaves an empty slot — the next caller lands warm while
  the old sandbox drains its calls in the background. A replacement that
  fails to boot retires the old resident anyway (an empty slot keeps the
  failure visible on the next broker call; silently serving superseded
  code would not).

## The snapshot image

Where the harness this package builds actually RUNS from in production. The
host side — `modal-harness-image.ts`, the content-addressed tag, per-deploy
pinning on `agents.harness_image_tag` — lives in
`packages/aai-server/CLAUDE.md`; what follows is the artifact itself, which is
this package's.

- **The harness AND the build toolchain are baked into a snapshot image**,
  not written per spawn, in two halves that cache differently. The
  TOOLCHAIN is a native image LAYER (`toolchainImage`: a
  `dockerfileCommands` `RUN npm install` into `/opt/aai/node_modules` — the
  aai CLI bundlers plus the workspace-facing packages), so Modal's own
  layer cache serves it and a harness rebuild — every
  server code change — no longer reinstalls ~15 packages. The HARNESS needs a
  throwaway builder sandbox, because the JS SDK's `dockerfileCommands` takes
  commands with no build context and there is nothing to `COPY` a ~13 MB local
  bundle from: a sandbox started from the layer writes it, its filesystem is
  snapshotted (`snapshotFilesystem`), and the image is `publish`ed under a
  content-addressed tag
  (`aai-guest-harness:<hash(base image, harness, toolchain)>`), so every
  later spawn — and every other replica, across restarts — resolves it with
  one `images.fromName` call. A new harness build, base-image change, or
  toolchain bump mints a new tag. This is the only harness-delivery path; a
  failed build fails the spawn loudly (memo cleared, next spawn retries).
  DEPLOYED AGENTS spawn from the tag recorded on their agents row at deploy
  time (`harness_image_tag` — per-deploy pinning, so a platform upgrade
  never changes the environment under an already-deployed bundle). An
  unresolvable pin FAILS the spawn loudly — silently substituting the
  current image is exactly the untested-environment drift pinning exists to
  prevent; the operator kill switch `SANDBOX_IGNORE_IMAGE_PINS=1` forces
  the current image for every spawn when a registry loss makes that trade
  explicitly. Studio sandboxes always run the current image.
- **The harness's V8 COMPILE CACHE is baked into the same snapshot.** The
  harness is one ~13 MB bundle and every sandbox boots it cold, so V8 paid the
  same parse+compile on every spawn. The builder sandbox now runs the harness
  once in **warm-up mode** (`AAI_GUEST_WARMUP=1` — evaluates the module, opens
  nothing, exits 0) under `NODE_COMPILE_CACHE`, before `snapshotFilesystem()`,
  and `guestExecBaseEnv()` points every guest exec at the resulting
  `/opt/aai/.compile-cache`. Measured on the real bundle: **~570ms → ~345ms**,
  i.e. ~200ms off every cold voice session and studio broker call, for
  ~1.5 MB in the image. Three things make it safe: a
  missing or stale entry is a silent MISS (the cache keys on Node version +
  file content, so a bumped base image simply misses), the warm-up is
  best-effort (a failure logs and still publishes — the cache is an
  optimization, and failing the build would take all spawning down for a
  perf tweak), and it is Modal-only, since the cache is a property of the
  baked image and the subprocess backend has no image.

  **Warm-up is a DECLARED mode, and both halves are tested, because the
  failure is invisible.** A warm-up that stops compiling the harness leaves a
  cache that is merely empty: the image builds, every guest boots, and the
  200ms comes back forever with nothing reporting it. It relied on the
  `AAI_GUEST_TOKEN` check to exit for us at first — true by accident, and it
  would silently rot the moment that check moved. So the mode is checked
  before every other mode in `main()`, and `modal-harness-image.test.ts`
  pins BOTH sides: the host asks for the warm-up before snapshotting (fake
  Modal), and the real built harness honours it with no token (real spawn).
  Note the fake sandbox had no `exec` at all when this landed, so the
  host-side assertion had to be added with it — without `exec` the warm-up
  threw into its own best-effort catch and every test stayed green.

- **The guest toolchain is LOCKED, and the lock is committed**
  (`packages/aai-guest/toolchain/{package.json,package-lock.json}`, regenerated
  by `pnpm sync:guest-toolchain`, gated by `pnpm check:guest-toolchain` in
  `scripts/check.mjs` AND the CI check job). Without it the resolved tree is a
  function of WHEN the layer was built, while the published tag and Modal's
  layer cache both key on the install command's TEXT — so one
  `harness_image_tag` could mean two different trees, the exact opposite of
  the per-deploy environment pinning the tag exists for. The install is
  therefore two steps, and the split is forced:
  - **Third-party packages: `npm ci` against the committed lockfile.** Their
    versions and integrity hashes are known at commit time, and this is where
    nearly all the transitive surface lives (vite/rolldown, typescript,
    vitest, react, tailwind). `npm ci` also refuses to run when the manifest
    and lockfile disagree, so a hand-edited manifest fails the BUILD.
  - **`@alexkroman1/*`: `npm install` at exact resolved versions.** These
    CANNOT be locked here — their versions change every release, and a
    lockfile entry needs an integrity hash that only exists once the version
    is PUBLISHED, which happens after the commit that bumps it. Their own
    dependencies (the provider SDKs) therefore still resolve at install time;
    closing that residual gap needs a post-publish regeneration step, not a
    lockfile in this repo.

  **Neither step runs a dependency's install scripts** (`--ignore-scripts` on
  both), and the npm that made that explicit is the npm in `node:26-slim`:
  11.19 REPORTS unreviewed install scripts and then runs them anyway — the skip
  in arborist is gated on an explicit deny — so `npm warn install-scripts 3
  packages have install scripts not yet covered by allowScripts` was a notice
  about code that had already executed in the build that produces every
  tenant's guest image. The second step is the sharp one, being deliberately
  unlocked: a hijacked transitive release arrives there with no integrity hash
  to fail against and none of the workspace's `minimumReleaseAge` quarantine.
  Skipping is safe and was MEASURED rather than assumed — all three packages
  that wanted scripts (`esbuild`, `@swc/core`, `cbor-extract`) ship prebuilt
  platform binaries resolved at REQUIRE time, so their scripts only validate
  what is already installed; on a scripts-skipped `node:26-slim`/x86_64 install
  the toolchain typechecked and built a workspace (10.45 MB worker, seven client
  files) and all three packages worked when exercised. `--strict-allow-scripts`
  with an `allowScripts` policy is the loud alternative and is WORSE here: the
  unlocked step can acquire a new script-carrying transitive with no commit to
  review it in, so the failure would land as a failed image build — a failed
  spawn for every cold session. The locked half gets the loudness instead, at
  commit time: `toolchain-install-scripts.test.ts` fails when this lockfile
  grows an install-script package nobody has vouched for, naming it (verified by
  injecting one). Note the flags are deliberately absent from the image TAG's
  fingerprint, which is pinned on agents rows, so an existing snapshot serves
  until the next harness bump — which every server code change is.

  Both files are written by the RUN itself, gzipped and base64'd (~20 KB), for
  the same reason the harness cannot be `COPY`'d: `dockerfileCommands` carries
  no build context. The image TAG hashes the lockfile's content, not the
  manifest's — the manifest names direct versions, the lockfile names the whole
  tree, so a purely transitive change still mints a new tag.
  Only the Modal backend needs this: the subprocess backend's harness runs
  from `packages/aai-guest/dist/` and resolves the toolchain through
  aai-guest's own `node_modules` — the same walk-up shape as `/opt/aai`, with
  nothing to build or mount. The `workspace-build-integration.test.ts` suite
  keeps the path covered on any runner by spawning the harness there directly
  and publishing through the real CLI to a real listening orchestrator.

## The image has an OCI recipe now, and nothing pulls it yet

`packages/aai-server/guest-image.Dockerfile` builds the same image the section
above describes, as a plain OCI image: `pnpm build:guest-image`.

**Why it exists.** A Modal image is not an artifact anything outside Modal can
resolve — it is assembled from `dockerfileCommands`, finished with a
`snapshotFilesystem()` of a throwaway sandbox, and published under a name only
`images.fromName()` answers. So no local backend could run production's guest
environment even in principle; it had to grow a SECOND toolchain delivery
mechanism, which is the cost that sank the previous local-container attempt (see
"Two tiers, deliberately" in `sandbox-backend.ts`). One OCI image inverts that:
the local backend and Modal pull the same reference.

**Two things get simpler, both because a Docker build has a build CONTEXT.** The
~17 MB harness is a `COPY` (measured: 0.2s) instead of a builder sandbox plus a
`filesystem.writeText` plus a `snapshotFilesystem()` plus a `publish()`; and the
toolchain manifest and lockfile are `COPY`s instead of a gzip+base64 blob
embedded in a `RUN echo … | base64 -d | gunzip` line.

**Pulling it is opt-in, and `GUEST_IMAGE_REGISTRY` is the switch.** Set it and
every Modal spawn resolves `<registry>/aai-guest-harness:<sha16>` through
`images.fromRegistry`; unset — the CODE default — the server builds and publishes
its own Modal snapshot exactly as before. The policy, both sources and the
argument live in `aai-server/guest-image-source.ts`. Opt-in
rather than default because nothing has published those images until
`.github/workflows/ship.yml`'s guest-image job has run, and a default that pulls
a tag which
does not exist yet turns a deploy into a total sandbox outage. Flipping the
DEFAULT — and deleting the snapshot half, which is most of
`modal-harness-image.ts` — is the follow-up.

**PRODUCTION sets it, and this paragraph used to say the opposite** ("the
default, including production today"), which inverts the answer to the one
question a reader brings here: does a deployed platform pull these images? It
does. The variable lives in the Modal secret, so nothing in the repo or in CI
can read it back — the evidence is in
`aai-server/guest-image-source.ts`, whose `resolvePinAcrossSources` exists
BECAUSE the flip happened: on the day after it, five pinned tags resolved to a
registry that had never held them.

**A guest image is published by a RELEASE, and PROD does not boot one until a
DEPLOY.** Both halves matter. The tag a spawn asks for is decided by the
DEPLOYED server: `agents.harness_image_tag` for an agent deployed earlier, and
otherwise `localHarnessImageTag` over the harness bytes that server carries. So
a tag CI pushed is referenced by nothing until a deploy ships a server that
hashes to it, which is why `ship.yml` gating the deploy on a version bump is
what decides when a new guest image goes live. It was briefly not: #1343 armed
the deploy off a server SOURCE diff, so every server merge deployed and every
server merge therefore put a new guest image under production. That is reverted
— see "A VERSION BUMP is what arms a deploy" in `ship.yml`.

The publish used to be UNGATED, and that is what changed: the image job now
`needs: release`, so an ordinary merge to main publishes nothing (see "A RELEASE
ships. A MERGE does not." in `ship.yml`). Main's head therefore does NOT always
have an image between releases, which the paragraph below is about.

**The TAG is unchanged across the switch, deliberately.** Both sources key on the
same `localHarnessImageTag` string and the registry source only PREPENDS a
registry, because `agents.harness_image_tag` holds tags recorded by earlier
deploys and a prefix is not part of the hashed byte stream. That property is
worth a test of its own, and has one.

**A missing image fails at CREATE, not at resolution** — `fromRegistry` is lazy
— which is why the chosen source and its registry are logged at boot. "Which
image am I pulling, and from where" has to be answerable from one line rather
than inferred from the shape of a later pull error, the same reason
`describeSandboxBackend` carries a reason string.

**The publish job no longer races the release, because it is ORDERED after
it.** The image used to install the SDK at exact published versions while the
release published them in a parallel workflow, so a run that got there first
404s — approximated for a while by a 320-line poll on npm's install view. Both
are now jobs of `.github/workflows/ship.yml` joined by `needs:`, and on a
release the image installs the packed tarballs rather than consulting the
registry at all. It carries no `paths` filter, because the tag hashes the
harness BUNDLE — which bundles the SDK, the runtime, the UI and the CLI, so
almost any change to `packages/` mints a new tag and a filter would silently
stop publishing once it went stale.

**It IS gated on the release now, and the cost is a dev affordance — know which
one.** The argument for publishing on every merge was that the same property
which rules out a `paths` filter rules out a version gate: any `packages/`
change mints a new tag, so between releases main's head names an image nobody
published. What that costs is `GUEST_IMAGE_REGISTRY=ghcr.io/<owner> pnpm
dev:aai-server` on a tree that is ahead of the last release, and it costs it in
the worst available way — `fromRegistry` is lazy, so the developer gets Modal's
empty-exception build failure at sandbox CREATE rather than anything naming a
missing tag. What publishing on every merge cost was a push to a PUBLIC registry
as a side effect of merging, several times a day, for tags no server would ever
pin, and that is the half a reader of the run list cannot see. The dev
affordance has three ways out and merging did not: leave `GUEST_IMAGE_REGISTRY`
unset (the default builds the Modal snapshot image from local bytes — see
`guestImageSource`'s `reason`), push the tag yourself with
`scripts/build-guest-image.mjs`, or dispatch `ship.yml` on the ref you want an
image for.

**The Dockerfile lives in `aai-server`, beside the constants it mirrors, and the
build CONTEXT is this package.** That split is deliberate: the recipe's inputs
(`GUEST_SYSTEM_PACKAGES`, `SDK_PACKAGES`, `GUEST_ROOT`, `DEFAULT_SANDBOX_IMAGE`)
are the host's, and `guest-image-dockerfile.test.ts` has to be hashed by the same
package as both the Dockerfile and those constants — `inputs` globs resolve
relative to the PACKAGE, so a gate split across two packages is served from a
stale cache exactly when the file it guards changes. The context is this package
because `toolchain/` and `dist/harness.mjs` are here.

**`scripts/build-guest-image.mjs` READS the ARG values out of that TypeScript**
rather than restating them, and every extractor throws when its declaration no
longer matches — a regex read of source is only acceptable where it cannot fail
quietly. Two values are committed copies in the Dockerfile (the base image and
the guest root, so a bare `docker build` works and buildx does not warn), and the
test fails when they drift. The two ARGs whose values change every release
(`SYSTEM_PACKAGES`, `SDK_SPECS`) deliberately carry NO default: Docker
substitutes an empty string for an unset ARG rather than erroring, so each is
guarded by a `test -n` that fails the build instead of shipping an image with no
SDK in it.

## ffmpeg is installed, and a step reaches it through the SDK

A media pipeline hits the same wall on its first real recording: it is an `.m4a`
off someone's phone, and every byte offset a workflow computes — cutting,
planning a fan-out, reading a header — assumes linear PCM. The transcription
template says so out loud, and its remedy used to be a sentence telling the
CALLER to run `ffmpeg -i in.m4a -c:a pcm_s16le out.wav` on their own machine
first. That is work the platform should be doing.

So **`GUEST_SYSTEM_PACKAGES`** (`aai-server/modal-system-packages.ts`) installs
`ffmpeg` — which is also where `ffprobe` comes from — and
**`@alexkroman1/aai/ffmpeg`** is how a step reaches it:

```ts no-check
import { stepReadUpload } from "@alexkroman1/aai/utils";
import { probeMedia, transcodeToWav } from "@alexkroman1/aai/ffmpeg";

export async function toPcm(uploadId: string) {
  "use step";
  const { bytes } = await stepReadUpload(uploadId);
  const info = await probeMedia(bytes);
  return info.audio?.codec === "pcm_s16le"
    ? bytes
    : await transcodeToWav(bytes, { sampleRate: 16_000, channels: 1 });
}
```

Five things about that pairing, each of which is a decision:

- **apt, not an npm binary package.** `ffmpeg-static` is GPL-3.0, ships one
  binary per install, and would land in a PUBLISHED package's dependency tree,
  where the artifact-size budget counts it against every consumer. A layer in an
  image the platform builds costs a tenant who never transcodes nothing at all.
- **The package list is in the image FINGERPRINT** (`toolchainFingerprint`), so
  adding one mints a new tag rather than reusing a published snapshot that lacks
  the binary. That failure would be silent in the worst way — a guest that boots
  fine and fails the first step that spawns. Its layer is FIRST, because it is
  the layer that changes least: an SDK release invalidates the toolchain below
  it and this one stays a cache hit.
- **The runner is ours, and the argv is yours.** `runFfmpeg` passes `args`
  verbatim — no `-y`, no `-loglevel` — so the argv in a failure is the command
  you paste into a shell; the standing flags live in `probeMedia`,
  `transcodeToWav` and `wavEncodeArgs`, which is where a policy belongs. What the
  runner adds is the four properties every wrapper on npm gets wrong for a guest:
  a capped stderr TAIL (ffmpeg's log is progress lines, so the diagnosis is the
  last one), a capped stdout (64 MiB — a guest reserves ~1 GiB and an hour of
  16 kHz mono PCM is ~115 MB, so "buffer whatever comes" is a decision to fall
  over on a long recording), one `AbortSignal.any` of the caller's signal and a
  deadline, and a `FfmpegError.kind` that separates a `timeout` worth retrying
  from an `exit` on a file that will fail identically forever.
- **`aai dev` uses the developer's own ffmpeg**, from `PATH` or
  `AAI_FFMPEG_PATH` / `FFMPEG_PATH`. That is the one place dev/prod parity is
  partial, so ENOENT is reported as an instruction — how to install one — rather
  than as `spawn ffmpeg ENOENT`, and `ffmpegVersion()` answers `undefined` for a
  missing binary so a step can preflight.
- **The argv is covered by a REAL binary.** `host/ffmpeg.test.ts` drives a fake
  child (that is where the four properties above are asserted, in memory);
  whether `-print_format json` is spelled right is `host/ffmpeg.scenario.test.ts`,
  which generates its own input with `lavfi` and skips — ANNOUNCING it, like
  `describeWithPg` — when there is no ffmpeg. CI's Linux leg installs one and
  sets **`AAI_REQUIRE_FFMPEG=1`**, which turns that skip into a hard failure, so
  a broken install step cannot read as a green run (declared in `check:scenario`'s
  `env` in `turbo.json`, or strict env mode would strip it and the enforcement
  would silently do nothing).

Adding a second package is one entry in `GUEST_SYSTEM_PACKAGES`. It is not free:
every guest image carries it, and the tag it mints re-pays the apt layer once for
the whole fleet.

## A `neverBundle` package must be INSTALLED beside the harness

`tsdown.config.ts` bundles everything except a `neverBundle` list, and the
harness ships as ONE file — so every entry there becomes a runtime resolution
against the `node_modules` next to it (`/opt/aai` baked, this package's own in
dev). Two halves have to agree, and for `@workflow/world-postgres` neither did:

- **It has to be external in the ARTIFACT**, which is a property of the build
  rather than of the config.
- **Something has to install it beside the harness** — the locked toolchain
  (`toolchain/package.json`, via `LOCKED_PACKAGES` in
  `scripts/sync-guest-toolchain.mjs`), or `modal-harness-image.ts`'s separate
  `@alexkroman1/*` install.

**Bundling is not always safe, and the reason is DATA.** A package whose code
reads files beside itself cannot be bundled at all: `@workflow/world-postgres`'s
Drizzle migrator reads `drizzle/migrations/meta/_journal.json`, resolved relative
to its own module location, and tsdown carries modules rather than the
directories around them. Bundled, a guest holding a `DATABASE_URL` died on
`Can't find meta/_journal.json` before running one migration, and the workflow
API's runtime `require` of it failed from the temp dir steps dispatch in — so the
**durable Postgres workflow world had never worked anywhere, production
included**. Nothing noticed because the prerequisite (an agent with storage
enabled) had never been met; enabling the database by default for studio projects
is what surfaced it. Ask of any new dependency whether it reads its own
directory.

**The same hazard's other flavour is a package reading its own `package.json`,
and there `neverBundle` is the WRONG fix.** `@workflow/world-local` versions its
data directory from `<its module dir>/../package.json`; bundled, that resolves
beside `harness.mjs` — `packages/aai-guest/package.json` under the subprocess
backend (wrong version, but parseable) and NOTHING at `/opt/package.json` in the
baked image. The unreadable case fell back to the string `"bundled"`, which the
package's own `parseVersion` rejects, so every databaseless deployed agent that
declared a workflow logged `Workflow world (local) failed to start: Invalid
version string: "bundled"` and got no workflows at all. Externalizing it would
cost every spawn: `@workflow/core` imports it STATICALLY, so the harness would
evaluate it (plus undici, zod, ulid, async-sema) even for the voice agents that
declare no workflow — where `@workflow/world-postgres` is a runtime `require`
and stays lazy. The fix is the repo's one pnpm patch
(`patches/@workflow__world-local@4.2.4.patch`, pinned in `pnpm-workspace.yaml`),
returning the real version from a constant with no disk read. Two things keep it
honest: pnpm fails the install outright if the patch stops applying, and
`harness-externals.test.ts` asserts the sentinel is absent from the built
artifact.

`harness-externals.test.ts` pins both halves, and `aai-guest#test` declares its
own `build` so it asserts on the real artifact — a suite that skipped itself
without one would be the silent skip that let this ship. Verified by A/B:
removing the `neverBundle` entry fails the import assertion. Note the
journal-resolves assertion does NOT fail there (the package is installed either
way; the bug was the bundled copy not using it) — it guards the other direction,
a package that stops shipping its migrations.

## Fetching its own bundle

The guest pulls its own worker bundle from a signed Storage URL rather than
having the platform write the bytes into the sandbox. The host-side plumbing
is in `packages/aai-server/CLAUDE.md`; the boot contract is here, because
agent mode is what enforces it.

A cold agent spawn used to move the worker bundle — ~8 MB typical, 30 MB cap —
through the PLATFORM REPLICA **twice**: `loadBundleParts` read the blob out of
Supabase Storage into the replica's heap, and `spawnModalAgentServer` wrote
those same bytes into the sandbox with `filesystem.writeText`. Neither hop
bought anything. The guest now fetches the bundle itself from a time-boxed signed
Storage URL (`BlobStorage.signedUrl` → `BundleStore.getWorkerUrl` →
`WorkerSource` in `sandbox-vm.ts` → `AAI_BUNDLE_URL` in the exec env), and both
transfers disappear.

**The hash is the whole security argument, and it predates this.** Agent mode
already refused to load a bundle whose sha-256 did not match `AAI_BUNDLE_SHA256`
(`readAgentBoot`), so the guest trusts the HASH, never the transport. What
changed is where that hash comes from: the agents row's `worker_hash` — the
deploy's own record of what it published — rather than a digest of the bytes
the host happened to be holding, which made the check a tautology on the file
path. The URL grants read of exactly one immutable blob, carries no
service-role key, and expires (`WORKER_URL_TTL_SECONDS`, 5 min — sized against
the 120s readiness budget plus scheduling, because a URL expiring inside it
turns slow Modal scheduling into a boot failure that only appears under
capacity pressure).

**There is no fallback for a failure.** Signing throws and fails the spawn,
like every other spawn failure; the client re-brokers. `signedUrl` resolving
`null` means something else entirely — *this backend cannot sign* — which is
true only of the memory blob store behind local dev and tests, and puts them on
the byte path. Conflating the two would silently put production back on the
byte path with nothing reporting it.

**A pinned guest may be too old to understand it, and that is checked**
(`guestUnderstandsBundleUrl`). Deployed agents spawn from the harness image
pinned on their row, so the guest can be arbitrarily older than the platform,
and a `GUEST_CONTRACT_VERSION` 1 harness reads only `AAI_BUNDLE_PATH` — handed
a URL it fails boot outright. Nothing can ask a guest its version *before*
exec, so the host compares images instead: no pin, or `SANDBOX_IGNORE_IMAGE_PINS`
(which must agree with `resolveSpawnImage` substituting the current image), or a
pin equal to the tag the SERVER process builds. The tag hashes the harness
content, so "same tag" means "same harness". **So the saving lands per
deploy**, as agents are redeployed onto a harness that understands the URL —
not all at once when this ships.

One side effect worth knowing: `loadBundleParts` now reads the agents row ONCE
and derives the worker source from it, where it previously issued `getAgent`
and `getWorkerCode` concurrently and each read the row.

## Guest network access

There is **no per-agent egress policy**. `allowedHosts` and its enforcement
stack (the SDK's `tool-egress`/`guest-fetch-policy` in-process guard, the
platform's Modal outbound-domain allowlist, `guest-egress.ts`) were removed:
the agent's own code runs in the guest with open egress, exactly as it does
under `aai dev`. The Modal container is the isolation boundary — a tenant
can reach the internet, not the platform. Tool code and providers `fetch`
directly.

**The network builtins follow one rule: screen only when there is no
container around us** (`builtinFetch` in `host/ssrf.ts`).

- **Contained** (a Modal Sandbox) → plain `pinnedFetch`, no SSRF screen. The
  screen guards nothing a tenant cannot bypass in one line, because their own
  tool code has open egress by design — so it constrains the *model*, not the
  author. The container is the boundary and it holds no PLATFORM credentials
  (a `DATABASE_URL` in the boot env is the AUTHOR's own database, never the
  platform's — the platform provisions none).
- **Not contained** (`aai dev`, and the subprocess backend) → `safeFetch`.
  Here the host IS someone's machine: these same builtins run in the
  developer's own process, where a model-controlled URL can reach localhost,
  the LAN, or cloud metadata. That is the case the screen exists for.

Containment is **declared by the spawner**, never inferred by the guest:
`modal-sandbox.ts` sets `AAI_SANDBOX_CONTAINED=1` in the exec env and the
subprocess backend does not. "Am I a guest" and "am I contained" are
different questions — the subprocess backend runs a guest with no container
at all, so a guest-token sniff would open egress on a developer's laptop.
`ssrf.test.ts` pins that distinction.

The residual risk in a container is prompt injection steering the model at an
internal endpoint; accepted, because the sandbox has nothing internal worth
reaching and an author who wants that can already write it.

**SSRF screening implementation (`host/ssrf.ts`).** The rules the screen
itself has to get right, as opposed to when it runs:

- Lives in the SDK, not `aai-server`, so both the platform's guest-fetch proxy
  and the SDK's own network builtins resolve one implementation.
- `resolveAndAssertPublic()` uses the `bogon` library for private IP ranges.
- Handles IPv4-mapped IPv6 bypass (`::ffff:127.0.0.1`).
- Blocks `.internal`, `.local`, cloud metadata hostnames, and non-HTTP(S)
  protocols.
- Re-validates every redirect hop and strips credential headers once a redirect
  leaves the original origin.
- Pins the validated IP with an undici dispatcher `lookup` rather than
  rewriting the URL hostname. Rewriting broke TLS — SNI and cert verification
  use the URL, not the `Host` header — so every `https://` request failed. Keep
  the URL intact when touching this.
- **The dispatcher and the `fetch` it is handed to must come from the same
  undici.** `pinnedDispatcher` builds an `Agent` from this package's `undici`
  dependency, while `globalThis.fetch` is backed by the copy bundled into the
  Node runtime (`process.versions.undici`) — a different major. undici 8
  reworked the dispatch-handler interface, so a v8 `Agent` rejects the v7-style
  handler Node's internal fetch builds, with `InvalidArgumentError: invalid
  onRequestStart method` surfacing as a bare `TypeError: fetch failed`. A
  dispatcher is attached to *every* hostname request, so the mismatch takes out
  all SSRF-guarded egress at once — `web_search`, `visit_webpage`,
  `get_page_design`, and `fetch_json`. `safeFetch` therefore routes through
  `pinnedFetch`, undici's own `fetch`; never reintroduce `globalThis.fetch`
  there. Guarded by `ssrf-dispatcher.test.ts` — the rest of the SSRF suite
  injects a fake fetch and never builds a real dispatcher, which is why this
  shipped unnoticed. Two rules survived the (since-removed) tool-egress
  guard that first hit this: **the caller may not name a fetch
  implementation** (leave `fetchFn` unset — it exists for tests — so the
  pinned default applies), and the guard test has to cover the *call site*,
  not just `pinnedFetch` in isolation.

  **The request *body* crosses the same seam, and `FormData` does not survive
  it.** undici 8's `extractBody` brand-checks each body type with an
  `instanceof` against **its own** class, so a `globalThis.FormData` (an
  instance of Node's *internal* undici's class) matches no branch, falls
  through to the string conversion, and goes out as `Content-Type: text/plain`
  with the 17-byte body `[object FormData]` — the server answers
  `415 Unsupported Media Type` and the caller sees an opaque HTTP failure.

  The rule that generalizes: **never hand a `FormData`, `Blob`, `File`,
  `Headers`, or `Request` to a `fetch` that might not be the one your realm's
  global came from** — pass bytes.
- The network builtins (`web_search`, `visit_webpage`, `get_page_design`,
  `fetch_json`) take a
  model-controlled URL and **default** to this via `safeFetch` in
  `builtin-tools.ts`. Protection is not opt-in per caller; only tests override
  the `fetch` option.

## A harness edit needs the IMAGE rebuilt

The microVM backend boots `aai-guest-harness:local`, and **the harness is BAKED
into that image** — so `pnpm build:guest-image --msb` is what makes a harness
edit live locally, not `ensure-guest-harness.mjs`. That script rebuilds
`dist/harness.mjs`, which is what the SUBPROCESS backend and the test tiers
read; a microVM never looks at it.

The symptom is a guest that plainly ignores the change you just made, with a
`dist/harness.mjs` NEWER than the source you edited and the bundle demonstrably
containing your change. Measured while verifying a boot-ordering fix: the built
bundle had the new order and three consecutive guests logged the old one. The
mtime heuristic is not lying — it is answering about a file the VM does not use.

Same trap `aai publish` has on Modal one layer down (the harness is in the
snapshot image there too), and the same shape as the `dist/` staleness in
`ensure-guest-harness.mjs`'s own note: an artifact whose freshness is real and
whose CONSUMER is somewhere else.

## And the SDK in a LOCAL image is this checkout's, not npm's

The harness is only half of what a guest runs. **A guest's agent bundle resolves
`@alexkroman1/*` from the IMAGE's `node_modules`** — the CLI's worker-bundler
runs inside the guest and bundles what it finds there — so the image supplies the
SDK as well, and `SDK_SPECS` in `guest-image.Dockerfile` decides which one:

| Build | `SDK_SPECS` | Installs |
| --- | --- | --- |
| local (`pnpm build:guest-image [--msb]`) | paths under `sdk-tarballs/` | **this checkout**, packed |
| `--sdk-pack-dir <dir>` (CI, on a release) | paths under `sdk-tarballs/` | **the release being published**, from its `changeset pack` tarballs |
| `--registry` / `--push` (CI, otherwise) | `name@version` | the published versions |
| local `--published-sdk` | `name@version` | the published versions |

`packWorkspaceSdk` (`scripts/build-guest-image.mjs`) builds the four packages
through turbo and `pnpm pack`s them into the build context. The sibling versions
come along for free: `pnpm pack` rewrites `workspace:*` to the exact version, so
`aai-runtime` requires `aai@<this version>` and npm satisfies it from the tarball
beside it rather than fetching npm's.

**The polarity is the safety property.** A registry or push build may never
install unpublished code — a deploy records `harness_image_tag` and a recorded
pin has to resolve to something that exists on npm forever, which is also why the
SDK is the one part the toolchain lockfile cannot cover. There is no flag that
opts a PUSHED image into the workspace SDK; `--published-sdk` only goes the other
way, for reproducing a report against the SDK a user actually has, and it says so
out loud when used.

**`--sdk-pack-dir` is the THIRD way to satisfy that rule, and it exists to take
npm off the deploy's critical path.** Installing `name@version` kept the rule by
proxy — if the install resolved, the version was published — and the proxy cost
the whole ordering: the image could not be built until the release was not just
published but READABLE by an installer, which is a property of npm's caches
rather than of anything CI can see, and it took a 320-line poller to approximate.
A `changeset pack` directory discharges the rule directly instead, because its
tarballs ARE the artifacts `changeset publish --from-pack-dir` uploads. Two
assertions in `stageSdkPackDir` are what make that a check rather than an
intention: the plan's version must equal the version this checkout declares (the
image tag is hashed from the declared versions, so a stale pack directory would
make the tag promise one release while node_modules held another — "a version
number cannot distinguish a released tree from a dirty one", by a new route), and
each tarball must match the sha256 the publish plan recorded. Both are fatal.

The TAG is unaffected either way: `localHarnessImageTag` hashes
`resolveSdkSpecs()`, which reads the DECLARED versions and never sees a tarball
path, so switching a push build to tarballs orphans no recorded pin.

**Why local defaults the other way**, rather than matching prod: `:local` is a
mutable tag that already promises "whatever this checkout is" — the reason
`microsandboxHarnessImageTag` refuses to PIN it. Installing published versions
broke that promise in the direction that hurts, and the two halves report the
SAME VERSION STRING, so nothing shows it. It cost a full investigation exactly
once: a guest kept dialling itself for every platform call after the fix was
already in the tree, because the copy making the call came from npm and was
thirteen commits behind — while `sessionState: memory` beside it was a SECOND
unreleased fix missing from the same copy. A version number cannot distinguish a
released tree from a dirty one.

Two mechanical notes. The tarball `COPY` sits AFTER `npm ci`, so a tarball
changing on every local build does not invalidate the ~700-package third-party
layer. And `sdk-tarballs/.gitkeep` is COMMITTED although the `.tgz` files are
ignored: a Dockerfile cannot branch, so that COPY runs for a published build
too, and `COPY` of a missing path fails the build —
`guest-image-dockerfile.test.ts` pins both.

## Building the harness for a test run

**The aai-server test project auto-builds the guest harness**:
`scripts/ensure-guest-harness.mjs` runs as vitest `globalSetup` — wired in
`packages/aai-server/vitest.config.ts`, the ONE config that declares it —
and builds `aai-guest` when `dist/harness.mjs` is missing or older than the
sources, tracking BOTH aai-guest and the `packages/aai` SDK it bundles.
`createSandbox` resolves the harness eagerly, so an unbuilt one otherwise
fails every sandbox test. `GUEST_HARNESS_PATH` skips the check.

**Inside a turbo task (`TURBO_HASH`) it VERIFIES instead of building**, and a
missing harness there THROWS, naming the `dependsOn` to add. Turbo already
orders `aai-guest#build` ahead of every consumer and decides staleness by
hashing inputs; the mtime heuristic is only a guess, and it guesses wrong in
the ordinary case — a turbo cache HIT restores `dist/harness.mjs` with the
archived mtime, so any edit under `packages/aai` makes a byte-correct harness
look stale. The globalSetup then spawned a NESTED `turbo run build` inside
the parent run, and two tsdown processes wrote `dist/` while sibling tasks
read it: `aai-studio-server#test` (which declares no globalSetup of its own)
and `aai-server#check:integration` failed intermittently with "Guest harness
not built" or `MODULE_NOT_FOUND` on `aai-guest` — naming a file nothing in
their own package touches. It is the mirror image of the race
`packages/aai-server/turbo.json` documents: that comment notes this script
cannot wait out a harness being rebuilt underneath it, and the script was
itself that rebuild. **A harness a turbo task needs must be DECLARED**
(`^build`, or `aai-guest#build`), never built at test time.

The same script also runs as
`predev` in aai-studio-server (the entry `pnpm dev:aai-server` runs, so dev
always boots with a fresh harness for local-dev sandboxes) and as
`predeploy:modal` in aai-server, which owns the Modal deploy (a fail-fast
before the remote image build, which rebuilds the harness itself). Also
runnable directly: `node scripts/ensure-guest-harness.mjs`.

## The guest image's Node major, and the split floor it creates

The guest base image defaults to `node:26-slim`; pin via
`MODAL_SANDBOX_IMAGE` for reproducible guests. `MODAL_APP_NAME` selects the
Modal App sandboxes are created under (default `aai-server`).

**Its major tracks the SERVICE image's** (`node:26-slim` in
`scripts/modal_image.py`) **and `.node-version`.** The guest is the dev
server (see `packages/aai-guest/CLAUDE.md`, "Dev/prod parity"), so a split
major would mean the harness runs
one runtime in production and another under `aai dev` — the asymmetry that
section exists to enumerate, and one that no test can see because each side
is internally consistent. The three move together; `@types/node` is the
fourth, since it is what `tsc` checks every package and every studio
workspace against — pinned two majors ahead of the runtime, it accepts APIs
the deployed container does not have.

Note the ceiling is a RANGE, not a pin: published `engines.node` stays
`>=24` so SDK consumers on the previous LTS are not broken by a platform
deploy, which is why bumping this image is not a package-visible change.
**That split floor is what decides which Node 26 features may be used
where, and `tsc` cannot enforce it.** The root tsconfig sets
`lib: ["ESNext"]`, so every V8 14.6 addition — `Map.prototype.getOrInsert`
/ `getOrInsertComputed`, `Iterator.concat`, `Temporal` — type-checks in
every package. In `aai-server` / `aai-guest` / `aai-studio-*` (`>=26`) that
is accurate; in `aai`, `aai-ui`, `aai-cli` (`>=24`) it ships a
`TypeError: … is not a function` to the consumer, having passed lint,
typecheck, and a CI whose own Node is 26. `runtime-tools.ts` carries the
worked example: `getOrInsertComputed` fits its state map exactly and is
deliberately not used. Anything reachable from a published package needs a
Node-24 floor check, not a type check. (`Iterator.concat` is doubly
unavailable — TS 7.0.2's lib does not declare it yet.)

Safe in every package, because they predate the 24 floor: `crypto.hash()`
(21.7), `module.enableCompileCache()` (22.1, stable in 25.4),
`await using` + `Symbol.asyncDispose` (20.4). `DisposableStack` /
`AsyncDisposableStack` are NOT in that set — they are V8 globals Node does
not document, so their availability on the floor is unverified; see the
note in `studio-session-broker.ts`.

## Credential separation, and what reaches a guest

Each agent provides its own `ASSEMBLYAI_API_KEY` via `.env` (local dev) or
`aai secret put` (production). There is no central/platform-owned key.
`SandboxOptions` has separate `apiKey` (host-only, for S2S connections) and
`agentEnv` (forwarded to guest) fields. The key is extracted from the agent's
stored env at sandbox creation time and kept host-side only.

- **A database is the AUTHOR's, and the platform provisions none.** A
  `DATABASE_URL` in the boot-delivered agent env is a secret the author set,
  from their own provider, and it reaches the guest exactly the way every other
  secret does — no overlay, no platform-composed value. That is the same thing
  `aai dev` puts in `ctx.env` via the project `.env`, so dev and prod agree by
  construction.

  It used to be a per-app Postgres role/schema the platform provisioned and held
  in Supabase Vault, injected LAST so enabling storage overrode anything the
  author had set. The credential-separation argument now holds trivially rather
  than by care: the platform has no tenant database credential to leak, because
  it has no tenant database.

  **Durable state did NOT go with it** — turn-level durability (session slots,
  the session event log) and durable workflow runs are the PLATFORM's, reached
  over HTTP with the sandbox's own bearer. See `packages/aai-server/CLAUDE.md`.
- **Agent secrets**: stored in Supabase Vault (`agent-env:<slug>`), not
  encrypted blobs — the old master-key envelope encryption
  (`KV_SCOPE_SECRET`) is gone.
- **Credential resolution reads the agent env only — never `process.env`.**
  The platform host process holds its own credentials under exactly the names a
  tenant descriptor could resolve (`AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` for Supabase storage), so a fallback would let an
  agent that supplied no credential of its own silently borrow the
  platform's.

  There are **two** such helpers and both must stay sealed — closing only one
  leaves the leak open, since between them they cover every provider:
  - `resolveApiKey` (`providers/resolve.ts`) — descriptor-declared env keys.
  - `requireApiKey` (`providers/_utils.ts`) — every STT/TTS opener and every
    LLM (via `resolve.ts`'s `requireKey`).

  Self-hosted runs opt into shell-exported keys via
  `withHostCredentialFallback` (`providers/host-env.ts`), which copies only
  `PROVIDER_CREDENTIAL_ENVS` (derived from the provider registries). It feeds
  `RuntimeOptions.providerEnv`, **not** `env` — credentials must not land in
  `ctx.env`, both so agent code can't read them and so dev keeps parity with
  production in what `ctx.env` contains.

  The providerEnv-not-env rule is **type-enforced** via the branded env
  records in `sdk/env-types.ts`: `withHostCredentialFallback` is the only
  minter of `HostCredentialEnv`, which satisfies
  `RuntimeOptions.providerEnv` (`ProviderEnv`) but is a compile error for
  `RuntimeOptions.env` (`AgentEnv`) and everything else that becomes
  `ctx.env`. Plain records stay assignable to both, so only the dangerous
  flow needs ceremony; `env-types.test-d.ts` locks the assignability matrix.
  The brand is advisory against *deliberate* re-annotation — the point is
  that leaking host credentials into `ctx.env` can no longer be silent.

**Cross-agent isolation:**

- **No shared database to isolate.** This used to say per-app schemas with
  per-app login roles kept agents out of each other's data. There are no per-app
  databases now, so a database an agent reaches is one its own author configured
  and no other tenant has a credential for. The platform's own is not reachable
  from a guest at all — the durable-state routes are HTTP, per-sandbox bearer,
  and every one is scoped by the caller's slug server-side.
- Each sandbox communicates over its own authenticated WebSocket.
- Sessions are per-sandbox (`Map<string, Session>`).
- No shared mutable state between sandboxes.

## Testing this package

`_test-utils.ts` owns everything more than one suite here needs, and each entry
exists because the thing it replaces had gone wrong at least once:

- **`useTempDir(prefix)` / `useTempDirs(prefix)`** — a scratch directory (or a
  pool of them) that registers its own `beforeEach`/`afterEach`. Six suites
  open-coded `mkdtemp` + `rm` in three styles and one leaked: a single `let dir`
  shared by two `describe` blocks meant the file-level `afterEach` re-`rm`'d the
  first block's already-deleted path after every test in the second, and cleaned
  up none of its own. Creating the directory and its cleanup together is what
  makes that unrepresentable.
- **`installFakeHostChannel({ autoAnswer })`** — the fake host control channel,
  written out three times before this and twice verbatim. It also carries the
  **typed frame accessors**: `lastRequest()` / `lastResponse()` narrow a
  `JsonRpcMessage` by RUNTIME CHECK, where every reader used to re-narrow
  `sent.at(-1)` to its own ad-hoc shape and would silently read `undefined` off
  the wrong half of the union.
- **`runTool`** — the one way to call a coding-agent tool (see "The coding agent
  is an ordinary `agent()`"). A spec must not reach past it to `execute`.
- **`materialize(dir, files)`** — `withBuildDir`'s middle argument, inlined five
  times in one file and defined a sixth in another.

**A turn's settle outlives its response, so `studio-chat.scenario.test.ts`
drains before unhooking the host channel.** `onFinish` fires, then
`snapshotWorkspace` walks the tree, then two host RPCs go out — all after
`serve().close()` has returned.
`setHostSend` is a process singleton, so a previous test's settle landed in the
NEXT test's recorder, and the assertions were weakened to tolerate it
(`toBeGreaterThanOrEqual(2)` plus a content filter, with the flake message they
produced recorded in-file). `drainTurns()` waits for all three of: the
process-wide turn claim free, `pendingHostRequests` empty, and no new frame
since the previous poll — the last one covering the filesystem walk between
`onFinish` and the settle's first RPC. It is bounded and best-effort, because a
turn that never reaches `onFinish` must not redden every following test.

**A test's TIER is what it touches, and this package is the worst offender.**
Ten files here still write to the filesystem, bind a port, or spawn a subprocess
while sitting in the 5s unit tier. It was eleven; `studio-chat` is the one that
left, and it left because the budget stopped being theoretical — the file lost a
`vi.waitFor` race on a loaded CI runner, with its own in-file notes already
recording two earlier ones at the same assertions.

The scenario tier is REACHABLE now — `vitest.config.ts` excludes both slow-tier
globs (without which a rename left a file in BOTH tiers), and `package.json`
declares the `test:scenario`/`check:scenario` pair that turbo's `check:scenario`
task fans out to. `studio-build`, `studio-test` and `studio-chat` are the worked
examples, and what they taught is worth copying:

- **A moved file gives up its unit coverage, and the fix is a SPLIT, not a
  floor.** Moving both files whole took the package from 83.88/75.58/84.49/85.79
  to 81.26/72.97/82.27/83.03 — still over every floor, but with 0.03 points of
  line headroom, which is a landmine rather than a pass. Splitting each file on
  what it TOUCHES put it back: `studio-build.test.ts` keeps `scrubDir`,
  `formatBuildFailure` and `toolchainModules` (a filesystem READ is unit-legal),
  `studio-test.test.ts` keeps `formatTestRun`, and only the build-dir lifecycle,
  the typecheck gate and the real vitest spawns are scenario. That is the tier
  rule applied properly, and it lands at 81.73/74.41/82.59/83.48. Floors do not
  move.
- **A file with no pure half still splits — on the CALLER's side of the I/O.**
  `studio-chat` had no `scrubDir` to keep behind: every test went through a real
  `http.createServer` and a materialized workspace. What is unit-legal is the
  exported function itself, driven over IN-MEMORY `IncomingMessage`/
  `ServerResponse` — the real Node objects, the real serialized HTTP read back
  off an intercepted socket write, no port and no disk. That covers the whole
  dispatch (CORS, 409, the bearer gate, the `/studio/tools` inventory, the
  method refusals, the 423) plus `runTurn`'s two body rejections and one
  text-only streamed turn, in **145ms against the old file's 1326ms**. Measured
  at each step, because the first two attempts were not enough: whole move
  78.67/73.85/80.22/79.70 (three floors failed), dispatch only
  81.41/76.49/81.33/82.62 (two failed), and with the body rejections and the
  turn **82.81/77.29/83.00/84.19** — every floor clear, against a pre-split
  83.24/77.52/84.12/84.53. Floors do not move.
- **Incidental coverage is not coverage, and the per-file gate is what says
  so.** `studio-turn-settle.ts` had no spec at all — every line of it was
  reached by `studio-chat.test.ts`'s real turns — so the move dropped it to
  35.2% and `check:coverage-per-file` failed on it alone, which the package
  average could never have shown. It has its own unit spec now, with
  `snapshotWorkspace` MOCKED: what that module decides is which RPCs go out
  and with which flags (`done: true` is the one the host keys preview deploys
  off), how a walk's warnings are reported, that a burst of checkpoints
  coalesces to one trailing run, and that a failed checkpoint is logged rather
  than thrown into an otherwise-fine reply. Walking a real tree is
  `studio-workspace-fs.ts`'s subject.
- **Two Node details are worth knowing before writing another one of these.** A
  detached `ServerResponse` needs `assignSocket` to be writable at all, and it
  never emits `finish` — the bytes arrive, the event does not — so anchor on the
  `end` CALL. And `expect` inside a helper trips `noMisplacedAssertion`, which
  matches lexical position rather than the call graph.
- **Delete the hand-written `timeout: 120_000`s.** Five of them, which WERE the
  scenario tier's timeout re-declared because the tier was not used.
- **A shared PID is not a shared module registry.** Both files ran green in the
  unit tier and one failed reliably once they were the only two in a run: vitest's
  `threads` pool gives each file its own module instance inside the SAME process,
  so `withBuildDir`'s module-scoped counter handed both `build-1` under a
  `workspacesRoot()` keyed by `process.pid`, and one file's cleanup deleted the
  other's live directory. It surfaces as `ENOENT: uv_cwd` from inside rolldown,
  naming nothing. The directory name carries a random token now.
