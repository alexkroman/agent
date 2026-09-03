# packages/aai-cli — CLI guide

The `aai` CLI (`@alexkroman1/aai-cli`). Repo-wide conventions live in the root
`CLAUDE.md`; the studio surface the CLI round-trips against is documented in
`packages/aai-studio-server/CLAUDE.md`.

## Commands and exports

Binary: `aai` — subcommands: init, dev, test, eval, build, list, pull,
push, publish, delete, login, secret, logs, workflow, templates.

**That list is PINNED to the registry** (`cli.test.ts`, "the subcommand list in
this package's guide names exactly what `cli.ts` registers"), because it went
stale the moment something was removed: `storage` was deleted in "Remove per-app
databases from the platform" and stayed named here — and in the root
`AGENTS.md` — for every release since, while `cli.test.ts` already asserted its
ABSENCE from the registry. A guide claiming a subcommand that exits 1 is worse
than no list.

**`aai eval` is a separate command from `aai test`, and the split is the
point** (`eval.ts`). A test asserts about the config and calls no model; an eval
drives a real session against a model, so it spends money, takes seconds a
case, and measures a probabilistic system where one red run is a question
rather than a verdict. Folding it into `aai test` would put all three
properties inside the command a project runs on every save and in `aai build`,
and would devalue the reliable half of the verdict. Three mechanics worth
knowing:

- **The two commands are disjoint BY CONSTRUCTION, not by an exclude list.** A
  positional argument to `vitest run` is a substring FILTER over what vitest's
  own include globs already matched, not an include glob — so `agent.test.ts`
  cannot match `agent.eval.test.ts` and vice versa. Neither command needs to
  know the other's file, which is what stops the pair drifting.
- **It passes `--testTimeout`** (`EVAL_TEST_TIMEOUT_MS`, 5 min). Vitest's 5s
  default is shorter than one live model turn, so without it every case fails as
  a timeout and the report says nothing about the agent. The diagnostic worth
  reaching is the harness's own 90s per-turn timeout, which names the events it
  saw; this ceiling only exists so a wedged run ends.
- **It hands the project's `.env` to the child**, resolved by the same
  `resolveServerEnv` the dev server uses (declared keys only, shell wins). That
  is where this CLI puts a key, so without it a developer would watch every case
  skip for want of a credential the agent itself runs fine with.

The harness the eval file is written against is published from
`@alexkroman1/aai-runtime/eval` — including what a run with NO key does, which
is not "skip". See "Driving an agent from text is a published surface" in
`packages/aai-runtime/CLAUDE.md`.

## An INCOMPLETE `aai test` is not a pass

`aai test` runs `agent.test.ts` and nothing else, and that narrow default
STANDS: which files it runs is a documented contract, and widening it by default
would reach specs that are slow or want credentials. What did not stand is the
verdict it printed over the difference. It answered
`{"ok":true,"data":{"passed":true}}` with **exit 0** while naming the files it
had skipped in a warning printed *after* the green summary — so the scaffold's
`"test": "aai test"`, which is what users wire into CI, could report a passing
suite over 211 unrun tests. Measured: one tool added to the `retail` template
broke its `registry.test.ts` in 17 assertions with `pnpm test` and `pnpm build`
green throughout, and one user concatenated a 25-test suite into `agent.test.ts`
to get it gated at all.

It is the same defect `defineExec`'s `cwd` policy exists for — "a green result
for a project that is not there reads, in CI, exactly like a passing suite" —
one directory over, and it gets the same answer. Four parts, and the split
between them is the design:

- **`executeTest` FAILS with `incomplete_run`** when any non-eval spec in the
  project was not covered, naming the files (capped at ten, then counted) and
  the flag that runs them. Both arms fail, including the one that misled longest
  — no `agent.test.ts` at all, where the CLI printed "No test file found" while
  the project's specs sat right there. A warning after a green summary is not a
  gate; an exit code is.
- **The result carries the SET, not just a boolean.** `ran`, `unrun` and
  `complete` ride `TestData`, because `jq -e .data.passed` answered `true` for a
  narrowed run and a complete one alike, so no script could tell them apart.
  `aai eval` reports its `ran` for the same reason.
- **`aai test --all`** is the opt-in: every non-eval spec in one run
  (`TestOptions.all` → `VitestRunOptions.all`, declared as the `test` command's
  one non-`json` arg in `cli.ts`). Still a vitest FILTER LIST rather than an
  include glob, so the eval tier stays disjoint by construction exactly as the
  narrow path is (see above) — nothing had to learn the other command's
  filename. The failure's hint names the project's own `npm test` FIRST and the
  flag second, because the script is the answer that needs nothing remembered.
- **`runVitest` announces the unrun set ITSELF by default**
  (`announceUnrun`, default `true`), which is what finally covers `aai build`.
  That command runs the same narrowed gate as its pre-build check and printed
  "Build complete" with no notice of any kind. The default is on so the caller
  that does not know it is narrowing cannot stay silent; `aai test` and
  `aai eval` pass `false` — the first because its own result and failure report
  the set, the second because "did not run" is a claim about the TEST tier and
  an eval run would otherwise name every unit spec in the project.

**And the scaffold's `test` script is no longer `aai test`.** It is
`vitest run --exclude "**/*.eval.test.*"` (`scaffold/package.json`), with the
narrow command kept as `test:agent`. The command a project wires into CI must be
the one that runs that project's suite — and vitest's CLI `--exclude` is PUSHED
onto `defaultExclude` rather than replacing it (verified in vitest 4.1's own
`resolved.cliExclude` handling), so `node_modules` stays excluded and the one
pattern buys the same test/eval disjointness the CLI gets from its filter. The
scaffold guide already said `pnpm test`; this makes that true.

**`aai workflow` talks to the AGENT, not to the platform API** (`workflow.ts`,
`cli-workflow.ts`): `list`, `runs <name>`, `show <runId>`, `cancel <runId>` over
the brokered `/:slug/workflows` surface. It is deliberately NOT an `apiRequest`
— that surface takes the agent's own bearer (`AAI_WORKFLOW_API_TOKEN`, passed as
`--token`) or none at all, so sending the caller's platform API key there would
be both useless and a leak. Every request BROKERS, so the first one may boot the
agent's sandbox; that is the same trade the studio's runs card makes and worth
knowing before scripting a loop around it. `--limit` is parsed in the command
rather than the executor, so a non-numeric value fails as a CLI error naming the
flag instead of as a query the agent rejects three hops away.

The requests are the SDK's (`createWorkflowApiClient`,
`@alexkroman1/aai/workflow-api`); what stays here is turning "this directory"
into an origin plus a PUBLISHED slug, and printing. One consequence to know
because it is the one place the two ends disagree: `api.get` resolves
`undefined` for a 404 — right for a page racing a run it just started, and
nothing for `show` to print — and that status ALSO covers "this agent serves no
workflow API", so the failure sentence claims neither cause and the shared
`HINT_BROKER` names all three.

**`aai logs` reads a RING, which is why `--follow` polls** (`logs.ts` →
`GET /:slug/logs`). The source is the guest's own bounded buffer with a cursor
(see `packages/aai-guest/CLAUDE.md`), so a stream would have to re-derive that
cursor on every reconnect; the follow loop passes back the page's own. Three
things it has to be honest about, because none is visible in a wall of lines:
the ring **dies with the sandbox** (a one-shot read says so), `running` is
**not** `lines.length` (up-and-quiet and not-running both print nothing and want
opposite things from the reader), and a `dropped` count is printed rather than
swallowed. A failed poll under `--follow` is not a failed command — an agent
between sandboxes answers exactly like a network blip, and the next tick is a
second away — so only a signalled stop ends the loop. The `--json` result
reports the LINE COUNT, not the lines: a follow has no final set, and a one-shot
would duplicate what it just printed.

