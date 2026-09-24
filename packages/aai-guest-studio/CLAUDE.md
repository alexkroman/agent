---
summary: >-
  The studio coding agent in a guest: the package boundary, the agent as an
  ordinary `agent()`, workspace claims and reified package.json, `read_logs`,
  Publish, and its tests
read_when: >-
  working on the studio coding agent as it runs in a guest
---

# packages/aai-guest-studio — studio coding agent guide

The browser studio's coding agent, as it runs inside a guest sandbox (private
package). The harness that dispatches it is `packages/aai-guest/CLAUDE.md`; the
shared guest modules are `packages/aai-guest-core/CLAUDE.md`; the studio
SERVICE that drives it is `packages/aai-studio-server/CLAUDE.md`.

**The agent itself and its tools are documented below**, from "The coding agent
is an ordinary `agent()`" on; its tests and eval are
`packages/aai-guest/CODING-AGENT-TESTS-CLAUDE.md`.

## What is in here, and what the boundary buys

Everything that was `aai-guest/src/studio/` — 60 files — plus
`studio-prompts/`, the committed copies `scripts/sync-studio-prompt.mjs`
writes. The prompts moved because `_eval-prompt.ts` reads them relative to
itself.

It depends on `aai-guest-core` and is depended on by `aai-guest`, whose entry
dispatches studio mode. That direction is the whole reason core exists — see
"Why this package exists" in that guide.

## Two paths reach OUT of this package, and both are deliberate

- **`toolchain/` stays in `aai-guest`.** The guest image's Docker build context
  is that package, and the Dockerfile `COPY`s `toolchain/package.json` and
  `dist/harness.mjs` from the one context. This package resolves it at RUN time
  by searching upward (`toolchainRoot()` in `build.ts`), so it needs no
  compile-time path; `agent.test.ts` reaches across for it, which is test-only.
- **`project-shape.test.ts` reads `aai-templates/scaffold/`**, a drift gate over
  another package's files. Its two input globs came with it into this package's
  `turbo.json`, because an input glob belongs to whichever package READS the
  file.

## The session scratch directory moved with `build.ts`

`workspacesRoot()` is `path.join(import.meta.dirname, ".workspaces", pid)`, so
a materialized workspace now lands beside THIS package's source. The coding
agent writes `*.test.ts` into a workspace, so a leftover one is collected by
the unit glob and fails this package's suite with somebody else's assertion —
it happened once in `aai-guest`, where a stray fixture whose whole job is to
fail turned `pnpm check` red naming a file no commit contains. The
`src/.workspaces/**` exclude moved with it.

## The coding agent is an ordinary `agent()`

`agent.ts` is the definition (`text: true`, the session's system prompt, the
gateway model, `maxSteps`, `builtinTools`, four tool families); `chat.ts` is the
HTTP surface plus one turn's delivery. Never hand-assemble a `streamText` call
here — every piece of that is `agent()` plus `createTextAgent`
(`@alexkroman1/aai-runtime`), and a second copy drifts from the shipped rule.

- **Tools are SDK `ToolDef`s** (`tool()`), run through `executeToolCall`:
  schema validation, coercion, `ctx`, the per-call deadline, and a throw shaped
  into `{"error": …}`. Specs call `runTool` (`aai-guest-core/test-utils`), never
  `execute` — several depend on that shaping.
- **Web builtins are NAMED** (`builtinTools: ["visit_webpage",
  "get_page_design", "web_search"]`), not adapted.
- **`generate_design_inspiration` uses `ctx.generate`**, so the brief and the
  reply use the same model.
- **The 120s tool deadline is `toolTimeoutMs`** on `createTextAgent` (the SDK
  default 30s is a voice budget; these tools install packages and typecheck).
- **Tool-call repair is the SDK's** (`aai/host/tool-call-repair.ts`), JSON
  salvage tier included.
- **Step budget is `maxSteps + 1`** with `toolChoice: "none"` forced on the
  extra step, so a capped turn ends with an answer rather than silently after a
  tool result (same rule as the voice pipeline; `DEFAULT_MAX_STEPS` in
  `packages/aai/DEFAULTS-CLAUDE.md`).
- **Studio-owned:** the wall-clock turn budget (`turn-budget.ts`, an extra
  `stopWhen` alongside the step cap) and compaction (`compaction.ts`, in
  `prepareStep`; the SDK composes its reserved final step over it).

