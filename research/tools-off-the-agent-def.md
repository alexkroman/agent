---
issue: TODO
status: implemented
last_updated: "2026-08-14"
---

# Move tools off the agent def so the directory can be the registry

`1-filesystem-derived-tools.md` set out to delete the hand-written `tools:` map
and derive it from `tools/`. The diagnosis was right — a forgotten registration
is silent, and the file name already IS the tool name — and its mechanism was
wrong. This is the mechanism that works, and the reason it is a bigger change
than a bundler tweak.

It has **no numeric prefix on purpose**: it builds no mechanism another plan
consumes and consumes none. The soft ordering this note used to give —
land `2-durable-session-state.md` first and the "does `S` inference survive"
question disappears — turned out to be unnecessary rather than merely optional:
the question had no content, because `AgentDef.tools` was already `NoInfer<S>`.
See "Status" below.

## Why the obvious seam fails

Discovery has to resolve where the bundle is assembled, because the guest
sandbox loads ONE ESM string and has no directory to scan. But **two consumers
of `agent.ts` never go through a bundler**:

| Consumer | Path to `agent.ts` | Bundler in the path? |
| --- | --- | --- |
| `aai dev`, `aai publish`, the studio | `buildWorker` → generated entry | yes |
| `scaffold/server.mjs` (`npm start`) | `await import("./agent.ts")` | no |
| vitest (`templates.test.ts`, 4 template specs) | direct import; `def.tools` | no |

Self-hosting is the scaffold's default and advertises "no CLI at run time, no
bundler", so a map emitted only into the CLI's generated entry produces an agent
with **zero tools** under `npm start`, and empties `def.tools` for every spec
that drives tools through the agent's own table. `import.meta.glob` in `agent.ts`
fails the same way one loader over: it is a Vite syntax transform, so plain Node
looks for a file literally named `tools/*.ts`.

The blocker is not the seam. It is that **`tools` is a synchronous field on
`AgentDef` and a directory scan is asynchronous**, so no loader without a build
step can populate it at definition time.

## Status: the two-mode design collapsed to ONE, and self-hosting landed

**There is no disk mode, and there is not going to be one.** The design below
proposes two — bundled, and a `readdir` + dynamic `import()` scan for the two
loaders with no bundler — and neither of those loaders took the second:

- **vitest** uses `import.meta.glob` (`aai-templates/_tool-discovery.ts`), which
  keeps the tool modules inside VITEST's graph. Through Node's resolver they
  would get a second copy of the SDK, so a slot's module state would differ
  between the tool under test and the agent holding it.
- **`scaffold/server.mjs`** now boots the BUILT worker (`.aai/worker.mjs`,
  written by `aai build`, run by a `prestart`), so the bundler is in its path
  after all. That is this document's stage D, and it took the `registerHooks`
  shim with it — Vite inlines the `?raw` and bare-`.json` imports the shim
  existed to teach Node.

So the "one shared builder in the SDK, two specifier styles" idea is unneeded:
`toolRegistry(modules)` over already-loaded modules is the whole surface. The
lazy `loadToolModules(loaders)` was built for disk mode, shipped on
`@alexkroman1/aai/manifest`, called by nothing, and is **deleted** — a second way
to build a registry is how the rules below (name grammar, default export,
flat-only, collisions) come to have two behaviours.

What this cost, and it is worth stating rather than burying: self-hosting is no
longer "no CLI at run time, no bundler". It needs `@alexkroman1/aai-cli` as a
devDependency (the scaffold already declares one) and a build in front of the
server. The alternative was an entrypoint that boots an agent with **no tools and
no error anywhere**, which is the same silent absence discovery was introduced to
kill, one level worse.

## Status: the param is GONE, and `tools` did NOT have to leave `AgentDef`

**The remaining scope landed, and the one row that did not is the row that was
wrong.** What shipped:

- **`agent()` takes no `tools`.** The field is `InlineToolsMisuse` on the
  parameter shape — a compile error naming the file to create, the same idiom as
  `PipelineOnlyMisuse` — and `agent()` also THROWS on a `tools` key. The second
  half is not belt-and-braces: neither bundler type-checks user code, so the type
  alone would make "a tool is only ever a file" true of this repo and of nobody's
  project. It is also exactly the shape an options bag arrives in, where the
  excess-property check does not fire.
- **The six templates this document's predecessor missed are converted** —
  `health-assistant`, `embedded-assets`, `infocom-adventure`, `night-owl`,
  `recap-desk`, `research-desk`. Thirteen templates, no `tools` map anywhere.
- **The studio's own text agent goes on with `withTools`**, which is the honest
  answer rather than an exception: its four tool families close over ONE session's
  workspace directory and are rebuilt per turn, so they cannot be files. A
  registry resolved from a session, attached the same way a registry resolved from
  a directory is.