**Self-hosting is the DEFAULT, and there is no command for it.** The scaffold
ships `server.mjs` plus a `prestart`/`start` pair, so every project
`aai init`/`aai pull` produces already runs with `npm start` — no platform
account, nothing managed (see `packages/aai-templates/CLAUDE.md`). There used to
be an `aai eject` that back-filled those two files into projects predating the
scaffold; it is gone, because `layerScaffold()` copies them into every `init`
AND every `pull`, so no project this CLI produces can be missing them.

**`aai build` LEAVES its worker on disk** (`.aai/worker.mjs`, beside the built
client), and that is what `npm start` boots — so the CLI is a build-time
dependency of self-hosting rather than absent from it, which the paragraph above
used to claim outright. The reason is tool discovery: `worker-bundler.ts`
enumerates `tools/` and emits the imports, so a loader that reads `agent.ts`
directly serves an agent with none of its tools and nothing reports it. That is
why the scaffold declares `prestart` beside `start`: `scaffold/package.json` is
the single definition of both, so there is no second copy to pin against.

**`bin.mjs` is the bin in BOTH layouts** — the source checkout (where it loads
`cli.ts`) and the published tarball (where only `dist/` ships, so it loads
`dist/cli.mjs`); there is no `publishConfig.bin` override any more. One wrapper
for both is what makes `module.enableCompileCache()` reachable: the cache only
covers modules compiled AFTER the call, and every CLI dependency is external
(`deps.neverBundle`), so `dist/cli.mjs` carries hoisted imports for citty,
execa and the rest — all evaluated before any statement inside it. A banner, or
a first line in `cli.ts`, would cache nothing that costs anything; loading the
entry through a DYNAMIC import from a wrapper is the only ordering that puts
the enable genuinely first. Source wins when both are present, so a built
checkout under `pnpm link --global` still runs the working tree.

**`aai test` sets no `NODE_OPTIONS`.** It used to force
`--experimental-strip-types`, which is redundant on every Node the CLI supports
(`>=24`; stripping is default-on since 23.6, and in Node 26 the flag survives
only as an alias for `--strip-types`). Not free, either: `NODE_OPTIONS`
propagates into every vitest worker, so a value that ever stopped being
accepted would fail the whole run rather than degrade.

**There is no user-facing deploy.** Source always flows through the studio
workspace and production always comes from Publish: `aai push` replaces the
linked project's workspace file map atomically
(`PUT /studio/projects/:project/source`, fast-forward-checked against the
`studioSourceHash` recorded in `.aai/project.json` — a 409 means the studio
edited since the last pull; `--force` overwrites), `aai publish` pushes then
runs the studio's Publish route (the in-sandbox `aai deploy`), syncing
`.env` into the agent's secrets via the standard secret routes (before the
deploy when the slug already exists, after it on a first publish), and
`aai pull <project>` materializes a workspace locally, layering the shipped
scaffold underneath (never overwriting workspace files) so the result runs
under `aai dev`. **package.json is MERGED rather than skipped**
(`mergeScaffoldManifest` in `aai-cli/_templates.ts`): the scaffold fills in
top-level fields the pulled manifest lacks, and for `dependencies` /
`devDependencies` / `scripts` it fills in per ENTRY. Skip-if-exists was wrong
here because a studio workspace's manifest declares its runtime deps and NO
toolchain — correct in the guest, where the toolchain is baked (see
`ensureProjectShape`), and fatal on a laptop, where `pnpm install` then
fetched no `vite`, `@vitejs/plugin-react`, or `@tailwindcss/vite` and
`aai dev` died resolving the vite.config.ts the same layering had just
written. Per-entry matters both ways: the workspace's exact pins survive the
scaffold's carets, and one agent-added devDependency can't shadow the whole
toolchain block. `aai delete` in a linked directory deletes the STUDIO
PROJECT (`DELETE /studio/projects/:project`), which cascades server-side to
the workspace, chat, and the project's deployed + preview agents — and
CLEARS the link fields from `.aai/project.json`, keeping `serverUrl`. Left
behind, they sent the next push a `baseHash` for a project that no longer
existed: a 409 whose hint said to run `aai pull`, which then failed with
"No studio project named …", so only `--force` recovered. The
hidden `deploy` subcommand remains only because the guest's Publish
(`aai-guest/studio-publish.ts`) executes it; a bare `aai` in a project
offers to publish, and `aai init` publishes after scaffolding.

**A pull that finds nothing PRINTS THE PROJECT LIST.** "No studio project
named X" has two causes and the list is the only thing that separates them: a
typo has the user's other projects beside it, while an EMPTY list means this
login is scoped to a different account than the studio the project lives in
(studio scope follows the account that owns the API key — see
`packages/aai-server/CLAUDE.md`), so the hint says so and points back at
`aai login`. The extra request is on an already-failing path and its own
failure must never replace the 404, so it degrades to the old "run `aai list`"
hint.

**A workspace carries UTF-8 text only.** Both snapshots — the CLI's
`collectSourceFiles` and the guest's `snapshotWorkspace` — decode with
`TextDecoder({ fatal: true, ignoreBOM: true })` and SKIP a file that isn't
valid UTF-8, warning by name, exactly as the byte cap does. The file map is
JSON, so a lossy `"utf-8"` read turned a pushed PNG into U+FFFD while
reporting success, and a later `aai pull` wrote the mangled bytes back over
the local original. `ignoreBOM` is load-bearing: the decoder strips a leading
BOM by default, so the check meant to stop corruption would introduce a
smaller version of it. Skipped files also ride the JSON result as `warnings`,
because `log.warn` is silenced in JSON mode and JSON mode is auto-detected on
a pipe — a scripted push otherwise reported plain success while having
replaced the workspace with a truncated tree.

**Every leaf command is a `defineExec({ cwd, args, meta, run })`**
(`_cli-common.ts`), and the `cwd` field is the reason the wrapper exists. All
twenty-four command bodies were the same four lines written longhand — `async
run({ args })`, `runCommand(args, async (mode) => …)`, a cwd resolution, a lazy
`await import` — and in the middle of that boilerplate each one DECIDED its
working-directory policy, which is the one part that is not boilerplate and the
part that has been wrong in production: `aai test` shipped calling `setup()`
bare instead of `setup({ agent: true })`, so in a directory with no `agent.ts`
it found no test file, reported `{ passed: true, skipped: true }` and exited 0
— indistinguishable in CI from a passing suite. The policy is now a required
field with three values: `"agent"` (refuses a directory with no `agent.ts`),
`"any"` (the working directory, whatever is in it), `"none"` (no policy — the
body gets `cwd: undefined`, typed, so it cannot read one it never asked for).
Forgetting is unrepresentable; the alternative spelling is a policy name that
does not exist. The lazy `await import` of the executor stays in each body —
that is what keeps a subcommand's dependencies off every other invocation's
startup path. Group commands (`secret`, `workflow`) are plain
citty `defineCommand`s: meta plus subcommands, no body and so no policy.

