---
issue: TODO
status: proposed
last_updated: "2026-08-14"
---

# Move tools off the agent def so the directory can be the registry

`1-filesystem-derived-tools.md` set out to delete the hand-written `tools:` map
and derive it from `tools/`. The diagnosis was right — a forgotten registration
is silent, and the file name already IS the tool name — and its mechanism was
wrong. This is the mechanism that works, and the reason it is a bigger change
than a bundler tweak.

It has **no numeric prefix on purpose**: it builds no mechanism another plan
consumes and consumes none. One soft ordering is worth knowing —
`2-durable-session-state.md` removes `ToolContext<S>`'s generic, and landing it
first deletes this plan's entire "does `S` inference survive" question rather
than answering it.

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

## Scope

| Change | Where |
| --- | --- |
| Shared registry builder (static-import source + disk scan) | `aai` SDK |
| Emit the map in the generated entry | `aai-cli/worker-bundler.ts` |
| Scan on boot | `aai-templates/scaffold/server.mjs` |
| Resolve step; `tools` off `AgentDef` | `sdk/define.ts`, `host/runtime.ts`, `sdk/manifest.ts` |
| Registry-aware `toolOf` / `runTool` / harness | `aai/sdk/testing.ts` |
| Delete the `tools:` maps and their imports | 6 templates, 62 entries |
| Delete the registration test | `aai-templates` |
| Epoch bump as `--drop` | `contracts/` — `aai:agent`, `aai:tool`, `aai:testing` |

## Open questions

- **Does the watcher rebuild on a NEW file?** Adding a tool has to trigger a
  rebuild, not a reload of changed modules, or discovery makes the authoring loop
  worse than the map it replaces. Bundled mode changes the generated entry, so
  the watcher must treat a new `tools/` file as a rebuild trigger; disk mode gets
  it free from a fresh scan per boot.
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