- `aai:agent` epoch 8 is **dropped** (`--drop`), with epochs 1–2 and 4–7 dropped
  beside it and their frozen examples deleted; epoch 3 survives because a workflow
  app never declared a tool. `aai:state` epochs 1–2 are dropped too, by hand,
  because its own report did not move — the slot API is untouched and those two
  examples merely attached their tools through the dropped param.

### "`tools` off `AgentDef`" was the wrong row, and the resolve step is unbuilt

The scope table asked for a `resolveAgentTools(def, source)` step and for `tools`
to stop being a field. Neither is needed, and building them would have been
strictly worse:

- **`withTools` already IS the resolve step.** It returns a new def with the
  registry merged, so `tools` stays a synchronous field and every reader —
  `createRuntime`, `createAgentServer`, `toAgentConfig`, `agentToolsToSchemas`,
  `trial.ts` — is untouched. The blocker this document opens with ("`tools` is a
  synchronous field and a directory scan is asynchronous") dissolved when disk
  mode did: both surviving sources hand over ALREADY-LOADED modules, so the
  resolution is synchronous and the field is fine.
- **"Registry-aware `toolOf` / `runTool` / harness" is therefore a no-op**, and
  the row is deleted rather than done. They read `agentDef.tools`, and
  `withDiscoveredTools` fills it; four templates' specs already worked this way
  before this stage, and five more joined with no change to the helpers.
- **`S` inference was never at risk**, which retires this document's last open
  question rather than answering it. `AgentDef.tools` is `NoInfer<S>` and always
  was, so a `tools` map never contributed to inference; `state` is the only
  source. What the map DID check is a tool's assignability against `S`, and that
  is the guarantee `sessionSlot()` now carries alone — which is most of why slots
  exist, and the reason `infocom-adventure`'s eight tools got SHORTER by moving
  into files (`slot.tool()` needs neither the annotation nor the opening
  `slot.get`).

One thing the type test found that review did not: **`withTools`'s registry
parameter had to become `NoInfer` too.** Without it a tool written without the
state type — the common case — competes with the def for the inference and
collapses `S` to `never`, so `withTools(agent({ state }), { ping })` silently lost
the state shape. Same fix, same reason, one layer down from `AgentDef.tools`.

## Design: eve's two modes over one generator

`~/Code/eve` solves exactly this and is worth copying closely
(`packages/eve/src/compiler/module-map.ts:99`): a build-time `readdir` whose
output is **lowered into static import statements**, so the bundler follows them
and no filesystem is needed at run time. Three properties to keep:

- The generated map is **gitignored and regenerated every compile** (`.eve/`), so
  drift is structurally impossible and there is **no `--check` gate**. A
  committed registry plus a staleness gate is the obvious first design and is
  strictly worse. Our equivalent already exists: `buildWorker` writes
  `.aai/worker-entry.ts` and deletes it in a `finally`.
- Tool files **default-export**. Already done — see
  `1-filesystem-derived-tools.md`.
- **Tools are not on the agent def.** They live in a compiled manifest the
  runtime resolves (`resolve-tool.ts:28`), and eve's own tests install an
  in-memory synthetic registry (`compile-from-memory.ts`) rather than import a
  tool module.

The one thing eve gets for free that we do not: it has exactly **one** way to
load an agent — dev and production both call `compileAgentInWorkspace`, differing
only in import-specifier style out of one generator. We have two un-compiled
loaders, so we need two modes:

1. **Bundled.** `buildWorker`'s generated entry enumerates `tools/*.ts` and emits
   static imports plus the map, exactly as today it emits `__aaiConfig`. This is
   the seam `1-filesystem-derived-tools.md` identified and it is still right —
   just not sufficient alone.
2. **Disk.** A `readdir` + dynamic `import()` scan, used by `server.mjs` **and**
   by vitest. Both have a filesystem, which is what makes one implementation
   cover both.

Both modes produce the same value from one shared builder in the SDK, so the
thing that could drift is a specifier style rather than a rule.

### The resolve step is the actual change

`tools` stops being read off `AgentDef` directly and becomes the result of a
resolve step that merges discovered files with the inline map:

```ts
// shape, not final API
const tools = await resolveAgentTools(def, source); // source: bundled | disk
```

- **`agent({ tools })` stays.** Three templates declare more tools than they have
  files (`travel-concierge`, 16 against 10) because a tool closing over
  module-local state or built by a wrapper (`retail`'s `retailTool`) is
  legitimately an expression. So this is a merge, not a replacement.
- **A name declared both inline and as a file is an ERROR**, not a shadow —
  there is no old code here for new code to override, so the two spellings are a
  mistake and only the author knows which was meant. `builtinTools` keeps its own
  precedence rule, where the shadowed thing is framework-supplied.
- **A file exporting no `ToolDef`, and a nested file, are errors naming the
  file.** Nested is rejected rather than given a join convention: no template
  nests, so any convention picked now is a guess frozen into the rule. (eve
  flattens `tools/billing/refund.ts` to `"billing-refund"` because providers
  reject `/`; that is a decision to make deliberately, not by default.)

Callers to convert: `createRuntime`, `createAgentServer`, `toAgentConfig` /
`agentToolsToSchemas` (the platform reads `__aaiConfig.toolSchemas`, so the
schemas must come from the resolved registry), and the `/testing` helpers.

### What it costs the test surface, which is where the real work is

`runTool(agentDef, name, args, ctx)` and `toolOf(agentDef, name)` read
`agentDef.tools` synchronously, and four template specs use them
(`pizza-ordering`, `plan-desk`, `support-line`, `travel-concierge`); three more
import tool modules directly (`retail`, `solo-rpg`, `dispatch-center`). Either
those helpers take a resolved registry, or they become async. eve's answer is a
harness that installs a registry, and it is probably ours too — but this is the
part to design before writing code, because it is the part that touches published
API.

`template-tool-registration.test.ts` is **deleted** by this plan: with discovery
total there is no registration step to forget, which is the whole point. What
replaces it is the diagnostics above — a file that exports no tool, or nests, or
collides with an inline name, must fail the build naming the file.

**One consumer of `def.tools` lives outside the packages listed above, and it
should be deleted rather than ported.** `aai-server/smoke.test.ts` (193 lines)
calls `agentToolsToSchemas(agent.tools)` at three sites, so this plan breaks it
and porting it would preserve a test whose premise is already dead. Its header
claims it verifies that "tool schemas survive the SDK → deploy body → server
round trip"; that stopped being true when the stored config column was dropped.
`DeployBodySchema` has no `agentConfig` field (its own comment says so), zod
strips the key the test builds, and the assertion is `expect(res.status).toBe(200)`
— green while checking nothing, which is the shape this repo's gates exist to
catch. Four of its six tests never touch the server at all (`toAgentConfig`,
`resolveAllBuiltins`, `agentToolsToSchemas`) and belong in `packages/aai`; the
one that does — deploy, then `GET /:slug/health` and `GET /:slug/`— is covered by
`deploy.test.ts` and the transport suite.

While there: `aai-server/platform-events.test.ts:17` still carries a
`config: { name, systemPrompt, greeting, toolSchemas: [] }` fixture for that same
dropped column, cast `as never` so nothing reports it.

## Scope

| Change | Where |
| --- | --- |
| ~~Shared registry builder (static-import source + disk scan)~~ — **one source shape; `loadToolModules` deleted** | `aai` SDK ✅ |
| Emit the map in the generated entry | `aai-cli/worker-bundler.ts` ✅ |
| ~~Scan on boot~~ — **load the built worker; `prestart: aai build`; shim dropped** | `aai-templates/scaffold/server.mjs` ✅ |
| Write the worker to `.aai/worker.mjs`; `prestart` in eject too | `aai-cli/build.ts`, `aai-cli/eject.ts` ✅ |
| Resolve step; `tools` off `AgentDef` | `sdk/define.ts`, `host/runtime.ts`, `sdk/manifest.ts` |
| Registry-aware `toolOf` / `runTool` / harness | `aai/sdk/testing.ts` |
| Delete the `tools:` maps and their imports | 6 templates, 62 entries |
| Delete the registration test | `aai-templates` |
| Delete `smoke.test.ts` (dead premise, reads `agent.tools`); move its four SDK-only tests to `packages/aai` | `aai-server` |
| Epoch bump as `--drop` | `contracts/` — `aai:agent`, `aai:tool`, `aai:testing` |

## Open questions

- **Does the watcher rebuild on a NEW file?** Adding a tool has to trigger a
  rebuild, not a reload of changed modules, or discovery makes the authoring loop
  worse than the map it replaces. Bundled mode changes the generated entry, so
  the watcher must treat a new `tools/` file as a rebuild trigger. **This is the
  one still open, and it is now the ONLY answer** — the "disk mode gets it free
  from a fresh scan per boot" escape is gone with disk mode.
- **Does the studio's workspace build see a `tools/` directory?** It materializes
  a workspace to disk and builds through `buildWorker`, so it should — confirm
  before committing, since it is the same class of assumption that sank the last
  plan.
- **Does `S` inference survive the merge?** Moot if `2-durable-session-state.md`
  lands first; otherwise do the cheapest thing that keeps current inference and
  build no machinery to protect a generic scheduled for deletion.
- **Is `tools/` the right directory name for a user project?** eve nests
  everything under `agent/`. Ours sits beside `agent.ts` at the project root,
  which is fine, but the scan must not pick up a `tools/` directory that belongs
  to something else.