**A returned `fail(...)` and a thrown error converge on ONE emitter, and the
emitter branches on the RESULT rather than on which arm produced it.** For a
long time only `runCommand`'s `catch` printed anything, so a body that RETURNED
a failure fell straight through to the JSON check and `process.exit(1)`: in
human mode, exit 1 with an empty terminal. Nine paths (one has since gone with
the `storage` command) — `aai test` with no runner binary on PATH (message *and*
hint discarded), all four `aai workflow` verbs against a booting sandbox (the
agent's own sentence plus `HINT_BROKER`), `aai secret put` with an empty value —
were silent, while the module's own doc comment asserted the opposite. Keep new
emission keyed on `result.ok`, never on the code path.

**A 2xx body is CHECKED, not cast** (`checkedResponse`, `_api-client.ts`).
`apiRequest<T>` is a cast and nothing verifies it, so a 200 from something that
is not our server — an intercepting proxy, a captive portal, a mismatched or
half-deployed backend — flows on as a fully-typed object whose fields are
`undefined`. The incident: a deploy response without `slug` printed `Deployed
https://server/undefined` and wrote `slug: undefined` into `.aai/project.json`,
where `JSON.stringify` DROPS it — so the next deploy saw no slug, minted a fresh
one, and orphaned the running agent. `aai publish` grew a hand-written guard for
exactly that and the other four response shapes did not; they all go through the
one helper now (deploy, the studio project list, storage, the secret list). The
predicate is the caller's, because the shape is; the helper owns only the
failure, whose code (`bad_response`) and hint are the same wherever it fires.

**A LONG-RUNNING command's diagnostics go through `notify` (`_ui.ts`), not
`log`.** `silenceOutput()` no-ops every `log` method so JSON mode's contract —
exactly one result line on stdout — holds. That is right for a
request/response command and wrong for `aai dev`, which writes its JSON line at
startup and then keeps running: every later message was silenced for the rest of
the process, including "Restart failed: … (previous server still running)", the
watcher's ENOSPC/EMFILE error, and the `unhandledRejection`/`uncaughtException`
handlers whose entire purpose is diagnostics. Since JSON mode is AUTO-DETECTED
on a pipe, that is the NORMAL case — `aai dev > dev.log`, a process supervisor,
a container — so a syntax error left the previous agent being served with
nothing anywhere saying why edits had stopped taking effect (verified: stderr
empty, stdout one line, old version still served). `notify` keeps the styled
clack output in human mode and writes a plain line to STDERR once silenced, so
the stdout contract survives while a human tailing the log still sees the
failure. Any new post-startup output in a long-running command owes the same
treatment — `resolveAgentEnv`'s three credential warnings ("missing provider
credential", "resolved from your shell, not .env", "missing requiredEnv key")
were the ones that had not been converted, so under `aai dev > dev.log` the
first session failed auth with nothing anywhere saying why.

**And the contract binds every failure path, including the ones that run
BEFORE citty parses.** `usageForMode` (cli.ts) exists because citty writes its
usage block to stdout from the same `catch` that reports a missing positional —
but `assertKnownFlags`, ten lines below it, was written without that wrapper and
reported a typo'd flag through clack: `aai push --json --serverr=http://x`
emitted a human error block on stdout, nothing on stderr, and no JSON at all.
That is the same break the wrapper was written for, in the sibling function, on
the one path whose whole purpose is to stop a typo silently retargeting
`--server`. Both live in the pre-parse `runDefault().then(assertKnownFlags)`
chain, so neither can lean on `defineExec`'s mode plumbing; a new guard added
there owes an explicit `getOutputMode({})` branch. `cli.test.ts` covers it by
running the real bin with stdout PIPED, which is what puts it in JSON mode —
calling the command bodies cannot reach the auto-detection.

**A dev-mode `aai init` must link EVERY workspace package the scaffold names,
and the list is derived, not written down.** `WORKSPACE_PKG_DIRS` in `_init.ts`
rewrites the scaffold's published ranges to `link:` paths; it named `aai`,
`aai-ui` and `aai-cli`, and stayed that way when `aai-runtime` was split into
its own published package. So the one dependency `aai init` did not link came
from the real npm registry — a hard `ERR_PNPM_FETCH_404` before that package's
first release (dependencies never installed, `aai build` then failing to
resolve `@alexkroman1/aai-runtime` from the generated worker entry), and a stale
published copy after it, in a project whose entire point is running against the
working tree. The spec agreed with the bug because it hand-listed the same three
names, so the regression test in `init.test.ts` DERIVES the expected set from
`scaffold/package.json` — every `@alexkroman1/*` it declares must come back a
`link:`, with a floor so an empty read cannot pass. Nothing else covered it:
`e2e.test.ts` publishes all four packages to its mock verdaccio, so the
registry path it exercises has an `aai-runtime` to find.

**`aai dev`'s restart state machine lives in `_dev-restart.ts`, behind
injected `build`/`listen`/`close` operations.** It is the subtlest part of the
watch loop — an edit saved mid-boot must QUEUE rather than race the initial
build, a change during an in-flight restart must loop once more with the
newest files, a failed build must leave the old server serving, the new server
must be built BEFORE the old one closes (the down-window is the swap, not the
rebuild), a lost port race must retry, and teardown must be idempotent and win
against a rebuild in flight. None of that touches chokidar, Vite, or the
bundler, but while it was inlined in `startDevServer` the only way to reach it
was through nine module mocks plus a REAL bundler build and the watcher's 300ms
debounce per assertion — which is why those specs carried 15s `vi.waitFor`
ceilings, and why four of the races above had no test at all. Keep new
restart/teardown logic in `_dev-restart.ts` and spec it there
(`_dev-restart.test.ts`, no mocks); `_dev-server-restart.test.ts` is for
WIRING only — that a chokidar event reaches the supervisor and that teardown
closes the watcher with the server.

**The "at most one rebuild, one trailing re-run" half is
`createCoalescingRunner`, not a local flag pump.** It had been re-derived here
as a `restarting` flag, a `pendingRestart` flag and a `do/while`; coalescing is
right for the same reason it is right in the SDK (a rebuild reads the files as
they are WHEN IT RUNS, so N queued rebuilds do the trailing one's work N times).
What is genuinely local is the BOOT window — a change saved during the initial
build has no in-flight promise to coalesce against, so it is a separate flag
released by `adopt`, and `restartOnce` returns early once `closed` so a trailing
rebuild queued before teardown does not build after it.

One rule the split made visible and is worth keeping: **reporting success sits
outside the `listen` try/catch.** Inside it, a notifier that throws — stderr
closed by `aai dev | head` — was reported as a failed listen and tore down a
server that had already bound. Logging must not be able to take the dev server
down.

**`viteDevConfig`'s proxy table is the whole agent API as the BROWSER can see
it under `aai dev`** — with a `client.tsx`, Vite owns the port the user is told
to open and answers everything not in that table itself, with a bare 404
carrying none of the agent server's headers. So the failure reads as a missing
route, not a missing proxy entry, and it is invisible to every test that talks
to the backend port directly. **A route added to `createServer` that a page
fetches must be added there too.**

`/workflows` is the case that proves the rule and the one it was learned from.
A WORKFLOW APP (`workflowApp()`, i.e. `page: "static"`) has no session and no
socket:
`page()` renders a form and every single thing it does — listing workflows to
build that form, starting a run, polling it, streaming its events — is a
same-origin fetch under that prefix. Unproxied, both workflow-app templates
were dead on arrival under `aai dev` (`404 POST /workflows/runs` the instant
the form is submitted) while the backend served the whole API correctly one
port over. A string key prefix-matches, so the one entry covers `/runs`,
`/runs/:id` and the `/runs/:id/events` SSE stream. The
`/.well-known/workflow/v1/*` routes deliberately stay out: the queue delivery
door is dialled by the platform and the webhook by a third party, never by a
browser, which is the same `guest-internal` distinction
`aai-server/guest-routes.ts` draws. That is also why `aai dev` hands
`createRuntime` the BACKEND origin as its `publicUrl` — a webhook URL naming
the Vite port would 404 on delivery.

**There is no second workflow bundle any more.** The Workflow DevKit's builder
produced a `workflowCode`/`stepCode` pair off the `"use workflow"` / `"use step"`
directives, and `workflow-bundler.ts` existed to build it, patch it and police
it: a prepended `createRequire` shim so a step reaching a CJS dependency did not
die on `Dynamic require of "node:assert" is not supported`, an
`assertNoVmRequires` scan because the flow half was compiled in a `node:vm`
`Script` with no `require` in its context, and a `findReplayUnsafeCalls` warning
over the flow artifact. All three are gone with the pair. The replay engine runs
a body as ordinary code in the worker bundle, so there is no `node:vm` context to
lack a `require`, no separate artifact to attribute a line to, and no builder to
mark a builtin external behind either.

**What survives the removal is the asymmetry that hid both bugs**, which is worth
carrying into whatever replaces them: a bundling failure of this shape does NOT
reproduce in-tree. `@dev/source` resolves the SDK to TypeScript, pnpm links the
workspace and esbuild resolves realpaths — so the module graph, and which CJS
modules initialize eagerly, differ from an installed `@alexkroman1/aai`. Every
gate short of `check:e2e` was green for both. Assert the checkable half (an
ordering, a shape) rather than the throw.

**Both Vite entry points dedupe React** (`DEDUPED_PEERS`, `_vite-env.ts`) and
the two symptoms look nothing alike, which is why the dev half was missing for
so long. `buildClient`'s is a publish that dies with *"Rolldown failed to
resolve import react/jsx-runtime"*; `viteDevConfig`'s is a project whose SDK is
LINKED rather than installed — `aai init` run inside this monorepo, i.e. how a
template gets tested by hand — loading two physically distinct copies of the
same React version, so every hook throws *"Invalid hook call"*, `ThemeProvider`
unmounts, and the agent renders a BLANK PAGE naming no package. An
npm-installed project is correct either way, which is exactly what kept it
hidden.

**A `*-preview` project name is refused** (`projectNameFromDir` returns
null). Publishing deploys under the project's own name, so such a project
would claim a slug the orphan-preview sweep reaps hourly — taking the agent,
its app-database schema, and its secrets with it. See the `-preview` note in
`packages/aai-server/CLAUDE.md` for the matching deploy-boundary rule.

**The directory name is normalized by the PLATFORM's slugifier**
(`slugifyName`, `@alexkroman1/aai/slugify`), not a local regex. It was a local
`[^a-z0-9-_]` strip for a long time because the studio's copy lived in the
private `aai-server`, which the CLI may not import — and the two disagreed on
exactly the names people give agents: `Café Ordering/` pushed as
`caf-ordering` while typing the same name into the studio produced
`cafe-ordering`, so one human name made two projects depending on which path
created it. The visible change from adopting it is that `_` now collapses to
`-` (`my_agent/` → `my-agent`); the slug GRAMMAR still permits `_`, so a slug
the user requests outright is unaffected.

## Key files

- `cli.ts` — arg parsing, subcommand dispatch
- `_cli-common.ts` — shared citty plumbing (`sharedArgs`, `setup`,
  `runCommand`); `_studio-commands.ts` — the list/pull/push/publish command
  definitions
- `init.ts` / `dev.ts` / `test.ts` / `deploy.ts` (internal) / `delete.ts` /
  `secret.ts` — subcommand entry points
- `studio.ts` / `_studio.ts` — the studio round-trip: pull/push/publish
  executors over the `/studio/projects` routes, the local source walk
  (the walk, caps, skip rules and strict UTF-8 decode all come from
  `@alexkroman1/aai/workspace-files`, shared with the guest's end-of-turn
  sync; lockfiles never sync in EITHER direction, and `.env` is the one rule
  this side still adds — the guest keeps `.env` visible because the coding
  agent may have written it)
- `_init.ts` / `_deploy.ts` / `_delete.ts` / `_bundler.ts` — internal logic
- `_dev-server.ts` — dev server for directory-based agents: loads `agent.ts`,
  builds runtime, watches for file changes, optionally runs Vite for client HMR
- `_dev-vite-config.ts` — `viteDevConfig`, the proxy table that IS the agent API
  as the browser can see it under `aai dev` (see below). Its own module because
  it is worth reading without the watcher/restart/env plumbing around it, and
  because that plumbing had pushed `_dev-server.ts` past the length cap
- `_dev-restart.ts` — the watch loop's restart state machine (see below)
- `_bundler.ts` — bundles `agent.ts` (and optional `client.tsx`) into
  deployable artifacts
- `_api-client.ts` — platform API client (`apiRequest`, `apiRequestOrThrow`)
- `_config.ts` — auth config, project config, API key management;
  `project-config.ts` re-exports its two WRITERS (`writeConfigHome`,
  `updateProjectConfig`) as a public subpath. That exists for the studio
  guest, which materializes a workspace into a real project and spawns this
  CLI against it (`aai-guest/studio-publish.ts`) — it hand-wrote both files
  with `JSON.stringify`, so the shapes matched the schemas the CLI parses
  them back with by coincidence, and neither of the properties that matter is
  visible in the JSON: the config home is 0600 via atomic rename (an older
  world-readable file is TIGHTENED, not left), and the project pin is MERGED
  (`.aai/project.json` also carries the studio link fields). Keep it a thin
  re-export — the point is one writer per format, not a nicer one
- `_agent.ts` — agent discovery, dev mode detection, server URL resolution
- `_utils.ts` — shared utilities (`resolveCwd`, `fileExists`)
- `_server-common.ts` — shared server utilities
- `_templates.ts` — template handling
- `_ui.ts` — CLI output helpers (`log`, `fmtUrl`, `parsePort`)

## Fault mode: a suite run against a server that keeps dying

`AAI_FAULT_PROFILE=<name>` makes every test that boots its server through
`startSupervisedDevServer` (`_fault-mode.ts`) run against an `aai dev` child that
is **SIGKILLed and restarted** at declared points. Unset, the helper is the plain
spawn it replaced, so the normal suite is unchanged.

```sh
AAI_FAULT_PROFILE=restart-on-boot pnpm test:e2e     # the whole suite, under faults
node --run test:integration                          # unaffected without the var
```

Five things about it are load-bearing.

**The kill is a SIGKILL, and nothing else would do.** A graceful stop lets
graphile-worker's runner release the queue locks it holds — which is precisely
the difference that decides whether an in-flight step is ever redelivered. So a
fault mode built on SIGTERM would exercise the recovery path that already works
and never the one that does not. (Measured: one hard kill of the process, or of
its Postgres, strands every locked step permanently — nothing reclaims a lock by
age — with the run sitting `running` forever.)

**There is no seed and no PRNG, deliberately.** "Consistent" is the requirement,
and the cheapest way to be consistent is to have nothing to reproduce: a profile
is an ordered list of points keyed on logical events, so the Nth kill lands after
the same observed event on every machine at every speed. Wall-clock kills are
what `tmp/transcribe-load/chaos.mjs` does and why its runs cannot be compared.
Randomized exploration is a different job for a different tool — this repo drives
every randomized suite with fast-check so nobody hand-rolls a seventh PRNG, and
a seed here would be that seventh.

**A profile that matches nothing FAILS LOUDLY.** `awaitSettled()` throws naming
the points that never fired plus the last lines the server wrote, and `stop()`
warns when a profile injected zero. Without that, a renamed log line turns the
whole mode into a no-op and the suite passes "under faults" having injected none
— the failure this repo keeps paying for, a gate reporting success while checking
nothing.

**`afterHealthy` exists because a log trigger cannot reach the boot.** `aai dev`
announces itself with `log.success`, which JSON mode SILENCES — and JSON mode is
what the e2e suite runs and what a pipe auto-selects. The first boot profile was
keyed on a startup line, matched nothing, and was caught by the paragraph above
on its first real run. Workflow lines are unaffected: the agent server's logger
writes straight to stderr rather than through `log`, so `"Workflow run started"`
survives JSON mode and is a fine trigger.

**Assert from `awaitSettled()`, not from the boot.** It resolves once every
declared kill has happened AND the survivor answers `/health`, which is the only
moment "the faults are done and the server is back" is true; a request issued
before it races a restart window. `assertPlanConsumed()` is the stricter version,
for a test whose SUBJECT is the profile — a test merely running under one should
not fail because a step-level trigger never fired in a test that runs no
workflow. That is also why `restart-on-boot` is the profile to run a whole suite
under: every supervised server boots, so its triggers reach every test.

`AAI_FAULT_PROFILE` is declared in the `check:e2e` and `check:integration` `env`
in `turbo.json`, for both halves of the documented strict-env-mode rule: an
undeclared variable is stripped before the task starts (so the command above
would run with no faults and say nothing), and a fault run must not share a cache
entry with a clean one — or the first green clean run serves a FULL TURBO for
every later fault run and the mode tests nothing.

It is **not wired into CI** yet, and the reason is a real finding rather than
caution. An in-flight step is never redelivered after its process (or its
Postgres) is hard-killed: the queue job keeps `locked_by` a worker that is gone,
graphile-worker's `get_job` selects on `is_available = true`, and the run sits
`running` for good: `is_available` is a generated column over `locked_at` with no
time term, so nothing reclaims it. So a profile that kills DURING a run is red
today for a reason this mode surfaced rather than caused, and a
required check would be red with it. `restart-on-boot` is the one that is green,
because it kills between runs.

What CI runs is `_fault-mode.scenario.test.ts` — the supervisor's own spec,
driven against a fake server (including one that prints nothing at all), because
a mode whose whole job is to inject faults has to be shown to inject them.

### The other fault mode lives in `aai`, and faults a SOCKET

`packages/aai/src/host/_fault-socket.ts` is the sibling of this one: a TCP
proxy that SEVERS live connections, for testing that a session continues
across a disconnect. It sits in `aai` rather than here because what it faults —
`createServer`, the WebSocket upgrade, session resume — lives there.

Three things separate the two, and picking the wrong one measures nothing:

- **This mode kills a PROCESS; that one cuts a CONNECTION.** They are not
  degrees of the same fault. A workflow survives a process restart because its
  state is in Postgres; a voice session survives only PARTLY, and the split is
  worth knowing before choosing a mode. Its slot state is durable when the app
  has a database (`aai/host/session-state-store.ts`), so a reconnect recovers the
  cart — but the session and sink maps are still plain `Map`s in `runtime.ts` and
  the transport holds live provider sockets, a turn machine and an audio pacer,
  none of which has a representation to store. So a socket drop remains the only
  disconnect a SESSION is advertised to survive; what a restart now preserves is
  the state, not the call.
- **It severs rather than closing.** `destroy()`, never a close frame: a clean
  close is the "user hung up" case aai-ui deliberately does NOT reconnect from,
  so a test built on `ws.close()` proves the opposite of what it looks like.
  `session-resume.scenario.test.ts` asserts the client observes **1006** for
  exactly that reason.
- **It is a proxy for the same reason this one is a supervisor.** The sockets are
  server-side, so the obvious shape is an env-gated `ws.close()` inside
  `createServer` — a fault injector in production code, able to fire in
  production. A proxy in front is test-only by construction.

## Bundling rules

- **Nothing scans a workflow body for a replay-unsafe call, and that is a real
  gap rather than a decision.** `findReplayUnsafeCalls` warned per file about
  `Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()` and
  `fetch(` — and could only do so because the DevKit's builder emitted a
  SEPARATE flow bundle with every `"use step"` body already removed, carrying
  esbuild's per-module `// <path>` headers to charge each line to the file it
  was written in. Without that split the same scan reports zod's own
  `Date.now()` and blocks a correct project. The replay engine emits no such
  artifact, so the warning went with it. The hazard did not: a body that reads
  the clock still answers differently on every resume, and nothing anywhere says
  so. A replacement has to work off the SOURCE of a `workflows/*.ts` module,
  outside every `ctx.step(…)` callback, and stay a warning for the case
  attribution cannot settle (a plain helper only a step ever calls is legal and
  looks identical).
- **Vite must not be allowed to mutate `process.env`.** Vite's `build()`
  sets `NODE_ENV=production` when it is unset — a permanent, global side
  effect on the calling process. Both CLI bundlers therefore wrap the
  build in `withPreservedNodeEnv` (`aai-cli/_vite-env.ts`), which
  snapshots and restores it. Without that, `aai dev`, which rebuilds on
  every file change, flips itself to "production" on the first rebuild.
  Keep any new Vite invocation inside that wrapper.
- **Builds and deploys are TYPE-CHECKED.** `aai build` and `aai deploy`
  run the project's own `tsc --noEmit` (`aai-cli/typecheck.ts`, gated on a
  `tsconfig.json`, `--skipTypecheck` opts out), and the guest's
  `test_agent` build does the same before bundling — the bundlers strip
  types unchecked, which is exactly how the `send`/`state`
  runtime-working-but-wrong bugs shipped. Type errors reach the studio's
  coding agent as build/deploy output it can act on. The dev watch loop
  deliberately does NOT typecheck (editor/CI feedback is faster there).

  **It passes `--singleThreaded`, which is a SPEEDUP, not a throttle.** TS 7
  parallelizes parse/check/emit by default — worth it on a repo-sized program,
  a net cost on the single agent project this function always checks. Measured
  on the templates project (the closest in-repo analogue of a studio
  workspace): **pinned to 1 core, 2.4–2.9s parallel vs 1.2–1.4s single**; on 4
  cores, 1.21s vs 1.01s. The 1-core figure is the one that matters, because a
  guest RESERVES one CPU and this same check runs after every settled write
  burst in the studio, where the design rests on it finishing in well under a
  second — parallelism inside a one-core reservation is oversubscription.
  Gated on the resolved compiler's major >= 7: an unknown compiler option is a
  HARD error (TS5023), so a project pinning an older TypeScript must degrade,
  not fail on a flag it never asked for.
- **`buildClient` runs with no `client.tsx` → `{}`** → the agent gets the
  default UI.
- **`buildClient` dedupes React** (`resolve.dedupe`), because `aai-ui`
  declares it as a *peer* dependency while the bundler resolves the bare
  `react/jsx-runtime` inside `aai-ui/dist/**` from *that file's* real path.
  Locally aai-ui's own devDependency satisfies it; a pruned production
  install can leave the build root's walk-up copy as the only React —
  reachable from the workspace root but not from `packages/aai-ui/dist`.
  Publishing died with *"Rolldown failed to resolve import
  react/jsx-runtime"* while every local build passed.
  `aai-cli/client-bundler.test.ts` guards this (every non-optional aai-ui
  peer is deduped). The Modal image installs the full workspace (dev deps
  included), so the old pruned-image packaging tests are gone with the
  Dockerfile.

## CLI credential destinations (`aai-cli/_agent.ts`)

`.aai/project.json` is in the working tree, so a cloned repo controls its
`serverUrl` — and `aai deploy` / `aai secret` pair that URL with the user's API
key and secret values. `resolveServerUrl` therefore honors a config-supplied
origin only when it is the shipped default or already in `approvedServers` in
the user-owned global config. Loopback origins are deliberately NOT implicitly
trusted from config — a repo-supplied `http://localhost:<port>` would hand the
key to whatever is listening on that local port (dev mode targets its own
default server before the project config is consulted, so `aai dev` workflows
are unaffected). Passing `--server` is what approves an origin (it is user
intent, not repo content) and is remembered for later commands. Never widen
this to trust `serverUrl` directly.

**`aai secret` follows the project when the directory is linked**
(`secretRequest` in `_slug-api.ts`): a studio project deploys a preview agent
as well as a production one, so a secret set against the deployed slug alone
left the preview — one this CLI's own `aai publish` created — failing at its
first session. A linked directory therefore targets
`/studio/projects/:project/secret`, which fans out server-side; an unlinked
one keeps the per-slug route, which is the platform primitive. `aai publish`'s
`.env` sync does the same.

The `slug` from the same file is validated against the platform's slug shape
(`VALID_SLUG_RE`, shared with aai-server via `@alexkroman1/aai/utils` —
`sdk/slug.ts` is the single definition) before it is ever
interpolated into a URL path, so a hostile `"slug": "x/../admin"` cannot steer
a credentialed request; `aai secret delete` also URL-encodes the secret name.
**That check lives in `resolveDeployTarget`** — the one point where
repo-controlled config becomes a credentialed target — so every command
inherits it. It used to live in `getServerInfo` only, which covered
secret/storage/delete but NOT `publish`, whose `syncEnvSecrets` PUTs the whole
`.env` to `${serverUrl}/${slug}/secret`; one guard in two places, with the
copy missing from the command users actually run.

The API key itself is stored 0600 in the global `config.json`
(`AAI_CONFIG_DIR` overrides the config dir location).
**`ensureApiKey` has exactly ONE source: the key `aai login` saved.** Neither a
"paste a key" prompt nor an `ASSEMBLYAI_API_KEY` env var authenticates the CLI.
Both produced the same thing — a CLI that could push, publish, and read/write
another account's secrets while linked to no account the user could see in the
studio, and an `aai login` that was optional in practice. The env var was the
worse of the two: it applies to every invocation in a shell, it PERSISTED
itself into the global config on first use (so the CLI stayed authenticated as
that key long after the export was gone), and it collides with what the same
name means in a project `.env`, where it is a *provider* credential for the dev
server rather than a platform identity. The prompt was separately the riskier
code path: a hidden password prompt reads stdin, so a piped invocation could
have its input eaten and persisted as the API key. Unauthenticated commands
fail with `not_logged_in` pointing at `aai login`; non-interactive callers (CI,
scripts, the eval harnesses) point `AAI_CONFIG_DIR` at a config dir holding a
logged-in key, which is what `aaiEnv()` seeds for the e2e suite's spawned CLIs.

**Every global-config update goes through `updateGlobalConfig`, which holds a
cross-process lock.** `writeJson` makes each write atomic (temp file + rename),
so no reader sees a torn file — but the read→modify→write SPAN is not atomic and
every writer replaces the whole document, so concurrent invocations lose each
other's updates. Measured: 8 parallel commands each approving a distinct origin
recorded only 5, and a concurrent `approveServer` straddling the final write of
`aai login` DISCARDS THE API KEY — the login prints "your API key is saved" and
the next command says `not_logged_in`. The window is wide open in practice,
because `aai login` polls for up to five minutes while the user approves in the
browser, so anything else run in that time can be mid-update when the key lands.
The lock is a `wx` exclusive-create lockfile with three deliberate properties:
acquisition is **bounded** (on timeout the update proceeds UNLOCKED rather than
throwing — failing a login on a stuck lockfile is worse than the lost update),
a **stale** lock is broken (a process killed mid-update must not send every later
write down the unlocked path forever), and it must **never nest** (re-entry
self-deadlocks until the timeout; `executeLogin` calls `approveServer` and the
key update in sequence, not nested).

Bounded had one hole worth remembering, because it is what the second property
costs: **breaking a stale lock can FAIL, and the outcome is what decides whether
looping is progress.** `fs.rm`'s `force` masks only ENOENT and there is no
`recursive`, so an entry that is not an ordinary file — a `config.lock`
DIRECTORY, an immutable or permission-denied file — throws every time; the throw
was swallowed and `continue` restarted the loop ABOVE the deadline check, so
`aai login` (and every `--server` invocation) spun in a tight async loop with no
output and no exit. An unbreakable lock now falls through to the unlocked path
like any other unusable one. `.aai/project.json` deliberately keeps the
last-write-wins behaviour — it is per-directory, not shared across every command
and terminal.

**`aai dev` is the one command a shell-exported key still reaches, and only as
a provider credential.** `resolveAgentEnv` (`_dev-server.ts`) falls back to the
login key only when NEITHER `.env` nor the shell carries one — otherwise
exporting the key the usual way would hard-fail with `not_logged_in`. The
exported value deliberately never enters `ctx.env`: it reaches the resolvers
through `withHostCredentialFallback` (the same documented ergonomic every other
provider key gets), and `agentEnvWarnings` flags it as shell-only so the "works
here, dead after deploy" case stays visible.

**Tests must never resolve the real config dir.** `getConfigDir()` returns a
per-process temp dir whenever `VITEST` is set (unless `AAI_CONFIG_DIR` says
otherwise), and `aaiEnv()` sets `AAI_CONFIG_DIR` for the CLIs the e2e suite
spawns. The guard is in the code path, not a vitest setup file, because
setup files are per-config and any config can omit one — `vitest.slow.config.ts`
(integration + e2e) declared none, so `_test-setup.ts` never ran for those
suites and real configs accumulated ~100 approved loopback origins plus
`https://override.com`. That matters because `approvedServers` is the trust
anchor for a repo-supplied `serverUrl`: a pre-approved loopback origin lets a
cloned repo's `.aai/project.json` collect the developer's API key and secret
values with no prompt, which is exactly what the loopback tightening above
removed. Spawned CLI children run with `VITEST` cleared (or the CLI skips
`main()`), so both halves are needed.

Note that `aai build`, `aai dev`, and `aai deploy` all evaluate the
repository's bundled `agent.ts` in the host process (`evalWorkerBundle` /
`evalWorkerConfig`, via a temp-file import) — running any of them against an
untrusted clone executes that repo's code locally. A bare `aai` in a project
still asks for confirmation on a TTY before implicitly deploying.

