---
issue: TODO
status: proposed
last_updated: "2026-08-15"
---

# Whole-codebase review sweep — 79 correctness findings, 133 cleanups

A combined correctness (`/code-review`) and quality (`/simplify`) pass over
**every non-test source file in the repository**: 869 files, ~118,000 lines
across the nine workspace packages plus `scripts/`. Nothing was edited — this
document is the whole deliverable, and the findings are ordered so the twelve
that matter most are readable without scrolling.

## Why this is in `research/` and not a guide

`research/README.md` says a document here is a plan attached to tracked work.
This is a findings register rather than a single plan, which stretches that
slightly — but the alternative homes are worse. A guide says what to do in code
that exists and is loaded into an agent's context on every task; 200 findings
about code that is about to change is exactly the content that took the root
guide to 233,000 characters. When a finding here is fixed, the *rule* it
establishes belongs in the owning package's `CLAUDE.md` as a few lines, and this
doc keeps the argument. Its `status` should move to `implemented` (or the
findings should be split into issues) rather than the file being deleted.

No numeric prefix: this depends on nothing and nothing depends on it.

## Method, and what that buys

Thirteen independent reviewers, one per slice, each reading every file in its
slice in full. Each was given the package's own `CLAUDE.md`, the repo-wide
primitive list from `AGENTS.md`, and — this is the part that matters — an
explicit list of **what is already guarded** in its slice: the fast-check fuzz
harnesses over the pipeline transport and the browser audio path,
`createTurnMachine`, the `konsistent` provider-shape conventions, the documented
`omitUndefined` baseline exemptions. A reviewer that does not know what the
existing gates cover reports the gates.

Each finding had to survive a refutation pass, and several reviewers reported
what they *tried* to break and could not; those notes are kept under
"Deliberately not reported" at the end of each slice, because a checked-and-
cleared path is worth as much to the next reader as a finding.

| Slice | Files | Lines | Correctness | Quality |
| --- | --- | --- | --- | --- |
| `packages/aai/sdk` | 100 | 14,027 | 5 | 9 |
| `packages/aai/host` (a–l) | 15 | ~8,500 | 3 | 9 |
| `packages/aai/host` (m–z) + `aai/*.ts` | ~50 | ~9,000 | 9 | 12 |
| `packages/aai/host/transports` + `telephony` | 34 | 7,311 | 4 | 11 |
| `packages/aai/host/providers` + `integration` | 27 | 6,067 | 6 | 9 |
| `packages/aai-ui` | 83 | 9,794 | 6 | 9 |
| `packages/aai-cli` | 50 | 7,821 | 7 | 10 |
| `packages/aai-guest` | 38 | 6,538 | 5 | 11 |
| `packages/aai-server` | 87 | 15,769 | 7 | 8 |
| `packages/aai-studio-server` | 47 | 7,370 | 6 | 11 |
| `packages/aai-studio-client` | 39 | 6,163 | 5 | 12 |
| `packages/aai-templates` | 159 | 14,779 | 6 | 10 |
| `scripts/` + `packages/aai-evals` | 42 | ~8,800 | 10 | 12 |
| **Total** | **~869** | **~118,000** | **79** | **133** |

`packages/*/contracts/` was excluded by design: those are frozen compatibility
examples whose awkwardness is load-bearing, and a simplifier "improving" one
destroys the check it exists to be.

## The twelve high-severity findings

| # | Finding | Location |
| --- | --- | --- |
| H1 | Unauthenticated `URIError` kills the sandbox — `%` in a webhook path, synchronous handler, no `try` | `aai/host/workflow-serve.ts:167` |
| H2 | Phone-webhook signature check is bypassed by an attacker-chosen `?carrier=` | `aai-server/phone-signature.ts:136` |
| H3 | Any request's `Host` header poisons the public origin baked into *other tenants'* guests | `aai-server/public-origin.ts:84` |
| H4 | A returned `fail(...)` prints nothing in human mode — 9 subcommands exit 1 silently | `aai-cli/_cli-common.ts:154` |
| H5 | `studio/session-init` `rm -rf`s the workspace under a running turn | `aai-guest/studio-session.ts:130` |
| H6 | `reuseSession` never refreshes the fleet lease → peer replica 404s a live project | `aai-studio-server/studio-session-ensure.ts:178` |
| H7 | `notifyChat`'s append path corrupts the transcript mid-stream (duplicate React keys, persisted) | `aai-studio-client/src/chat.tsx:329` |
| H8 | A studio REST 401 signs the user out globally instead of refreshing | `aai-studio-client/src/app.tsx:197` |
| H9 | `GET /studio/status` has no deadline; a hung read permanently deadens two screens | `aai-studio-client/src/api.ts:184` |
| H10 | Two `infocom-adventure` tools mutate a frozen slot value — `TypeError` on every call | `aai-templates/.../game_state_take.ts:4` |
| H11 | `solo-rpg`'s `oracle` mutates a frozen slot value ~20–60% of calls | `aai-templates/.../oracle.ts:222` |
| H12 | `guard-invariants` rule 17 grades 1 of 21 occurrences and prints ✓ | `scripts/guard-invariants-rules.mjs:323` |

## Cross-cutting findings

Four things were found independently by three or more reviewers. These are the
ones worth fixing as a class rather than site by site.

### C1 — Three gates are blind, and one of them by 20:1

This is the repo's own signature failure mode, and it recurred three times.

**`guard-invariants` rule 17 (`isRecord`) matches only the positive
conjunction.** Its pattern is `typeof X === "object" && X !== null` plus the
reversed operand order — but the idiom as actually written in this codebase is
the *negated disjunction* in a guard clause:

```ts
if (typeof value !== "object" || value === null) return null;
const obj = value as Record<string, unknown>;   // paid twice, with a cast
```

There are 20 of those against the 1 positive occurrence the baseline records.
The rule's own comment argues that a one-way pattern "would have left a quarter
of them representable"; the two-way version leaves 95% representable. Confirmed
independently by the `sdk`, `host` (m–z), `transports` and `scripts` reviewers.

**Rule 2 (`omitUndefined`) has the same shape of hole.** Its ERE requires
`!== undefined ?`, so two other spellings of the identical idiom score zero:
the inverted ternary `...(x === undefined ? {} : { x })` and the `&&` form
`...(x !== undefined && { x })`. Nine sites found across `sdk`, `transports`,
`host` and `guest`.