**Compaction is two tiers.** Tier 1 is the SDK's `pruneMessages` — drops old
tool RESULTS in call/result pairs by `toolCallId`, free and deterministic, and
keeps the agent's narrative text. Tier 2 (LLM summary) runs only if still over
budget. **Cut points must fall on turn boundaries:** a cut at index `i` is safe
iff `messages[i]` is not a `tool` message (providers reject an unmatched tool
result; same failure `capLlm` documents in
`aai/host/transports/pipeline-history.ts`). Boundaries only move OUTWARD.

`STUDIO_TOOL_LABELS` and `MUTATING_TOOLS` are checked against
`createStudioAgent`'s real tool surface, never a hand-merged copy.

**The nine workspace tools are the SDK's** (`createCodingTools`,
`@alexkroman1/aai/coding-tools`); `spawn.ts` re-exports the capped child runner.
Only the three seams are studio-shaped: `validate` = write-time syntax gate
(`syntax.ts`), `afterWrite` = post-write type check (`write-diagnostics.ts`),
`env` = `workspaceChildEnv()` (the SDK default, the process env, is wrong for a
guest holding a control-channel bearer). `test_agent` stays here whole.

**`test_agent`'s test run is `aai test`'s tier; the eval tier is excluded.**
`testFiles` drops `*.eval.test.ts` by infix and passes the discovered files as
positional filters (vitest's default glob would collect evals, which can only
run scripted here since the key is scrubbed). Covered in
`test.scenario.test.ts` by a fixture eval that fails if ever collected.

**Descriptions split the same way:** `CODING_TOOL_DESCRIPTIONS` (SDK),
`STUDIO_CODING_TOOL_DESCRIPTIONS` (overrides for three host-specific tools),
`STUDIO_TOOL_DESCRIPTIONS` (studio-only tools). `tool-descriptions.test.ts`
asserts together they cover the real tool set exactly and every override names a
tool the SDK describes.

**The post-write checker is built ONCE in `createStudioAgent`** and passed as
`diagnostics` to both `createStudioTools` and `createTemplateTools`, so
concurrent writes share one `createCoalescingRunner` pass. Pass the CHECKER
down, never the `typecheck` function.

**Scripts a check speaks for are one set:** `isScriptFile` in `syntax.ts`.

**A "toolchain unavailable" verdict is never cached.** `loadTransformer` clears
its memo on rejection (as `loadToolchain` does in `build.ts`) — `createRequire`
is anchored at the workspace, which a re-install rebuilds, so a resolve can fail
transiently and a cached `null` would disable the syntax gate for the process.
Not testable: vitest patches `createRequire`.

**Every child running workspace-authored code gets a scrubbed env.**
`workspaceChildEnv()` (`spawn.ts`) is an allow-list used by `bash`, `runNpm`
and the workspace test run; the in-guest deploy child takes the stricter
`cliChildEnv()` (`PATH` plus the three names `os.tmpdir()` reads, which keeps
the bundler's `mkdtemp` off the microVM's RAM disk). Defence in depth, not a
boundary (`bash` can read `/proc/<pid>/environ`) — so keep it uniform, no
exceptions.

**Publish writes the CLI's files with the CLI's own writers**
(`@alexkroman1/aai-cli/project-config`: `writeConfigHome`,
`updateProjectConfig`) — the config home holds the API key and is written 0600
via atomic rename; `.aai/project.json` is merged, never replaced. The dynamic
import comes AFTER `resolveCliEntry()`, which fails the publish cleanly if the
toolchain is missing. Anything else written for the CLI belongs in that subpath.

**A prompt-directory URL keeps its trailing slash**
(`new URL("../studio-prompts/", import.meta.url)` in `_eval-prompt.ts`):
without it `new URL("agent.md", …)` replaces the last segment. Path-rewriting
sweeps drop it.

Testing: [`packages/aai-guest/CODING-AGENT-TESTS-CLAUDE.md`](../aai-guest/CODING-AGENT-TESTS-CLAUDE.md)
— the agent-level spec through `runTextAgent` and the agent's own eval.

## One claim on the workspace at a time — turns AND re-installs

`createTurnGate` (`turn-stream.ts`) holds one process-wide claim via `enter()`,
taken by a chat turn AND by `initStudioSession`.

- **A second turn is REFUSED (423), not queued** — a waiting request would
  settle a stale conversation snapshot. The queue lives in the tab.