**`aai deploy` evaluates deliberately, and it is a smaller delta than it
sounds.** It used to upload without importing, because the platform extracted
the config guest-side; that extraction is gone (see "The platform stores no
agent config" in `packages/aai-server/CLAUDE.md`), so the CLI is now the only
place that can read `__aaiConfig` — which it needs for the credential
preflight (`_preflight.ts`), and whose import doubles as the deploy's smoke
test. The same command already executed repo-controlled
code regardless: `buildAgentBundle` does NOT pass `configFile: false` (only
the guest's untrusted-workspace builds do), so the project's `vite.config.ts`
runs at build time either way.

## `aai build` warns about a COMPUTED step name

`_workflow-determinism.ts` scans the project's `workflows/*.ts` for a
`ctx.step`/`ctx.sleep`/`ctx.waitFor` whose identity is a template literal, and
`build` and `deploy` print one line per finding plus the remedy. It is
`guard-invariants` rule 32 (`scripts/guard-invariants-rules-workflow.mjs`)
pointed at a USER's project — that rule holds this repo's shipped bodies to the
same thing, and no project written from them was held to anything.

**It exists because the TYPE system provably misses this shape.** All three
methods constrain their identity with `Literal<Name>`
(`string extends Name ? never : Name`), which refuses a name that has widened to
`string` — and a template literal's type is a template-literal type, not
`string`, so ``ctx.step(`charge-${coin}`, charge)`` compiles cleanly. Verified
against the real `WorkflowCtx`. It is also the engine's own measured defect: a
coin flip interpolated into a step name ran the side effect twice in **7 of 10
runs, with all 10 reporting `completed`**.

Three properties are decisions:

- **It WARNS rather than failing the build**, same posture and same call site as
  `agentConfigWarnings` ("Legal, and worth saying"), because one shape is
  legitimate — a name interpolating a `const` string is the same on every walk.
  On `deploy` the findings join `warnings` rather than only being notified, so
  they reach studio Publish, which reads the result and never stdout.
- **Rule 30's OTHER half is deliberately not ported.** That half scans for the
  non-deterministic READS themselves and pays for the breadth with seven
  baselined occurrences here. Measured before deciding: a faithful port reports
  all seven and nothing else, and all seven are correct code — a read inside a
  step-called helper, which `link-digest`'s own comment explains ("the `ctx.step`
  callback boundary is not decidable from a line"). A user's project has no
  baseline, so that port is a 100% false-positive rate on the only measurable
  corpus, and a checker that is always wrong is one an author scrolls past. The
  boundary needs a real parse; the repo does that with `oxc-parser`, and a native
  parser cannot join a published CLI's runtime dependencies — a new one fails the
  artifact-size budget on its own, regardless of bytes.
- **A FALSE-POSITIVE FLOOR is a test.** `_workflow-determinism.test.ts` runs the
  scan over all fourteen shipped templates and requires ZERO findings, because
  every template is a project somebody scaffolds and then builds. It holds by
  construction: identity is `(name, occurrence)` and the counter is per name, so
  a fan-out reuses one literal — `ctx.step("transcribeSegment", …)` inside the
  loop is the shipped seven-way one. The template count is floored too, a glob
  that stopped resolving being that assertion passing over nothing.

The pattern is DUPLICATED from the gate script rather than shared, and the
duplication is inherent: that file is plain node run over this repo, this ships
in a published CLI, and neither can import the other. What closes it is a test
that reads `IDENTITY_CALLS` out of the gate's source and probes this module with
each name — so a method added to one is a failure rather than a divergence.

## A step that uses ffmpeg wants a LOCAL ffmpeg under `aai dev`

`@alexkroman1/aai/ffmpeg` spawns `ffmpeg`/`ffprobe` by name, and a deployed
guest always has them — the sandbox image installs them (see "ffmpeg is
installed, and a step reaches it through the SDK" in
`packages/aai-guest/CLAUDE.md`). `aai dev` runs the agent on the developer's own
machine, so there the binary is whatever is on `PATH`, or what
`AAI_FFMPEG_PATH` / `AAI_FFPROBE_PATH` (or the conventional `FFMPEG_PATH` /
`FFPROBE_PATH`) name.

**This is the one place that parity is partial, so the FAILURE is written for
it**: ENOENT is reported as "ffmpeg is not installed. A deployed agent's sandbox
has it; under `aai dev` install ffmpeg locally …" rather than as
`spawn ffmpeg ENOENT`. `ffmpegVersion()` answers `undefined` for a missing
binary, so a step can preflight instead of failing mid-conversion. Nothing in
the CLI installs or checks for one: a project whose steps never touch media
should not be asked for a 100 MB dependency, and a deploy of that project works
either way.

## The e2e suite is pnpm-only in CI

`aai init` scaffolds a project that `e2e.test.ts` then installs from a mock
verdaccio registry, so the install step can in principle run under any package
manager. CI used to fan that out (`pm: [pnpm, npm, yarn]` × 2 OSes = 6 jobs); it
now runs pnpm alone.

The npm/yarn legs were paying for themselves in flakes rather than bugs: each one
is a full cold install of the published tarballs on a shared runner, they tripped
over resolver-specific quirks unrelated to our code (hence `--no-lockfile`,
`--no-strict-peer-dependencies`, `NPM_CONFIG_MINIMUM_RELEASE_AGE=0`), and the
repo itself is pnpm-only — so the thing they guarded, "our published `exports`
maps resolve under a non-pnpm resolver", is better served by `publint` + `attw`,
which run on every build and read the package metadata directly.

The `AAI_TEST_PM` switch in `_e2e-test-utils.ts` stays, so an npm or yarn install
is one env var away when reproducing a user report:

```sh
AAI_TEST_PM=npm pnpm test:e2e
```

That line only works because `AAI_TEST_PM` is declared in the `check:e2e` task's
`env` — under turbo's strict env mode it was stripped before the task started, so
the documented command ran pnpm and said nothing. See "strict env mode" in
`AGENTS.md`, which keeps that half of the rule because it is repo-wide.

Treat those two branches as a debugging tool, not covered ground.

**`AAI_REQUIRE_REGISTRY` is the related gate**, in `check:e2e`'s `env` for the
same reason: it turns off this suite's "excuse a failed install as a
registry-proxy flake" predicate (`isRegistryProxyFailure`), and CI sets it so the
guess is not trusted where egress is real.

## Running the SDK's own server (`aai dev` and host mode)

The SDK's `createServer` (`packages/aai/src/host/server.ts`) is what `aai dev` runs,
and its defaults are documented here because this is the caller that owns
`AAI_DEV_HOST`, `hostModeEnv` and `resolveServerEnv`. The two fail-closed
defaults are summarised in `packages/aai/CLAUDE.md`, "Self-hosted server
defaults"; the argument is below.

`createServer` has no request authentication of its own — it is the `aai dev`
backend, not the managed platform. Two defaults exist because of that, and
both are fail-closed:

- **Binds loopback.** `listen(port, host = DEFAULT_LISTEN_HOST)` defaults to
  `127.0.0.1`. Pass `"0.0.0.0"` deliberately to expose it; binding every
  interface by default put a developer's agent (and the provider credentials
  behind it) in reach of anyone on the same network. `aai dev` exposes this as
  `AAI_DEV_HOST` for setups where loopback isn't reachable (e.g. running in a
  container and connecting from the host).