**Both baseline ratchets exit 0 when the scan returns nothing.** `git grep`
exits 1 both for "no matches" and for "pathspec matched nothing", and
`allowNoMatch` swallows the two indiscriminately. A package rename or a typo'd
`:!` exclusion makes every pattern report `now=0`, degrades to the *stale*
warning path, prints `every file within its baseline ✓`, and passes. Four
sibling gates already take a floor (`check-claude-md.mjs:88`, `api-report.mjs`,
`api-contracts.mjs`, `check-doc-examples.mjs`'s `MIN_EXAMPLES`); these two do
not, and `guard-invariants-gate.test.ts` cannot cover it — it proves each
regex lives, never that `SOURCE_PATHSPECS` still walks anything.

Related, and the same trap two files over: `:!scripts/**/*.md` excludes nothing
at the `scripts/` top level, for exactly the reason `check-file-length.mjs`
spends ten lines documenting. Latent today (there is no `scripts/README.md`),
and it would re-open the `CHANGELOG.md` release-blocker if one were added.

### C2 — Response bodies are capped *after* being fully buffered

Five sites take a model-controlled URL, `await resp.text()`, and *then* apply a
byte cap — so the cap bounds what is kept, not what is read. The only real
bound is `FETCH_TIMEOUT_MS` (15s) × bandwidth.

- `host/builtin-tools.ts:144` (`fetch_json`) — the `content-length` pre-check
  reads `Number(null)` → `0` for a chunked body, which passes the guard.
- `host/builtin-tools.ts:73` (`visit_webpage`) — no content-length check at all.
- `host/page-design.ts:92`, `:134`, `host/web-search.ts:234`.

The comment at `builtin-tools.ts:139` asserts the opposite ("a prompt-injected
URL could otherwise make `resp.json()` buffer an unbounded response —
`visit_webpage` slices to `MAX_HTML_BYTES`"), and both halves are false. Two
reviewers found this independently. Secondary: the caps compare `String.length`
against a byte budget, so a multi-byte body passes at up to ~3× nominal.

One `fetchCappedText(url, { accept, maxBytes })` doing a bounded
`resp.body.getReader()` read fixes all five and is also the natural home for the
duplicated UA/Accept/`!resp.ok` scaffolding those sites restate.

### C3 — `slot.get()` returns a deep-frozen value; the types say shallow

`freezeStorable` recurses into arrays and object properties on every write, but
`SlotToolDef<P, Readonly<T>, R>` is a *shallow* `Readonly`. So `game.inventory`
is still `string[]` and `.push()` compiles; `game.flags[k] = true` compiles.
The runtime is stricter than the type, which moves the failure from compile time
to first call. That is H10 and H11 — two shipped templates where a tool throws
on every invocation — plus `sdk/session-slot.ts`'s `set()`, which freezes the
*caller's own object* in place with no clone, so a caller that keeps a reference
gets a `TypeError` from an unrelated later line.

A `DeepReadonly<T>` on the reading half would turn all three into red squiggles.

### C4 — The guides and templates still teach `ctx.state`

Thirteen references across eight templates, plus three in published SDK doc
comments (`sdk/testing.ts:124,133,146` — including a `@typeParam S` on a
function with no type parameter, and a worked example asserting on `ctx.state`
that would read `undefined`). `HOST_ONLY_AGENT_FIELDS` still denies a `state`
key that no longer exists. `dispatch-center/shared.ts:191` claims
`dispatchSlot.update` "serializes them per session", which `sessionSlot`'s own
doc explicitly retired.

These are the files an agent author reads to learn the state model.

Out of slice but relayed by the templates reviewer: `scaffold/CLAUDE.md` —
shipped product — documents `preemptiveGeneration` as *default true* twice
(it is `false`), shows `agent({ state: … })` in the `useAgentState` example
(that would not compile), and gives `minTurnSilenceMs` a default of 2000 against
the constant's 1600.

## Correctness findings by slice

Severity is the reviewer's, and each entry states a concrete failure. Where a
reviewer noted why an existing test or fuzz harness cannot see the bug, that is
kept — it is usually the most useful line.

### `packages/aai/sdk` — correctness

1. **Every 2xx body is `res.json()`'d unguarded** —
   `workflow-api-client.ts:327,349,361,402,458,469` (medium). A proxy or booting
   sandbox answering `200 text/html` rejects with a bare `SyntaxError`, losing
   the label, the status, and the `runId` of a run the agent may already have
   created. `failure()`/`responseErrorMessage` — the whole "degrade to the
   status with a short preview" contract — is reached only from the `!res.ok`
   branch.
2. **`stepGenerate`'s own timeout escapes `StepGenerateError`** —
   `step-generate.ts:205,209` (medium). Its `AbortSignal.timeout` is caught by
   `stepFetch` and rethrown as `StepTransportError`, so `toStepError`'s
   classification falls to "else" and the documented retryable/fatal split
   silently does not apply to the two failure modes the module most advertises
   handling. Two templates copy that split verbatim.
3. **A `mode` on the source object overwrites the derived one** —
   `agent-config.ts:184` (low). The deny-list loop reassigns `wire.mode` after
   `assertProviderTriple` derived it. Typed callers are blocked by `Omit`, so
   the blast radius is a confusing deploy failure via
   `IsolateConfigSchema.superRefine`.
4. **`resolveOne` reports "no such option" for a falsy candidate** —
   `spoken.ts:176` (low). `!picked` where the other two checks in the same
   function correctly use `!== undefined`; `resolveOne<0 | 5>` cannot return
   `0`.
5. **`slot.set()` freezes the caller's own object in place** —
   `session-slot.ts:402` (low). See C3. `update` is safe because `copyForDraft`
   clones; `set` has no equivalent, and its doc ("a load, an import, a restore")
   describes precisely the case where the caller still holds the object.

### `packages/aai/host` (a–l) — correctness

1. **`createHostServer({ defaults: { maxSteps } })` is silently discarded** —
   `host-mode.ts:154` (medium). `HostSessionDefaults` explicitly includes
   `maxSteps` and documents it as operator policy; `buildHostAgent` spreads the
   base agent then writes `maxSteps: DEFAULT_HOST_MAX_STEPS` (30)
   unconditionally on the next line. Every tenant runs 30 steps. The existing
   test builds a base with `maxSteps: 5` and asserts only `typeof agent.maxSteps
   === "number"`.
2. **Response caps applied after buffering** — `builtin-tools.ts:144`, `:73`
   (medium). See C2.
3. **Builtin lookup walks `Object.prototype`** — `builtin-tools.ts:324` (low).
   `resolveAllBuiltins(["constructor"])` declares a phantom tool with no
   `execute`; `["toString"]` returns a primitive and crashes
   `agentToolsToSchemas` on `"parameters" in def`. Reachable only through the
   public `/runtime` API's untyped signature — the deploy schema is a `z.enum`.
   `Object.create(null)` + `hasOwn`.

### `packages/aai/host` (m–z) + `packages/aai/*.ts` — correctness

1. **`URIError` from an unauthenticated webhook path kills the sandbox** —
   `workflow-serve.ts:167` (**high**, H1). `GET
   /.well-known/workflow/v1/webhook/%`: `requestPath` does not decode, so the
   raw `%` clears the `""`/`"/"` guards and reaches `decodeURIComponent`.
   `webhookToken` → `pickWorkflowHandler` → `handleWorkflowRequest` are all
   non-`async`, and the guest calls them from `createServer`'s
   `options.request?.(…)` with no `try` — so it reaches
   `harness-crash-guards.ts:29` → `process.exit(4)`, taking every concurrent
   voice session with it. Under `aai dev` the request simply hangs. The three
   sibling decode sites are safe, each by a different accident: one catches
   explicitly, three sit inside an `async` router whose rejection is caught.
2. **`installWorkflowSupport` leaks a Postgres pool and an undici Agent per
   rebuild** — `workflow-install.ts:73,91` (medium). `aai dev` re-runs
   `createServer` on every save; `AgentServer.close()` closes the runtime and
   the servers and nothing else. `runtime.ts:149` fixed exactly this shape for
   `ownedDb` with a comment naming the same cause. Two saves that touched
   uploads can exhaust the documented 4-connection limit.
3. **`ctx.send` with an unserializable payload fails the whole tool call** —
   `runtime-tools.ts:269` (medium). `Buffer.byteLength(JSON.stringify(...))`
   throws synchronously inside the tool body; the model is told the tool failed
   and any state it did mutate is reported as a failure. The doc above says
   over-cap events are *dropped*, and both sibling stringify sites catch for
   exactly this reason.
4. **`countEvents` is a `count(*)` used as "next free index"** —
   `session-state-postgres.ts:138` (low). Only correct for a dense log. Past
   `MAX_SESSION_EVENTS`, or after a failed flush, a resumed session's `tail`
   goes backwards — which the module states must never happen — and `on conflict
   do nothing` silently discards the write. `max(event_index) + 1` is the query
   that means what the doc claims.
5. **`text-agent`'s `turnMessages` is instance state** — `text-agent.ts:277`
   (low). `toVercelTools` closes over `() => turnMessages` and reads it at
   tool-call time, so with two overlapping `stream()` calls turn 1's tool gets
   turn 2's conversation. The comment claims the opposite outright.
6. **`serveStatic` compares a resolved dir against an unresolved join** —
   `server-static.ts:65` (low). A relative `clientDir` 404s every asset with no
   log line. Fails closed; every in-repo caller passes an absolute path, and
   `clientDir` is a `@public` option with no stated requirement.
7. **Only three characters are stripped from an uploaded filename** —
   `workflow-api-uploads.ts:187` (low). `\x01` in a name survives into the
   metadata row, then Node rejects the `Content-Disposition` header and the
   download 500s permanently. The strip is response-splitting defence, not
   header-validity defence.
8. **`MAX_HTML_BYTES` applied after buffering** — `page-design.ts:92,134`,
   `web-search.ts:234` (low). See C2.
9. **Workflow route modules written to `tmpdir()` and never removed** —
   `workflow-serve.ts:124` (low). Two files per `createWorkflowSurface`, i.e.
   two per `aai dev` save; `moduleSeq` exists precisely so they cannot be
   reused.

### `packages/aai/host/transports` + `telephony` — correctness

The reviewer explicitly cleared the fuzz-covered paths — the turn lifecycle,
the audio gate, the `heard.cut()` latch ordering, the speculation tape, and the
S2S resume path — and could construct no failure the existing harnesses would
not already have shrunk. All four findings are where there is no harness.

1. **An in-band Realtime `error` discards the live reply's transcript** —
   `openai-realtime-transport.ts:245` (medium). `handleErrorEvent` calls
   `clearTurnBuffers()`, but the transport's own comment says an in-band error
   "leaves the socket open and the session usable" — so the response is still
   running and its buffer is live state, not turn residue. The later
   `…transcript.done` reads `""` and suppresses the emit: the caller hears the
   full reply, the client shows no transcript, nothing enters history. The two
   existing error tests never open a transcript first.
2. **The proportional heard estimate systematically over-counts** —
   `pipeline-heard.ts:329` (medium). `heardChars(ms) = spoken.length * ms /
   audioMs`, where `spoken` is every character handed to TTS but `audioMs`
   covers only the prefix already synthesized. The ratio is inflated by exactly
   the text-ahead-of-audio gap, which is widest mid-reply — i.e. when barge-in
   happens. Worked example: 42 chars recorded against ~31 actually heard, so a
   barge-in writes 11 unheard characters into history as `[interrupted]` and
   anchors the resume prompt past them. This is the over-keeping bias the module
   doc says it exists to eliminate. Neither guard rescues it: `snapToWord` moves
   a few characters, and the word-timing path is skipped whenever `words.length
   === 0`, which is every provider except AssemblyAI TTS.
3. **The telephony bridge tests a wire type that does not exist** —
   `telephony-bridge.ts:179` (low). The branch checks `type === "reset"`; the
   session emits `session.reset` (`ws-client-sink.ts:63` gets it right).
   Unreachable in production because no carrier sends `reset` — but
   `telephony-bridge.test.ts:133` feeds the bridge exactly that frame and
   passes, so the one test covering the path asserts the fiction.
4. **A late-poison speculation restart replays the spoken preamble into
   history** — `pipeline-llm-stream.ts:424` (low). The restart resets
   `collected` and the TTS coalescer but cannot reset the caller's
   `accumulated`, so `finishSpokenTurn` records the opening twice and commits it
   as the transcript. The log line's comment acknowledges the audio duplication
   but not the history half. Low only because `preemptiveGeneration` defaults
   `false`.

### `packages/aai/host/providers` + `integration` — correctness

1. **`requiredProviderEnvVars` ignores a descriptor's `apiKeyEnv`** —
   `resolve.ts:406` (medium). `envVarFor` reads only `registry[kind].envVar`, so
   `assemblyAIStt({ apiKeyEnv: "ASSEMBLYAI_STAGING_KEY" })` makes the CLI
   preflight demand `ASSEMBLYAI_API_KEY` and never notice the key actually read
   is absent. The s2s branch of the same function *does* call
   `descriptorEnvVar`, as do all three `resolve*` functions — only the three
   `envVarFor` calls skip it. This is verbatim the failure `S2S_REGISTRY`'s own
   doc says the registry exists to prevent, one stage over.
2. **Three openers give the initial connect no deadline and no abort wiring** —
   `tts/assemblyai.ts:259`, `tts/rime.ts:128`, `stt/soniox.ts:192` (medium). A
   stalled upgrade means `waitForOpen(ws)` never settles, `providers.open()`
   never resolves, and `closeOnAbort` is registered only *after* the connect —
   so the socket is held by a pending listener with no owner. The `ws-handler`
   `pTimeout` rejects the session at 10s and its own comment says it "does NOT
   cancel the underlying `start()`". The reconnect paths *do* pass a deadline,
   and that constant's doc claims the initial open "is bounded by its timeout" —
   true of the session, false of the socket.
3. **Raw-`ws` handlers emit outside `shell.safeEmit`** — `tts/rime.ts:85,93`,
   `tts/assemblyai.ts:205,293,305` (low). A throw from a downstream listener
   escapes into Node's `EventEmitter` as an uncaughtException, taking down a
   multi-tenant host rather than one session. `_utils.ts:248` declares this
   invariant explicitly and two of seven openers apply it.
4. **Soniox casts provider JSON and iterates `tokens` unchecked** —
   `stt/soniox.ts:86,103` (low). A non-array truthy `tokens` passes the `.length
   === 0` guard (`undefined === 0` is false) and throws "not iterable" out of
   `ws.on("message")`. `_s2s-fuzz-model.ts:236` states the parse layer's
   contract as "drop and warn — never throw out of the socket's message handler"
   and ships malformed frames to test it; no such guard exists here.
5. **`mayNeedRepair`'s `"choices":null` probe is whitespace-fragile** —
   `_openai-stream-repair.ts:179` (low). Justified by "`JSON.stringify` never
   puts whitespace after a colon" — a claim about *our* serializer, not the
   gateway's. A miss means the turn dies with the exact "Type validation failed"
   the module exists to prevent, after the reply already streamed.
6. **`ToolTurnAcrossResume` counts from stale model state** —
   `_s2s-fuzz-commands.ts:248` (low). Reads `m.toolsInFlight` with no `drain()`
   between the deliver and the read, so it sees the previous command's value.
   This is the composite written specifically to manufacture that state, and
   `drop.withToolInFlight` is a coverage floor.

### `packages/aai-ui` — correctness

1. **`useWorkflowSubmit` stays `pending` forever** — `use-workflow-form.ts:286`
   (**high**). It re-derives `pending` from the run snapshot and drops the
   `stopped` term. Once `useWorkflowRun` gives up after `MAX_MISSING_READS`
   404s, `run` is `undefined`, `isTerminal(undefined)` is `false`, and the
   submit button is disabled and reading "Working…" for the life of the page —
   with the correct error message shown directly above it. `useWorkflowRun`
   already exposes `polling`, whose own doc says it exists because this cannot
   be derived from the snapshot; `tracked.polling` is destructurable and unused.
2. **A negative `startIndex` makes `useWorkflowProgress` duplicate and
   mis-order** — `use-workflow-progress.ts:146` (medium). `seen` counts chunks
   handed to the caller, which equals the absolute stream offset only when the
   first read started at 0. A re-open after a `startIndex: -3` first read
   re-streams from 0, skips `seen`, and produces out-of-order duplicates. The
   comment asserts the dedupe handles it; the dedupe would need the first read's
   tail, which the reader never learns.
3. **A multi-select contributes only its first selected option** —
   `components/_form-values.ts:27` (medium). `HTMLSelectElement.value` is the
   first selected option; nothing reads `selectedOptions`. `multiple`
   type-checks on `SelectField`. Same branch also skips the `disabled` check
   that `readInput` applies to inputs, so a disabled `SelectField` contributes a
   value where a disabled `TextField` does not.
4. **`useWorkflowRuns.refresh` does not bump the generation** —
   `use-workflow-runs.ts:96` (low). Only the effect *cleanup* increments it, so
   two `refresh()` calls capture the same `mine` and a slow earlier read
   overwrites a newer one. The comment claims exactly this case is dropped.
5. **`MAX_HANDSHAKE_TIMEOUTS` counts per connection, not consecutive** —
   `session-core-handshake.ts:79` (low). `disarm()` clears the timer and leaves
   the counter, so a successful hour-long call followed by one reconnect timeout
   can exhaust a budget the constant's doc calls "consecutive".
6. **The session error banner is not announced** —
   `components/console-shell.tsx:110` (low). Plain `<div>`, no `role="alert"`,
   no focus change — and per the `fatalError` latch this banner is the only
   remaining signal. `Form` already uses `role="alert"` for the same job.

### `packages/aai-cli` — correctness

1. **A returned `fail(...)` prints nothing in human mode** —
   `_cli-common.ts:154` (**high**, H4). `runCommand` emits only from its `catch`
   block; the `result = await fn(mode)` path falls straight to the JSON check
   and `process.exit(1)`. Nine failure paths are affected: `aai test` with no
   runner binary on PATH (message *and* hint discarded), all four `aai workflow`
   subcommands against a booting sandbox, `aai secret put` with an empty entry,
   and `aai storage disable`'s `--force` hint. The module's own doc comment at
   that line asserts the opposite invariant ("A thrown error and a returned
   `fail(...)` converge here on one emitter").
2. **`withGlobalConfigLock` can spin forever** — `_config.ts:198` (medium). A
   `config.lock` *directory* (or any unlink-refusing entry) makes `fs.rm` throw
   — `force` masks only ENOENT and there is no `recursive` — the throw is
   swallowed, and `continue` restarts the loop *above* the deadline check. `aai
   login` and every `--server` invocation hang in a tight async loop with no
   output, violating the module's stated bounded-acquisition contract.
3. **`AAI_DEV_HOST` never reaches Vite** — `_dev-server.ts:286` (medium). The
   backend binds it; Vite — which owns the port the user is told to open — gets
   no `server.host` and binds `localhost`. The variable's doc gives "running
   `aai dev` inside a container" as its reason for existing, which is exactly
   the broken case. The existing test asserts only the backend `listen`
   argument.
4. **`aai dev`'s credential warnings vanish under auto-detected JSON mode** —
   `_dev-server.ts:130` (medium). Non-TTY stdout ⇒ `silenceOutput()` ⇒
   `log.warn` is a no-op. `aai dev` is precisely the case `notify()` was
   introduced for, and `packages/aai-cli/CLAUDE.md` states the rule; these three
   warnings were not converted.
5. **`aai init --json` reports success for a failed install and a failed
   publish** — `init.ts:187` (medium). Four `log.warn` diagnostics, all
   silenced; `InitData` carries no `warnings` field, so a scripted caller cannot
   distinguish the outcome from `--skipDeploy`. `executePush`/`executePublish`
   already solve this with `PushOutcome.warnings`.
6. **Platform responses narrowed by cast, not checked** — `_deploy.ts:46` (low).
   A 200 with no `slug` prints `Deployed https://server/undefined` and writes
   `slug: undefined` into `.aai/project.json` — which `JSON.stringify` drops, so
   the next deploy mints a fresh slug and orphans the agent. `studio.ts:304`
   guards this exact class with a comment recording the incident; the fix was
   applied to one response and not to `runDeploy`, `listStudioProjects`,
   `secretRequest` or `storageRequest`.
7. **`_fault-mode`'s kill queue can surface a restart failure as an unhandled
   rejection** — `_fault-mode.ts:344` (low). `cycle = cycle.then(...)` attaches
   no rejection handler; the only `.catch` is in `stop()`, seconds later. The
   comment states the intent that the failure be *reported* rather than
   swallowed, which the unhandled rejection defeats on a different channel.

### `packages/aai-guest` — correctness

1. **`studio/session-init` `rm -rf`s the workspace under a running turn** —
   `studio-session.ts:130`, `studio-workspace-fs.ts:64` (**high**, H5). A second
   tab or a refresh sends `studio/session-init` to the live sandbox;
   `materializeWorkspace` does `rm(dir, { recursive: true, force: true })` on a
   path that is constant per process — the very directory the in-flight turn's
   tools closed over. Edits since the last checkpoint are deleted, and
   `settleTurn` then syncs the mixed tree back with `done: true`. Concurrent
   variants give a tool ENOENT right after it reported success, and hand
   `buildWorkspaceDir` a half-populated tree so the agent starts "fixing"
   phantom build errors. `turnGate` gates only `POST /studio/chat`; the guest's
   own comment records that a mid-turn re-install *was measured happening*, and
   the fix at the time stopped a concurrent second turn but not the workspace
   reset.
2. **`run_code`'s 5s timeout does not bound synchronous code** — `trial.ts:36`
   (medium). `new Function` returns an async IIFE that runs synchronously to its
   first `await`; with no `await`, `pTimeout`'s timer can never fire. A
   model-authored `while (true) {}` wedges the whole guest — `/health` stops
   answering and `createIdleController`'s interval never ticks, so it cannot
   self-exit — until Modal's lifetime cap, for every concurrent session on that
   sandbox. Both `limits.ts:13` and the package guide state the timeout as
   enforced. Bounding it needs a worker with `terminate()`, not a promise race.
3. **Every `test_agent` leaks a worker bundle in `tmpdir()`** —
   `harness-bundle.ts:44` (medium). ~8 MB per call, and the tool description
   tells the agent to run it after every meaningful change. `git grep
   aai-bundle-` finds the write site and a doc reference — no `unlink` anywhere.
   The module-registry retention is unavoidable; the on-disk copy is not.
4. **The workspace test run hands `AAI_GUEST_TOKEN` to workspace-authored code**
   — `studio-test.ts:82` (medium). `env: { ...process.env, CI: "true" }` while
   executing agent-written `*.test.ts`. `studio-spawn.ts:137` defines
   `envWithoutGuestToken()` for exactly this category and `bash`/`runNpm`/the
   deploy CLI all use a scrubbed form — this is the one spawn site that does
   not. Defence-in-depth rather than a boundary (`bash` can read
   `/proc/<pid>/environ` regardless), but an unintended hole in a policy the
   package otherwise applies uniformly.
5. **`delete_file` on a directory throws instead of reporting** —
   `studio-tools.ts:320` (low). `stat` admits directories; `rm(abs, { force:
   true })` without `recursive` rejects `ERR_FS_EISDIR`, and the raw Node error
   escapes where every neighbouring failure returns prose.

### `packages/aai-server` — correctness

1. **Phone-webhook signature verification is bypassed by `?carrier=`** —
   `phone-signature.ts:136`, `phone-handler.ts:132` (**high**, H2). `requested`
   comes straight from `c.req.query("carrier")`. An agent with
   `TWILIO_AUTH_TOKEN` configured: `?carrier=telnyx` skips the Twilio branch
   (carrier mismatch) and the Telnyx branch (no `TELNYX_PUBLIC_KEY`), and falls
   through to `{ ok: true }`. The route then brokers a Modal sandbox and answers
   with TwiML containing the guest's auth-free `wss://…/phone` URL. Symmetric: a
   Telnyx-only agent is bypassed by omitting the param. The route carries only
   `slugMw` — no auth middleware — and this is the sole check.
   `phone-signature.test.ts:239` pins the fall-through as `{ ok: true }`, which
   is right *in isolation*; the bug is that the route lets the caller pick the
   branch. Fix shape: if any carrier secret is configured, an unverifiable
   request must be refused.
2. **An unauthenticated `Host` header poisons other tenants' guests** —
   `public-origin.ts:84`, `app-middleware.ts:46`, `warm-harness.ts:294`
   (**high** when `AAI_PUBLIC_ORIGIN` is unset, H3). `rememberPublicOrigin` runs
   on every request before any auth and writes a module global. One `GET
   /health` with `Host: evil.example` sets it; the next sandbox this replica
   spawns — any slug, any tenant — boots with
   `AAI_PUBLIC_BASE_URL=https://evil.example/<slug>`, which is what
   `ctx.workflows.publicWebhookUrl(token)` mints. A payment callback then
   delivers payload and run token to the attacker and the run never resumes.
   **This is a regression against a shipped plan:**
   `research/3.75-guest-public-origin.md` is `status: implemented`, and
   `public-origin.ts:32` still argues the blast radius is "self-directed — the
   origin is only ever paired with the same request's bearer token", which was
   true before `rememberPublicOrigin` existed.
3. **A failed app-database deprovision strands the tenant schema permanently** —
   `delete.ts:40` (medium). The warning-and-continue path deletes the
   `app-db:<slug>` secret and the agents row, so the schema and login role
   survive with their only credential record gone and nothing naming the slug.
   The comment asserts "a later retry can finish the job"; there is none — the
   orphan sweep matches `slug like '%-preview'` only, and `slugs()` no longer
   lists the agent.
4. **`POST /:slug/storage` on an enabled app rotates the role password under the
   running guest** — `storage-handler.ts:63` (medium). `enableStorage` is
   unconditional and `provisionAppDatabase` mints a fresh password every time.
   `aai storage enable` run twice is enough: the resident sandbox's baked
   `DATABASE_URL` stops authenticating and `ctx.db` errors mid-session. The
   studio path reads `storageStatus` first — that guard is what is missing here.
5. **The deploy body semaphore is held across the key-verification round trip**
   — `orchestrator.ts:239` (medium). `deployBodyGate` acquires one of 2 slots
   and releases only after `next()`, so the slot covers `authMw` →
   `assertVerifiedApiKey`'s 5s outbound fetch to AssemblyAI plus a Vault round
   trip. Two junk-bearer requests hold both slots while AssemblyAI is slow, and
   legitimate deploys 503. The gate's comment prices a slot in RSS, i.e.
   buffering — not latency. Moving `authMw` ahead of the gate removes it;
   `authMw` reads headers only.
6. **Empty slot shells accumulate** — `sandbox-resolve.ts:286` (low). Both
   `deleteSlot` calls in `rebuildSlot` are gated on `created`, so a rebuild that
   finds no bundle for a slug that already had a slot leaves a `{ slug }` shell
   forever; `reconcileSlug` returns early on `!slot?.sandbox`.
7. **The guest client-config memo is keyed on a reusable loopback port** —
   `client-config-handler.ts:64` (low, subprocess backend only). The doc's
   premise "a guest origin is unique to one sandbox" holds for Modal tunnel
   hostnames, not `ws://127.0.0.1:<port>`; within the 10-minute TTL, `GET
   /B/client-config` can return A's name and greeting.

### `packages/aai-studio-server` — correctness

1. **`reuseSession` never refreshes the fleet lease** —
   `studio-session-ensure.ts:178`, `studio-session-fleet.ts:110` (**high**, H6).
   It sets `existing.lastUsed` and calls nothing on `fleet`, so `expires_at`
   never extends. A user reloading every few minutes without completing a turn
   lets the registry row expire under a live, locally-fresh sandbox. The next
   broker call on a peer replica: `sessions` miss → `fleet.adopt` →
   `registry.get` null → `spawnNamed` → Modal refuses the duplicate name →
   `null` → **404 "Project not found"** for a project that exists. `git grep
   'fleet.touch'` finds one caller, and it is not this path.
   `studio-session-registry.ts` states the invariant: "LIVENESS is the lease,
   refreshed by any replica that brokers the project."
2. **The idle sweeper can terminate a sandbox mid-Publish** —
   `studio-session-broker.ts:245`, `studio-session-publish.ts:160` (medium).
   `WORKSPACE_DEPLOY_TIMEOUT_MS` is 330s against `STUDIO_SESSION_IDLE_MS` 300s,
   and `runDeploy` touches only *after* `requestDeploy` returns. A 200s cold
   build started at T+120s is swept, `disposeEntry` terminates the sandbox
   mid-`workspace/deploy`, the whole build re-runs from scratch, and the
   browser's chat URL is dead. Nothing in `createSessionReaper` consults
   in-flight work.
3. **`previewError` can never clear once the workspace reverts** —
   `studio-preview.ts:330` (medium). Revert a bad edit and the files hash
   returns to the last successfully-deployed value; `attempt` returns early on
   `previewHash === hash` *before* stamping anything, so the error survives.
   Every later open schedules another no-op. The `gone` branch clears
   `previewHash` first; the `retrySettledFailure` branch does not.
   `studio-concurrency-fuzz.test.ts` cannot see it — its convergence invariant
   counts a `previewError` stamp as settled.
4. **Two long project names share a preview slug** — `studio-preview.ts:208`
   (medium). `previewSlugFor` truncates to 56 chars while `ProjectNameSchema`
   admits 64. Both deploys succeed (same account), both stamp their own
   `previewHash`, and one agent serves both Preview panes with no error. The
   comment argues collisions are safe because names are suffix-randomized
   server-side — true only for server-generated names, and `aai push` accepts an
   explicit one.
5. **A secret PUT/DELETE against a nonexistent project writes the Vault record,
   then 404s** — `studio-secrets.ts:213` (low). The record write is
   unconditionally first; the existence check lives three statements later
   inside `overProjectAgents`. Nothing cascade-deletes it, so a later project of
   that name inherits the orphan values on first deploy.
6. **`preview/wake` has no rate limiter and an LRU-evictable throttle** —
   `studio-routes.ts:479` (low). `wokenRecently` is a `TtlCache<true>(30_000,
   1000)`; cycling >1000 distinct names evicts faster than the TTL. The route's
   own doc justifies being unmetered by "the throttle below", which a fixed-size
   LRU does not guarantee.

### `packages/aai-studio-client` — correctness

1. **`notifyChat`'s append path corrupts the transcript mid-stream** —
   `src/chat.tsx:329` (**high**, H7). Verified against the resolved `ai@7.0.62`:
   `write` compares `response.state.message.id` to `this.lastMessage?.id` and
   takes `pushMessage` when they differ. A silent note appended mid-turn becomes
   `lastMessage`, so the next chunk pushes instead of replacing — leaving the
   same object at two indices with the same React key, and that array is what
   gets persisted. Triggered by saving a secret, toggling the Database card, or
   a Publish resolving. `notifyDispatch` chooses `"append"` as the *safe*
   fallback for the busy case, which is the one case where it is not.
2. **A studio REST 401 signs the user out globally** — `src/app.tsx:197`
   (**high**, H8). supabase-js pauses refresh on hidden tabs; focusing a >1h-old
   tab refetches `projects` and `workspace` with a dead bearer, and the effect
   calls `auth.signOut()` with no scope — revoking the refresh token on a
   session that was still recoverable. `main.tsx:317` documents this exact bug
   and fixes it only for the account query, so two policies now race on the same
   focus event; the synchronous effect wins.
3. **`GET /studio/status` carries no deadline** — `src/api.ts:184` (**high**,
   H9). A hung read never settles, so `status.data` stays `undefined`: the home
   hero's textarea and Send are disabled behind "Checking the server's chat
   status…", and inside a project `chatReady` stays false so the composer is
   disabled and `send()` returns early. No error, no retry, no way out but a
   reload. The package guide states the invariant; only four calls in the
   package carry a timeout and this is not one.
4. **`AccountGate` refreshes during render and can leave a blank page** —
   `src/main.tsx:317` (medium). `void refreshAuth(); return null;` in the render
   body (doubled under `StrictMode`). Against a server that will 401 a
   *refreshable* token — different Supabase project, JWT-secret mismatch, clock
   skew — `refresh` only clears the token when `refreshSession` errors, so there
   is no terminal state: either an unbounded refresh+fetch loop behind a blank
   screen, or a permanent blank when gotrue's reuse interval returns the same
   token.
5. **Unsaved editor edits are silently discarded on a pane switch** —
   `src/app.tsx:455` (medium). `{tab === "code" && …}` unmounts `CodeView`,
   taking `useFileDraft`'s state with it; `FileBuffer` keyed on `currentFile`
   does the same on file selection. The hook's own doc calls itself "the one
   place user work can be lost" and builds `dirty`/`conflict` machinery — which
   nothing consults before unmounting. No `beforeunload`, no confirm, no
   lift-up.

### `packages/aai-templates` — correctness

1. **`game_state_take` / `game_state_flag` mutate a frozen value** —
   `templates/infocom-adventure/tools/game_state_take.ts:4`,
   `game_state_flag.ts:4` (**high**, H10). Declared with `slot.tool` (the
   reading half); `game.inventory.push(...)` and `game.flags[k] = true` throw on
   the first call and every call. `durable` defaults true, so `freezeStorable`
   deep-freezes. See C3 for why the types allow it. The six sibling tools
   correctly use `updateTool`. **This template has no spec at all**, so nothing
   in the repo executes either body.
2. **`oracle`'s `chaos_check` mutates a frozen value** —
   `templates/solo-rpg/tools/oracle.ts:222` (**high**, H11).
   `checkChaosInterrupt(gameSlot.get(ctx))` assigns `game.chaosFactor` when the
   roll lands — ~1 call in 5 at the default, rising to ~6 in 10 as the factor
   climbs. The in-place comment says *"gameSlot.get returns the live state
   object — mutations stick"*, which describes the removed `ctx.state`
   behaviour. The sibling call site is correct (inside `updateTool`);
   `agent.test.ts` never exercises `oracle`.
3. **A WAV declaring `sampleRate: 0` makes `planSegments` loop forever** —
   `templates/transcription-workflow/workflows/wav.ts:229` (medium). `parseWav`
   validates `encoding` and `blockAlign` but never the sample rate; `perSecond`
   becomes 0, so `stride` is 0 and the loop pushes a `Segment` per iteration
   until OOM. Pure CPU, so `AbortSignal.timeout` does not help. This is the one
   workflow app taking an arbitrary uploaded file over a public form.
4. **Two sensitive tools in one step silently discard the first staged action**
   — `templates/travel-concierge/shared.ts:382` (medium). The LLM loop runs a
   step's tool calls concurrently; `stageAction` assigns `state.pending`
   unconditionally. Both tools return `awaitingConfirmation`, the model reads
   both back, the caller says yes, and only the second is applied — with nothing
   anywhere saying so. The field's own doc states the "at most one at a time"
   invariant it does not enforce.
5. **`exchange_delivered_order_items` sorts two positional lists independently**
   — `templates/retail/tools/exchange_delivered_order_items.ts:64` (medium). The
   schema says "each matching the item in the same position" and `planItemSwap`
   prices it by index — then the tool stores and returns both lists separately
   `.sort()`ed, so the recorded pairing is permuted relative to the price the
   caller was quoted. tau2's own implementation does the same two sorts, so this
   may be deliberate fidelity — but there is no comment saying so, and the
   result is internally inconsistent either way.
6. **`pastSteps` grows without bound into the prompt and every `syncState`
   frame** — `templates/plan-and-execute/tools/work_next_step.ts:57` (low).
   `historyOf(pastSteps)` renders the whole list into two prompts and `planView`
   sends it verbatim; ~12 KB per model call at twenty steps, growing linearly.
   The same file's *smaller* list is capped with `pushCapped` and a comment
   naming exactly this reason.

### `scripts/` + `packages/aai-evals` — correctness

1. **Rule 17 grades 1 of 21 occurrences** — `guard-invariants-rules.mjs:323`
   (**high**, H12). See C1.
2. **Both baseline ratchets exit 0 on an empty scan** —
   `check-escape-hatches.mjs:335`, `guard-invariants.mjs:481` (**high**). See
   C1.
3. **`turn(index)` out of range vacuously passes every negative assertion** —
   `packages/aai-evals/assertions.ts:341` (medium). It records one failure and
   returns `eventScope(recorder, [])`; `noErrors()`, `notEvent()`,
   `notCalledTool()`, `usedNoTools()`, `maxToolCalls()` and `saidNothingAbout()`
   then all record `ok: true` against an empty list. A three-call chain on a
   nonexistent turn scores 75%. The package guide says out-of-range "FAILS
   rather than silently asserting nothing" — it fails once, then silently
   asserts nothing.
4. **`runEval` averages harness-error passes into the score and spread** —
   `packages/aai-evals/runner.ts:214` (medium). `spreadOf(passes.map(p =>
   p.score))` applies no filter on `p.error`, so a pass that died after two
   passing checks scores 1.0 and sets `score.max`. `EvalPass.error`'s own doc
   says averaging the two "hides both", and `unstableLabels` *is* guarded — the
   spread is not.
5. **`:!scripts/**/*.md` excludes nothing at the top level** —
   `check-escape-hatches.mjs:140`, `guard-invariants-rules.mjs:145` (medium,
   latent). See C1.
6. **`SELF_REFERENTIAL` grants blanket `"*"` to two ordinary SDK modules** —
   `guard-invariants.mjs:168` (medium, latent). `sdk/epoch.ts` and
   `sdk/session-slot.ts` are exempt from all twelve line rules; the latter's
   stated justification names *retired* rule 6. `session-slot.ts` is the state
   primitive every template goes through.
7. **Three absolute scanners read a git-index path with no existence check** —
   `guard-invariants-scanners.mjs:65,300,408` (medium). An unstaged deletion
   kills `check:invariants` with an uncaught ENOENT, taking all eighteen rules
   with it — and names a file the author already deleted.
   `scanResearchFrontmatter` guards exactly this and documents having been
   bitten; three sibling gates guard it too.
8. **`check-test-assertions.mjs` prints ✓ for zero scanned tests** — `:267`
   (low). Same class as #2; a one-line floor is what `check-claude-md.mjs:88`
   already does.
9. **`runScaffoldTsc` discards stderr** — `_scaffold-tsc.mjs:61` (low). A
   missing `tsc` binary produces an empty diagnostic followed by "a
   documentation example does not compile", pointing the reader at the templates
   instead of the toolchain.
10. **`installFakeSpeech()` leaks a global registration when setup throws** —
    `packages/aai-evals/session-target.ts:97` (low). No `try`/`finally` between
    the install and the returned `close()`, so `AAI_EVAL_REPEAT=5` against a
    failing agent leaves five orphaned kind pairs registered for the worker's
    life.

## Quality findings by slice

Compact form. Category is one of reuse / simplification / efficiency / altitude.

### `packages/aai/sdk` — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | `isRecord` lives in the `utils.ts` barrel, so modules that barrel re-exports **cannot** import it — nine hand-rolled guards result | `sdk/utils.ts:104` | Split to `sdk/is-record.ts`, re-export from `utils.ts` — the move `safe-json-parse.ts` and `omit-undefined.ts` already document. Note `step-generate-json.ts:102` must keep accepting arrays |
| 2 | Inverted spread-ternary rule 2 cannot see | `providers/llm/assemblyai.ts:212` | `omitUndefined({ reasoningEffort })` |
| 3 | Two spellings of "attach an optional signal" in one feature | `workflow-upload-client.ts:78` | `omitUndefined({ signal })`, as `workflow-api-client.ts:425` already does |
| 4 | Published `/testing` docs describe `ctx.state`, incl. a `@typeParam S` on a function with no type parameter and an example asserting on it | `sdk/testing.ts:124,133,146` | See C4. Also `workflow-options.ts:19`, `utils.ts:267` |
| 5 | `HOST_ONLY_AGENT_FIELDS` denies a `state` field that no longer exists | `agent-config.ts:129` | Remove the entry; the type-level guard cannot catch a superfluous one |
| 6 | `spokenOrdinal` compiles thirteen `RegExp`s per call, on the tool path | `spoken.ts:96` | Precompute, or one alternation |
| 7 | Three names, one value (200), three truncation behaviours | `utils.ts:211`, `step-generate.ts:50`, `step-generate-json.ts:46` | One `previewBody(text)` beside `responseErrorMessage` |
| 8 | The fake gateway parses its own request body with bare `JSON.parse` | `testing-gateway.ts:131` | `safeJsonParse` — a throw here reads as a bug in the code under test |
| 9 | `mapInBatches` spreads a whole batch through the argument list | `map-in-batches.ts:85` | `size` is uncapped; a large width is `RangeError: Maximum call stack size exceeded` from a line that reads as concatenation |

### `packages/aai/host` (a–l) — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | Four call sites re-derive "fetch a URL, bound it, shape the failure" | `builtin-tools.ts:64,131` | One `fetchCapped(...)` streaming via `getReader()` — also the fix vehicle for C2 |
| 2 | Three conditional spreads `omitUndefined` owns | `host-server.ts:111` | Its sibling front door `agent-server.ts:111` already does it |
| 3 | An orphaned JSDoc block above the wrong function | `host-mode.ts:240` | Move it down to `s2sConfigFromHandshake` at `:281`, which has none |
| 4 | Two hand-rolled copies of the backpressure latch | `_audio-gate.ts:41`, `ws-client-sink.ts:74` | One `createBackpressureGate`; the two remedies become callbacks |
| 5 | `run_code` special-cased outside both registries, and pays a cast | `builtin-tools.ts:323` | A third record of the same shape |
| 6 | Three wrappers restate one arg normalization; the object form silently drops `options` | `agent-tools.ts:105` | One `normalizeSpec` helper |
| 7 | One anchored `*`-quantified regex used twice — as a whole-string test and as a character classifier | `_calculate.ts:122` | One non-anchored complement, single pass |
| 8 | Redundant truthiness guard in front of `isDescriptor` | `generate.ts:89` | `isRecord(undefined)` is already `false` |
| 9 | Unreachable `default` returns `undefined` while typed as returning a value | `_fake-llm.ts:71` | `throw` after the `never` assignment — a fake that fabricates a bad frame is the fidelity problem |

### `packages/aai/host` (m–z) + root — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | Open-coded record guard plus a cast (negated spelling, invisible to rule 17) | `s2s.ts:362`, `tool-call-repair.ts:122` | `isRecord` — see C1 |
| 2 | `decodeURIComponent` on a path segment, five sites, three different failure regimes, none stating which | `workflow-serve.ts:167` +4 | One `decodePathSegment(raw): string \| undefined` beside `requestPath` — this is H1's structural fix |
| 3 | `page-design` runs a real htmlparser2 parse, then strips `<script>`/`<style>`/comments with regexes over the same bytes | `page-design.ts:34,153` | Strip during the parse it already runs; `web-search.ts:126` documents abandoning exactly these regexes |
| 4 | The builtin fetch preamble restated at five sites | `page-design.ts:87,127`, `web-search.ts:224` | Same helper as C2 |
| 5 | Two copies of the tool dispatcher | `runtime-tools.ts:298`, `text-agent.ts:279` | One `createToolDispatcher` |
| 6 | `createWorkflowApi` and `createSessionEventsApi` are the same router twice | `workflow-api.ts:355`, `session-events-api.ts:183` | One `claimUnder(prefix, logger, label, route)` — makes the async-catch guarantee explicit rather than incidental |
| 7 | `resolve()` linear-scans for an identity lookup the module already indexes in the other direction | `workflow-client.ts:150` | Build `nameByDef` in the loop that fills `declaredNameById` |
| 8 | A 10-entry route table rebuilt per instance and scanned per request | `workflow-api.ts:215` | Hoist to a module constant — its ordering rules are properties of the table |
| 9 | `entryFor` get-or-create written twice over the same key space | `session-state-store.ts:373`, `session-event-stream.ts:185` | `getOrCreate(map, key, make)` |
| 10 | The idle watchdog's 300s timer is not `unref`'d where three siblings are | `session-idle.ts:66` | An `unref` option on `createCoalescingTimer` |
| 11 | `concat()` reimplements `Buffer.concat` on the upload hot path | `workflow-uploads.ts:151` | `Buffer.concat(parts, size)` |
| 12 | Per-event allocation on the live-call path | `session-emitter.ts:82`, `ws-client-sink.ts:64` | Two `if`s instead of a two-element array; hoist the closure to the two types that defer |

### `packages/aai/host/transports` + `telephony` — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | The S2S transport is seven interdependent closure flags — the arrangement `createTurnMachine` was written to replace | `s2s-transport.ts:56` | A `S2sLinkPhase` discriminated union; `whileLive` becomes a phase query. The S2S property test is the safety net |
| 2 | Two turn facts live outside the turn machine that claims to own turn state | `pipeline-transport.ts:84` | Fold `turnDraining` / `resumeTurnScope` into `TurnMachine` |
| 3 | The downsampler computes two FIR outputs in three and discards them | `telephony/resample.ts:161` | Polyphase decimator: ~1.5M MACs/s → 500k, plus 150 allocations/s/call removed |
| 4 | Open-coded record guard plus a cast | `openai-realtime-transport.ts:310` | `isRecord` — already used twice in this slice |
| 5 | `agentIsSpeaking` — the predicate every barge-in gate turns on — written twice in one file | `pipeline-user-speech.ts:140,367` | Define once, pass as a dep like `edgeGate` already is |
| 6 | Four spellings of the fatal/non-fatal error decision | `s2s-transport.ts:125,242`, `openai-realtime-transport.ts:130,375` | `createEmitError` exists and only the pipeline uses it |
| 7 | Four spread-ternaries in the spelling rule 2 cannot see | `pipeline-llm-trace.ts:101`, `pipeline-stream-parts.ts:108` | `omitUndefined` |
| 8 | `recordableChars` and `recordableText` are one span walk written twice; `position()` runs both | `pipeline-heard.ts:341` | One `recordable(chars)` returning both |
| 9 | "Send text to TTS" has three signatures across four modules, one positional `boolean` | `pipeline-transport.ts:230` | One exported `SendTtsText` type threaded unchanged |
| 10 | `terminate()` leaves provider listeners attached where `stop()` unsubscribes | `pipeline-transport-lifecycle.ts:141` | Move `unsubscribe()` into `quiesce()`; safety currently rests on four separate guards |
| 11 | `whileLive` applied by hand at twelve call sites, exemptions recorded only in a comment | `s2s-transport.ts:150` | One `gateInbound(raw, { except })` so a new callback is gated by default |

### `packages/aai/host/providers` + `integration` — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | The "connect a raw ws, drop it on failure, rethrow" block copy-pasted three times, none with a deadline | `stt/soniox.ts:188`, `tts/rime.ts:127`, `tts/assemblyai.ts:257` | One `openGuardedWs(...)` — also where the missing deadline lands as a one-line change |
| 2 | `shell.safeEmit` applied in 2 of 7 openers | `_utils.ts:315` | A `shell.emit` owning both the closed latch and the try/catch, so openers stop touching `emitter.emit` |
| 3 | Every opener re-implements the session envelope; three hoist their frame handler out *explicitly to stay under the complexity cap* | all 7 openers | A small per-adapter session object. Large — a direction, not a demand. Worth noting the cap is being satisfied by moving code rather than reducing it |
| 4 | `on(event, fn) { return emitter.on(event, fn); }` written seven times | all 7 openers | Expose `on` from the shell |
| 5 | "An explicit URL wins over `region`" implemented twice, with near-identical comments | `stt/assemblyai.ts:141`, `_llm-registry.ts:127` | One `pickEndpoint` — note the two differ in the US case |
| 6 | A module-local `errorDetail` shadowing the repo-wide one, both in scope | `tts/assemblyai.ts:149` | Rename to `formatErrorFrame` |
| 7 | A doc block attached to the wrong function, leaving a cast unjustified | `stt/assemblyai.ts:134` | Move it to `buildTranscriberParams` at `:156` |
| 8 | A comment contradicting its own code and citing a stale fact ("the AssemblyAI S2S descriptor takes no options at all today" — it has taken three since 2026-08-09) | `_provider-settings.ts:132` | Delete the comment; drop `?? { kind: "assemblyai" }` so an absent descriptor logs as absent |
| 9 | `ALL_PROVIDER_ENV_VARS` is a module-load snapshot of mutable registries | `resolve.ts:442` | Make it a function; a `registerSttKind`'d env var is silently outside two allowlists |

### `packages/aai-ui` — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | Five copies of the "client in a ref + lazily-built fallback" preamble, four with the same explanatory paragraph | `use-workflow-run.ts:176` +4 | One `useWorkflowApiRef(api?)`; ~70 lines and four comment blocks |
| 2 | One React commit per progress line, and an O(n²) copy building the list | `use-workflow-progress.ts:274` | `consumeFrames` already drains a whole read — batch the callback |
| 3 | Hand-rolled generation counter in a package that already imports `createEpoch` | `use-workflow-runs.ts:96` | `createEpoch()`; also makes the A4 bug hard to reintroduce |
| 4 | `client()` and `page()` carry two copies of the mount/dispose plumbing, comments included | `define-client.tsx:285`, `page.tsx:100` | One internal `mountRoot(...)` |
| 5 | `createCaptureNode.stop()` hand-rolls resolver bookkeeping | `audio.ts:169`, `:376` | `Promise.withResolvers()` (`p-timeout` is not a dep here and adding one trips the size budget) |
| 6 | `GET client-config` fetched twice per page load — and on the platform that endpoint is the broker, able to boot a sandbox | `define-client.tsx:194` | A first-call-only memo, not a cache — reconnects must still re-fetch |
| 7 | Three near-identical "bounded read, re-armed from the settled read" loops | `use-workflow-run.ts:51` +2 | One `repeatUntil(...)` for the token/timer/re-arm scaffold only; skip if it reads worse |
| 8 | The playback worklet reports `bufferedMs` against the worklet global where every other derived quantity uses `rate` | `worklets/playback-processor.ts:280` | Diverges only in the node-less harness the escape hatch exists for |
| 9 | The `firstRun` history guard is unreachable for `useToolResult` | `hooks.ts:101` | Decide and say so — today the comment describes behaviour only one of its two callers has |

### `packages/aai-cli` — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | Twenty-four citty command bodies are one shape written longhand, with the cwd policy re-decided per command | `cli.ts:53` +2 files | One `defineExec({ cwd: "agent" \| "any" \| "none", … })`. That policy has been wrong once — `aai test` shipped without `{ agent: true }` and reported a green skipped suite in an empty directory |
| 2 | `executeDelete` resolves the deploy target twice — two config reads, two `ensureApiKey`, two lock acquisitions | `delete.ts:47` | Call `resolveDeployTarget` once and branch on the returned config |
| 3 | The restart supervisor re-derives `createCoalescingRunner` | `_dev-restart.ts:87` | Converge — but the boot state is a real design decision, not a swap |
| 4 | `scaffoldProject`'s spinner leaks on failure | `init.ts:132` | One `withSpinner(...)` releasing in `finally` |
| 5 | Three stacked injectable-`fetch`/`retryDelay` seams for one HTTP client, two unused in production | `_deploy.ts:23` | Keep the seam at `apiRequest` alone |
| 6 | A fourth spelling of trailing-slash stripping, already applied upstream, and disagreeing with it | `workflow.ts:68` | Drop it — every producer is `resolveServerUrl` |
| 7 | `resolveTsc` parses the TypeScript manifest twice, after every settled write burst in the studio | `typecheck.ts:80` | One `readPackageJson` |
| 8 | `commandPath` hand-rolls `Resolvable` handling `_cli-common.ts` already owns | `cli.ts:43` | Move it beside `resolve` |
| 9 | Two sync reads + a parse at module load on every invocation, on a deliberately-budgeted startup path | `cli.ts:33` | Lazy getter, or inline at build time |
| 10 | `fail<T>`'s type parameter is unused at all ten call sites | `_output.ts:67` | `CommandResult<never>` |

### `packages/aai-guest` — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | Two post-write diagnostics runners per turn, defeating the coalescing the module documents | `studio-tools.ts:202`, `studio-template-tools.ts:252` | Build the checker once — `studio-chat.ts:135`'s comment says building it twice doubles the runner, and both factories then do exactly that |
| 2 | Agent-mode cold start evaluates the whole studio coding-agent graph (AI SDK, zod, picomatch, diff, all tool prose) | `harness.ts:94` | Dynamic-import the mode branches — but verify against `codeSplitting: false` first, and measure: `NODE_COMPILE_CACHE` already covers parse |
| 3 | `TurnGate.busy` is production-dead — and is exactly the predicate H5 needs | `studio-turn-stream.ts:82` | Consume it or delete it |
| 4 | The checked-extension set written three times, two with comments asserting they mirror another | `studio-syntax.ts:43` +2 | One `SCRIPT_EXTENSIONS` + `isScriptFile(rel)` |
| 5 | `SYNC_RPC_TIMEOUT_MS` declared twice with the same doc comment | `studio-chat.ts:55`, `studio-turn-settle.ts:18` | Export from the module that owns the concern |
| 6 | Four `&&`-form conditional spreads, invisible to rule 2 | `studio-build.ts:194`, `studio-template-tools.ts:290` | `omitUndefined` — but leave `harness-bundle.ts:199` and `studio-agent.ts:98`, the documented guard-is-not-the-value cases |
| 7 | One harness↔tools dependency pair declared three times, each with its own JSDoc | `studio-chat.ts:73` +2 | One `HarnessBundleAccess` in `harness-types.ts` |
| 8 | Synchronous filesystem reads on the async diagnostics path, concurrent with live voice sessions | `studio-build.ts:318`, `studio-test.ts:56` | `node:fs/promises`; `createRequire().resolve` must stay sync |
| 9 | `compactMessages` re-estimates the whole conversation three times per step (~240 KB of `JSON.stringify` per pass) | `studio-compaction.ts:144` | Thread the computed estimate |
| 10 | `withStreamErrorChunk`'s `failed` branch is unreachable | `studio-turn-stream.ts:118` | The `catch` alone is the whole behaviour |
| 11 | A "transformer unavailable" verdict cached for the process lifetime, silently disabling the write-time syntax gate | `studio-syntax.ts:55` | Mirror `loadToolchain`'s reset-on-failure, or say why it differs |

### `packages/aai-server` — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | Three guest-proxy handlers each re-derive broker → URL → header filter → fetch-with-timeout, with an allow-list in one, a deny-list in another and none in the third | `client-config-handler.ts:73`, `workflow-handler.ts:132`, `workflow-webhook-handler.ts:144` | One `forwardToGuest(...)`. Pick the allow-list — the deny-list currently forwards `Cookie`, `Authorization` and `X-Forwarded-*` to tenant code |
| 2 | `SlotCache` is an `OwnedMap` whose ownership affordance is used nowhere — `claim`'s release is discarded, `owns()` is called by no production code, and the type's justification names it | `sandbox-slots.ts:40,100` | Either keep the release and delete the hand-written identity checks, or use a plain `Map` and say the slug lock is the exclusion |
| 3 | Hand-rolled single-flight where `_memo.ts` exports one — and the comment cites the correct version as precedent | `api-key-verify.ts:106` | `createSingleFlight` |
| 4 | Two byte-identical `WeakMap<SecretStore, TtlCache<string>>` factories | `middleware.ts:42` | One `secretScopedCache(ttlMs)` |
| 5 | The orphan sweep hardcodes the preview suffix and both Vault prefixes in SQL, while the guide names it as a consumer of `PREVIEW_SLUG_SUFFIX` "because a disagreement is silent data loss" | `pg-cron.ts:119,145` | Interpolate from the constants |
| 6 | Memory stores key composites with `/` where `projectKey` is the declared spelling; `list`'s `startsWith` leaks across scopes that are string prefixes | `workspace-store.ts:208`, `chat-store.ts:126` | Import `projectKey`; index by exact scope |
| 7 | Channel topics composed with `:` while the pool key uses `projectKey` — and the health monitor is keyed on the *topic*, so two pairs that collapse share and clobber one `ChannelState` | `realtime-events.ts:367` | Derive the topic from `projectKey` |
| 8 | `allowedOrigins` is dead config whose documented default ("any origin") is the opposite of the behaviour (reject all) | `orchestrator.ts:166` | Thread it from env or delete it. Fail-closed, so not a hole — but it would mislead |

Also: `test-utils.ts:41` refers to `missingCredentials` in `deploy.ts`, which no
longer exists — it moved to `aai-cli/_preflight.ts`.

### `packages/aai-studio-server` — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | "Force the preview to redeploy" written three times, with two different omissions — one of which *is* correctness finding 3 | `studio-database.ts:215`, `studio-secrets.ts:147`, `studio-preview.ts:189` | One `forcePreviewRedeploy(...)`; the divergence becomes unrepresentable |
| 2 | Two functions hand-roll the owned-slug pair `ownedProjectSlugs` already returns — one sequentially | `studio-database.ts:100,196` | Use it, as `studio-secrets.ts` does |
| 3 | Secret mutations re-read the project three or four times per request | `studio-secrets.ts:213` | Resolve workspace + owned slugs once and thread them; roughly halves the panel's store round trips |
| 4 | The SSE shared readers close over the Hono `Context`, pinning the first stream's request and response for as long as any later stream on that key is open | `studio-events-routes.ts:64` | Destructure before the closures, as `ensureBroker` documents doing |
| 5 | Three hand-rolled `try { JSON.parse } catch` where `safeJsonParse` is already used in the package | `studio-account-routes.ts:45` +2 | `parseCliLinkGrant` guards a one-shot API-key exchange and is worth a schema |
| 6 | `ensureBroker` allocates two hook closures per request for a once-per-process construction | `studio-routes.ts:152` | Move inside the `if (!broker)` |
| 7 | `heldByUs` fabricates a fake record via a cast to express "true" | `studio-session-fleet.ts:114` | `.then(r => r?.owner === replicaId, () => true)` |
| 8 | `GuestWiringDeps.touch` / `previewTarget` declare parameters no implementation reads | `studio-session-wire.ts:60,66` | Declare them zero-arg |
| 9 | `assertSafeFilePath` discards the normalization it computes, so `agent.ts` and `./agent.ts` store as two keys denoting one file | `studio-workspace.ts:147` | Rebuild the map from parsed keys, or key `SyncSourceSchema.files` on `SafePathSchema` |
| 10 | `studio-routes.ts` sits at exactly the 500-line cap with no allowlist entry — the next route fails the gate | `studio-routes.ts:500` | Lift project CRUD + `PUT /source` out; `studio-preview.ts` at 487 has the same pressure |
| 11 | `projectPayload` is `Record<string, unknown>` for the payload two external consumers parse — including `aai pull`'s fast-forward token | `studio-sse.ts:37` | A named type, or a zod schema shared with the client |

### `packages/aai-studio-client` — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | Four of ~18 requests carry a deadline; the other ~14 do not | `src/api.ts:166` | A default `timeoutMs` in `request()`/`agentRequest()`, composing with `AbortSignal.any` — the fix vehicle for H9 |
| 2 | Three "the bearer was rejected" call sites, two opposite conclusions, resolved by a render/effect race | `src/app.tsx:197`, `src/main.tsx:317`, `src/use-event-stream.ts:84` | One handler that refreshes first and signs out only when the refresh fails — already `auth.refresh`'s stated contract |
| 3 | `currentFile` is state plus a sync effect, needing an `EMPTY_FILES` stable-identity trick | `src/app.tsx:231` | Derive during render; `code-view.tsx:36` already uses that pattern and cites the React docs |
| 4 | `ProjectChat` holds six concerns in ~200 lines | `src/chat.tsx:198` | `useMessageQueue` + `useNotifyRegistration` — and it is where H7's busy guard belongs |
| 5 | `useCopy`'s flash timer and `flashSaveState` are the same primitive, same 1500ms, same three-line comment | `src/use-copy.ts:28` | `useFlash<T>(ms)` |
| 6 | Three gate forms and the account menu re-implement `draft/busy/error/submit` — two of them over the same endpoint | `src/main.tsx:61` +1 | `useMutation`, as the rest of the package uses; one shared `<ApiKeyField>` |
| 7 | Ten `as string` casts under truthiness guards | `src/workflows-card.tsx:170`, `src/app.tsx` ×6, `src/top-bar.tsx:96` | An inner component with a required prop. Invisible to `check:hatches`, which counts only `as any` / `as unknown as` |
| 8 | `handleStop`'s rationale is false for `ai@7` — `onFinish` *does* fire for an abort, and is passed `isAbort` | `src/chat.tsx:346` | Drop the manual invalidate; the comment is load-bearing for the next reader |
| 9 | Four spread-ternaries | `src/api.ts:237` | `omitUndefined` (already an available dep via `api-error.ts`) |
| 10 | `PaneBanner` takes the whole pane's props to read two fields | `src/preview.tsx:177` | Two named props |
| 11 | `window.location.origin` re-derived three times, each with its own copy of the same comment | `src/phone-card.tsx:124` +2 | One `platformOrigin()` |
| 12 | Dismiss listeners re-register on every App render — i.e. on every SSE push — while a panel is open | `src/dismissable.ts:23` | `useCallback` the two handlers, or hold `onClose` in a ref |

### `packages/aai-templates` — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | Thirteen `ctx.state` references across eight templates, plus a claim that `update` "serializes them per session" | `dispatch-center/shared.ts:165` +12 | See C4 |
| 2 | The one workflow template whose step uses bare `fetch`, plus 43 hand-rolled lines of HTML→text | `link-digest/workflows/digest.ts:116` | `stepFetch` (the rule has no stated exception); `visitWebpage` already *is* fetch-plus-clean-text with screening and caps — note it answers `{ error }`, so adopting it costs the `toStepError` split |
| 3 | `await` on a synchronous slot mutation, in exemplar code | `support-line/tools/answer_question.ts:36` | The only such site in the repo — drift, but in the worked example for "the graph, as one tool" |
| 4 | Eleven tools wrap `slot.update` in an `async execute` that never awaits | `dispatch-center/tools/*.ts` | `updateTool` / `slot.tool` — which *enforces* the synchronous rule rather than relying on it being observed |
| 5 | Six read-only bodies open with `slot.get(ctx)` where `slot.tool` exists | `solo-rpg/tools/check_state.ts:8` +5 | `slot.tool` makes the frozen-vs-draft choice visible at the declaration — precisely the mistake H10/H11 are |
| 6 | The FDA fetch has no timeout and no screening, and `check_drug_interaction` fires `Promise.all` over N of them | `health-assistant/fda.ts:44` | `fetchJson` from `@alexkroman1/aai/tools` |
| 7 | The same four-line generic-inference comment pasted into seven files, with five more carrying the one-line pointer | `retail/tools/*.ts` | Keep it once on `RetailToolSpec.execute`; the inconsistency is the tell |
| 8 | Three clients re-implement the state→colour map (two verbatim, one inline) and the chat shell | `retail/client.tsx:52` +2 | The mapping is a projection of `AgentState`, a union the SDK owns — a state added there is a silent grey badge in three files |
| 9 | `solo-rpg` seeds `useAgentState` from the module default where every sibling derives from the projection | `solo-rpg/client.tsx:774` | `gameSlot.projection(g => g)(undefined)` |
| 10 | The client hardcodes the product name its agent derives from `knowledge.json` | `support-line/client.tsx:104` | `PRODUCT` is already exported and already crosses into the browser |

### `scripts/` + `packages/aai-evals` — quality

| # | Finding | Location | Remedy |
| --- | --- | --- | --- |
| 1 | Two near-identical ratchet engines, ~110 duplicated lines (`git()`, `parseMatch()`, the whole `--update` merge/refuse block, the violations+stale reporting) | `check-escape-hatches.mjs`, `guard-invariants.mjs` | One `_ratchet.mjs` — and C1's missing floor gets fixed once |
| 2 | Three `git()` helpers, three contracts, and only the scanners' copy sets `cwd: REPO_ROOT` — whose doc explains at length the `0 ✓` bug that caused | `check-escape-hatches.mjs:144` +2 | One helper, `cwd: REPO_ROOT` always |
| 3 | `new URL("..", import.meta.url).pathname` as a filesystem path in eleven scripts — percent-encoded, so a checkout path with a space breaks every `join` | `check-claude-md.mjs:43` +10 | `fileURLToPath`, as two scripts already do |
| 4 | "Which packages are publishable" answered four times, with four different error behaviours | `api-report.mjs:109` +3 | One `publishablePackages()` |
| 5 | The published-subpath scan and its slug rule exist twice — and they are coupled by a filename, so a divergence surfaces as "missing report" naming a path nobody typed | `api-report.mjs:127`, `_api-contracts-tree.mjs:217` | Export `typedEntryPoints(manifest)` from `_api-surface.mjs` |
| 6 | `localeCompare` in two generated-artifact sorts, in a repo that bans it by name for exactly this | `api-report.mjs:140`, `gen-gateway-models.mjs:83` | `compareNames`. No divergence today — verified across five locales — hence consistency, not correctness |
| 7 | `pnpm pack` → tmpdir → read-the-manifest written twice, by the only two things that pack | `check-publish-protocols.mjs:73`, `artifact-size-report.mjs:146` | One `withPackedTarball(dir, fn)` |
| 8 | The prose rule catalogue is three rules behind its own code (17, 18, 19 absent), has a missing newline joining rule 10 to rule 11, and the baseline `_description` names 3 of the 6 zero rules. *(The reviewer also claimed the printed count drifts; it does not — `:492` derives it from `ABSOLUTE_RULES.length + LINE_RULES.length` and prints 17, matching `AGENTS.md`.)* | `guard-invariants.mjs:19`, `guard-invariants-baseline.json:2` | Generate the catalogue the way the count already is, from `ABSOLUTE_RULES` + `LINE_RULES` — they carry `id`/`label`/`remedy`. That the one derived line is the one that did not drift is the argument |
| 9 | The `.`/`..` resolution loop written twice in one file, where one copy is already the general form | `guard-invariants-scanners.mjs:284,348` | Rule 13 calls rule 14's resolver |
| 10 | "What ends a reply" declared twice | `aai-evals/assertions.ts:104`, `session-target.ts:53` | A third terminator would make `say()` return mid-reply while the assertions think the turn ended |
| 11 | A module doc contradicting its own code and its own printed caveat, on numbers that decide `DEFAULT_BUILTIN_TOOLS` membership | `scripts/starter-eval/builtins.mjs:20` | Delete the paragraph (the harness it describes was deleted) or make the capture unconditional |
| 12 | `readJson` defined three times with three behaviours, plus ~15 inline `JSON.parse(readFileSync(...))`, split roughly evenly between `"utf8"` and `"utf-8"` | `_api-contracts-tree.mjs:63` +2 | One `readJson` in `_fs.mjs` with the fail-loudly behaviour one copy already has |

## Deliberately not reported

Kept because a checked-and-cleared path is worth as much as a finding.

- **The pipeline turn lifecycle, audio gate, `heard.cut()` latch ordering,
  speculation tape follower loop, and S2S resume/`whileLive`/`endSession`
  paths.** The reviewer could construct no failure the existing fast-check
  harnesses would not already have shrunk.
- **`aai-ui`'s turn-epoch guards, drain-stop turn ids, ring-buffer wrap, refill
  hysteresis and `preInitAudio` replay** — all pinned by the four
  `fuzz-*.test.ts` harnesses and the worklet stress suite.
- **`collectValues` under `<fieldset disabled>`** — the `disabled` IDL attribute
  reflects the element's own attribute, not ancestor disablement.
- **`navigator.clipboard?.writeText(url).then(…)`** — the optional chain
  short-circuits the whole chain.
- **`_base64.ts`'s pooled-`Buffer` views** — every consumer carries
  `byteOffset`/`byteLength` correctly and Node's pool never re-issues a region,
  so there is no cross-session bleed.
- **Deepgram's `Authorization`** — a declared SDK field, not a query param; no
  key in the URL.
- **Rime's lack of a post-cancel audio filter** — covered by the transport's
  `turns.audioGateOpen()`.
- **A failed AssemblyAI-TTS reconnect** — does not leave the session mute; a TTS
  `error` reaches `onProviderError`, which terminates.
- **`generate.ts`'s WeakMap memo** — `normalizeLlm` interns one descriptor per
  model id, so it does not defeat itself on `llm` strings.
- **`aai-studio-client` XSS** — no `dangerouslySetInnerHTML` anywhere;
  `Markdown` is `react-markdown` with no `rehype-raw` and no `urlTransform`
  override, so raw HTML is escaped and `javascript:` hrefs are stripped by the
  default transform. The SSE reader, probe timer and dismiss listeners all clean
  up on unmount.
- **`index.ts`'s `new URL(req.url).pathname`** is correct rather than a
  `requestPath()` miss — `requestPath` takes a request *target*, not a
  `Request.url`.
- **`studio-sse.ts`'s hand-rolled owned map** and
  **`_studio-preview-test-utils.ts`'s inline `setTimeout(0)`** — both recorded
  in `scripts/guard-invariants-baseline.json`.
- **`aai-server`'s 47 direct `console.*` calls** — documented as open work in
  `AGENTS.md`.

## Limitations

- **Test files were excluded** (`*.test.ts`, `*.test-d.ts`), by choice. Several
  findings above are *about* a test — a bridge spec feeding a frame no runtime
  produces, an error spec that never opens a transcript, a template with no spec
  at all — but those surfaced from the source side. A test-tier sweep would be a
  separate pass.
- **`packages/*/contracts/` was skipped** for the reason given above.
- **Nothing was executed.** No suite was run, no reproduction was built. Every
  finding is a code-reading claim with a stated failure scenario; the severities
  are the reviewers' judgement, and the high ones deserve a reproduction before
  a fix is designed.
- **Slice boundaries can hide a finding.** `aai/host` was split alphabetically,
  which is arbitrary with respect to the code — a defect whose two halves
  straddle the a–l/m–z line had no single reader. The C2 duplication was found
  twice for exactly this reason, which is reassuring about the overlap and not a
  guarantee.
- **The counts are capped.** Each reviewer was limited to ~12 correctness and
  ~15 quality findings, so the larger slices are a ranked selection rather than
  an exhaustive list.