- **A session-init that cannot take the claim keeps the live tree** and
  re-points the session at it, taking only the new config (chat token, system
  prompt, model). `materializeWorkspace` is an `rm -rf` of a per-process path,
  so re-installing mid-turn would delete the in-flight turn's work; mid-turn the
  guest tree is ahead of the store anyway. The tab's first turn gets 423 until
  the running one ends (`aai-studio-client/src/resilient-fetch.ts`).
- **Take the claim; never read a busy flag** — holding it across preparation
  also closes the race of a turn starting on a half-materialized tree.

## A workspace's own package.json is REIFIED, not just read

`workspace-deps.ts` runs `npm install --omit=dev` when anything in
`dependencies` is missing, wherever a workspace is prepared: `initStudioSession`,
`deployWorkspaceDir` (Publish), `buildWorkspaceDir` (`test_agent`). Needed
because `node_modules` survives neither a re-install (`rm -rf`) nor Publish's
fresh `withBuildDir`, nor an `aai push`, and the worker bundle is
`ssr: { noExternal: true }` — a missing package is a hard resolve failure.

**The workspace manifest declares only the workspace's own packages.** The
platform's six (`WORKSPACE_DEPENDENCIES` in `project-shape.ts`) resolve from the
toolchain `node_modules` above every workspace and must stay undeclared — npm
reifies whatever the manifest names, and declaring them makes every install
cost tens of seconds and ~150 MB. If staging/per-package machinery ever looks
necessary, check first whether the manifest grew platform-owned entries.

- **`--omit=dev`** — devDependencies are the baked toolchain.
- **Session-init passes `SESSION_INSTALL_BUDGET_MS` (20s)**, under the host's
  `ADOPT_TIMEOUT_MS`/`SESSION_INIT_TIMEOUT_MS`; a slow registry degrades to a
  warning rather than failing the session.
- **Per-directory lock with an acquire deadline**; the no-op path must NOT take
  it.
- **Presence, not version satisfaction, decides "missing"** (npm's own rule).
- **A failed install WARNS**, prepended only to a FAILING build/publish
  (`withDependencyWarning`).

**TS2307 carries a hint** (`diagnostics.ts`) naming `add_dependency`, which also
RECORDS the package so it survives refresh and Publish.

**Lockfiles do not sync** (`snapshotWorkspace` passes `isLockfile`) — ~100 KB
each, npm-shaped in a pnpm project. `walkWorkspace` still lists them for
`list_files`/`grep`. `.env` deliberately DOES sync (the agent may write it).

## `read_logs` reads ANOTHER guest's ring

`read_logs` (`logs-tool.ts`) shows the coding agent the deployed preview or
production agent's log ring — errors `test_agent` cannot see. It is a host RPC
(`studio/agent-logs`), not a fetch: the guest names an ENVIRONMENT and the host
resolves slug and origin from the sandbox's pinned (scope, project) — see "The
guest never names a slug" in `aai-studio-server/studio-agent-logs.ts`. The ring
itself: "Why the buffer lives in the guest" in
`packages/aai-guest/src/harness/CLAUDE.md`.

## Testing notes

- **`chat.scenario.test.ts` drains before unhooking the host channel**:
  a turn's settle (`snapshotWorkspace` walk + two host RPCs) outlives
  `serve().close()`, and `setHostSend` is a process singleton. `drainTurns()`
  waits for the turn claim free, `pendingHostRequests` empty, and no new frame
  since last poll; bounded and best-effort.
- **Tier = what a test touches.** Split a file on what it touches rather than
  lowering a coverage floor: `build.test.ts`/`test.test.ts` keep the pure parts;
  build-dir lifecycle, typecheck gate and real vitest spawns are scenario. A
  file with no pure half splits on the caller's side of the I/O: `chat.test.ts`
  drives the handler over in-memory `IncomingMessage`/`ServerResponse`. Floors
  do not move.
- **Incidental coverage is not coverage** — `turn-settle.ts` has its own spec
  (with `snapshotWorkspace` mocked) because `check:coverage-per-file` measures
  per file.
- **Detached `ServerResponse`**: needs `assignSocket` to be writable and never
  emits `finish` — anchor on the `end` call. `expect` inside a helper trips
  `noMisplacedAssertion`.
- **No hand-written `timeout: 120_000`** — that is the scenario tier's timeout.
- **Same PID ≠ shared module registry**: vitest `threads` gives each file its
  own module instance in one process, so `withBuildDir` names carry a random
  token (a counter collided, surfacing as `ENOENT: uv_cwd` inside rolldown).