- **Host mode is opt-in.** A `?host=1` WebSocket lets the *client* supply the
  agent definition (`systemPrompt`, `greeting`, relayed tool schemas) while the
  session runs on the operator's credentials, so `isHostAllowed` requires an
  explicit `AAI_ALLOW_HOST` of `1`/`true`/`yes`/`on`. Unset means off.
  Harnesses (e.g. tau2) set it themselves. Note `resolveServerEnv` only
  surfaces keys declared in `.env`, so `aai dev` passes the shell value through
  explicitly (`hostModeEnv`) — otherwise exporting the variable the usual way
  would have no effect.
- **A host client may bring its own provider credentials**, and that is what
  makes a host server safe to expose self-serve. The handshake's `credentials`
  record (keyed by env var name) is merged over the server's env for that one
  connection and WINS on conflict, so a server holding only `AAI_ALLOW_HOST`
  runs every session on the caller's key — an unauthenticated client then has
  no operator credential to spend, because there is none. Substituting a key
  you own is not an escalation: it spends your quota and reveals nothing about
  the operator's. `createHostServer` (`host/host-server.ts`) is that server in
  one call and `examples/host-server` is the runnable shape.

  **`createHostServer` exists because the three-line version was wrong three
  ways** — see `host/host-server.ts`'s module doc for the three and for why the
  placeholder `agent()` was never needed. `defaults` is the only knob, typed to
  exclude the four fields the handshake owns.

  **The allowlist is load-bearing, not tidiness.** Names are screened against
  `ALL_PROVIDER_ENV_VARS` — the same vocabulary bounding
  `withHostCredentialFallback`, for the same reason. This record is merged into
  the env the per-connection runtime is built from, and that env is read for
  far more than provider keys: unbounded, a client sets `DATABASE_URL` and the
  server opens the workflow world, the upload store and the session-state
  backend against a Postgres it controls, or sets `AAI_ALLOW_HOST` and
  self-approves. (It used to say `ctx.db` here, which was the sharpest way to
  put it and is gone; the three readers that remain are the argument now.) So
  the gate is checked against the SERVER's env before the merge, never the
  merged one. Unknown names are
  REJECTED by name rather than dropped — a silent drop turns a typo
  (`ASSEMBLYAI_KEY`) into a baffling provider-resolution failure two layers
  down, and turns a genuine smuggling attempt into something the operator never
  hears about.
- **A host session with no base agent runs the DEFAULT PIPELINE, not S2S.**
  `buildHostAgent`'s doc comment claimed the opposite until 2026-08 — it
  predated the pipeline-by-default flip, and S2S has required an explicit `s2s`
  descriptor ever since (see "Never let S2S be a fallback"). With no
  `hostBaseAgent`, `createRuntime` fills all three stages from the
  all-AssemblyAI pipeline, so one caller-supplied `ASSEMBLYAI_API_KEY` covers
  STT, the LLM gateway and TTS. The stale comment had a real cost: it is what
  made a placeholder `agent()` look mandatory on every host server.

- **Host-mode audio pacing is the CLIENT'S declaration, and it defaults to
  paced** (`HostConfig.audioLeadMs`: omitted = the pacer's real-time
  `CLIENT_AUDIO_LEAD_MS`, a number = that lead, `null` = unpaced).

  Unpaced used to be the blanket default, on the reasoning that a host-mode
  client is programmatic and therefore keeps its own clock. That conflates two
  different things: being programmatic does not mean consuming FASTER than the
  wall clock, and only a client whose timeline runs ahead is starved by pacing.
  For a client that drains at 1x it is destructive, because in S2S mode the
  service synthesises a whole reply server-side and it arrives in one burst
  (measured: up to 1118 audio frames in one tau2 tick, against 205 on the
  pipeline transport, whose per-sentence TTS flush paces it inherently). tau2
  plays 200ms per tick and buffers the rest, so the backlog grew to MINUTES — and
  it DISCARDS that buffer on barge-in, so 36% of all agent audio was destroyed
  unheard, p99 181s and max 272s per barge-in on a 215s call, against 18-23% and
  a 15s max for the pipeline arms. The caller heard a fraction of the replies and
  kept asking "are you still there?"; the S2S arm completed a reply for 0.53 of
  caller turns where the pipeline managed 1.00, and 18% of its sessions completed
  no reply at all. Pacing keeps the backlog on OUR side, where
  `PacedAudioSink.clear()` drops it on barge-in instead of handing it over to be
  thrown away.

  So tau2 is not the case unpaced was written for: its `_async_run_tick` enforces
  a MINIMUM tick duration, so it never runs ahead of the wall clock (measured
  mean 315ms per 200ms tick — 0.63x real time). Reach for `null` only for a
  harness that genuinely steps faster than real time.

## Windows is NOT tested, and is currently broken

There is no Windows leg in CI. One was added, run once, and removed — and what
it found is the reason this section exists rather than a TODO.

**No package declares an `os` field, so all three published packages claim
Windows support by omission**, and `aai-cli` is the one a Windows user actually
runs: `login.ts` branches on `win32` and four modules split on `path.sep`, so
the support was considered and then never exercised. One `windows-latest` run
over `aai`, `aai-ui` and `aai-cli` unit tests failed two of three legs, on two
unrelated causes:

- **Hardcoded `/tmp` string literals.** On Windows `/tmp/x` is DRIVE-RELATIVE —
  it resolves to `D:\tmp\x`, which does not exist — so every write failed with
  ENOENT. Two shipped modules had it (`host/workflow-serve.ts`,
  `aai-guest/harness-bundle.ts`), and both run on the DEVELOPER's machine under
  `aai dev`, not only in the Linux guest. **Fixed**, and
  `guard-invariants.mjs` rule 11 keeps them out; the only baselined occurrences
  are `modal-agent-sandbox.ts`'s remote paths, which name a location inside the
  Linux sandbox where `/tmp` is correct and `tmpdir()` would describe the wrong
  machine.
- **The `aai` build emits differently on Windows.** `aai-cli`'s dev-server specs
  died in rolldown with `UNRESOLVED_IMPORT` on `./_internal-types.ts` inside
  `../aai/dist/sdk/manifest-barrel.js` — i.e. that emitted file carried `.ts`
  specifiers. On Linux the same file is a normal tsdown bundle importing a
  hashed chunk (`../_internal-types-DiEjant0.js`), so the Windows build produced
  unbundled output where Linux produces a bundle. **UNRESOLVED**, and left that
  way deliberately: it is a toolchain-level difference in tsdown/rolldown
  itself that cannot be diagnosed without a Windows machine to
  iterate on, and blind pushes at ~4 minutes per CI round trip are not
  debugging.

So the state is: Windows is plausibly close to working, two real bugs are fixed,
and one build-level unknown stands between here and a green leg. **Do not
re-add the matrix without a Windows machine to reproduce on**, and do not add it
as `continue-on-error` — a leg that is green while broken is worse than no leg,
which is the rule the rest of this file's gates are built on.

Note the middle tiers were never the right thing to duplicate onto Windows
anyway, which is where this diverged from vercel/eve (they run their integration
tier on a Windows matrix leg). Ten of this repo's fourteen
`*.scenario.test.ts` files are aai-server's Postgres, WebSocket and bundler
tests — Linux by design, not by accident. Running them on Windows would test the
runner rather than the code. The three remaining `*.integration.test.ts` files
are pure in-memory property tests, so they would tell you about fast-check, not
about Windows.

## Self-hosting is the scaffold's default, and it runs the BUILT worker

`scaffold/server.mjs` plus the `prestart`/`start` pair ship in every project, so
**any** project runs on its own with `npm start`: no platform account, nothing
managed. It is deliberately a FILE rather than a CLI command — a command is
something you have to know exists, and the whole gap it closes was that
`createAgentServer` already made self-hosting one call and nothing put that call
in front of anyone. Every `aai init` and every `aai pull` layers it in, so a
project cannot end up without it.

**`server.mjs` imports `.aai/worker.mjs`, and `prestart` (`aai build
--skip-tests`) is what produces it.** It used to import `./agent.ts` directly,
under a "no CLI at run time, no bundler" banner, and that banner is what had to
go: a tool is registered by EXISTING, and the only place a directory can be
turned into modules is where the bundle is assembled — a deployed agent is handed
one ESM string and has no filesystem to scan. So an un-bundled loader serves an
agent with **none of its tools and no error anywhere**: `/health` and
`/client-config` answer perfectly and the agent cannot do the thing. That is the
same silent absence discovery was introduced to kill, one level worse (every tool
at once instead of one), which is why self-hosting was moved onto a build rather
than given a second scanner.

Four things follow, and they are what to preserve:

- **There is no runtime `tools/` scan anywhere, and that is a decision.** The
  plan offered a `readdir` + dynamic `import()` mode for the two loaders with no
  bundler; neither took it. A spec uses `import.meta.glob` (see
  `_discovery.ts` above — Node's resolver would hand the tools a second copy
  of the SDK), and self-hosting now has the bundler in its path after all. The
  SDK's lazy `loadToolModules` existed for that mode and is deleted: a second way
  to build a registry is how the rules come to have two behaviours.
- **The `registerHooks` shim is GONE, because the bundle resolves what it was
  teaching.** It taught Node `?raw` (a Vite convention — Node looks for a file
  literally named `system-prompt.md?raw`) and attribute-less `.json`
  (TypeScript's `resolveJsonModule` allows it, Node wants
  `with { type: "json" }`). Nine templates imported `./system-prompt.md?raw` at
  the time and `retail/store.ts` imports `./seed.json` bare, so before the shim
  `npm start` worked for four templates out of fourteen — and Vite inlines both,
  so there is nothing left to teach. The `?raw` count is now ONE
  (`pizza-ordering`, which composes): the generated entry writes that import
  itself, so the convention no longer costs an author a bundler feature. The
  argument is unchanged either way — Vite inlines it wherever it is written.
  The DYNAMIC import survives it: the path is computed at run time, and it is a
  `pathToFileURL` rather than a relative specifier so the entrypoint is correct
  on Windows.
- **A missing artifact exits with the command that fixes it**, rather than
  booting an agent with no tools or failing on a bare `ERR_MODULE_NOT_FOUND`.
  That is the path `node server.mjs` takes when run directly, i.e. bypassing
  `prestart`.
- **`ctx.env` and provider credentials come from different places, on purpose.**
  `env` is declared keys only (`.env`, plus `.env.example` as a declaration so a
  container with no `.env` still works, with real environment variables winning
  per key) — the same rule `aai dev` follows, so an agent cannot come to depend
  on a `PATH`-style variable that will not exist after deploy. Provider
  credentials go through `withHostCredentialFallback`, which is what lets
  `docker run -e ASSEMBLYAI_API_KEY=…` work without the key becoming `ctx.env`.
  An empty declared value is DROPPED rather than passed through: a provider
  would authenticate with `""` instead of reporting the credential absent, and
  `.env.example` is full of empty values by design.

The cost is that self-hosting needs the CLI as a devDependency, which the
scaffold already declares — so `npm ci --omit=dev` in a container is not a
supported shape, and `prestart` skips only the TESTS: `npm test` is where a suite
belongs, and a failing test must not be what stops a container from starting.

`packages/aai-cli/src/e2e.test.ts` boots `npm start` against a real installed
project — **`pizza-ordering`, chosen for its `tools/` directory**, which is what
this leg is now about (it keeps the old `math-buddy` coverage anyway, whose
prompt is a discovered `system-prompt.md`). It probes `/health`,
`/client-config` and `/`, and then
reads the six tool names out of the artifact the server booted, because nothing
over HTTP exposes a tool list. That tier is the only one that can prove any of
it: the project's own `aai build` runs from a real INSTALL, and
`defaultClientDir()` resolves out of the installed `@alexkroman1/aai-ui`.
