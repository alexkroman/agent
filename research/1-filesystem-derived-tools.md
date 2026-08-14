---
issue: TODO
status: implemented
last_updated: "2026-08-14"
---

# Derive the tool map from the filesystem

An agent's `tools` map restates, by hand, a naming rule the repo already
machine-checks. Six templates carry 52 tool files and 62 map entries whose
entire content is `snake_case_name: camelCaseImport`. This proposes deriving the
map at build time and deleting it from the authoring surface.

## Outcome: the diagnosis held; the mechanism needed correcting

**Discovery landed — no template carries a `tools:` map any more — but not by the
route this document proposed.** What landed:

- All 52 tool files **default-export** their tool, and the nine importing files
  take default imports. The `template-tools` konsistent convention is
  **retired** — with nothing importing by name, the export name is unobservable
  and the file name is a tool's whole identity.
- **The 62 map entries and their imports are gone**, from all six templates.
  Discovery is `aai-cli/worker-bundler.ts` enumerating `tools/*.ts` and emitting
  static imports into the generated entry — option (2) below — with
  `toolRegistry`/`withTools` (`sdk/tool-registry.ts`, on `@alexkroman1/aai/manifest`)
  owning the name grammar, the default-export requirement, the flat-only rule and
  duplicate detection. Each is a build error naming the file.
- **Every template that HAD a `tools/` directory now declares nothing else, and
  `pizza-ordering` grew one** — its six `orderSlot.tool()` calls were inline in
  `agent.ts`, which is now three fields and no mention of tools. Seven templates,
  65 files.

  **Six templates still declare tools inline and are NOT converted**:
  `health-assistant`, `embedded-assets`, `infocom-adventure`, `night-owl`,
  `recap-desk`, `research-desk`. This document's table only ever counted the
  templates that had a `tools/` directory, so they were missed by its measurement
  as well as by the first pass of the work; converting them belongs with
  `tools-off-the-agent-def.md`, which is where the param goes away and where
  "a tool is only ever a file" becomes true rather than conventional.
- `agent({ tools })` still EXISTS and
  `withTools` merges rather than replaces, so the param is unused by the templates
  rather than gone; removing it from the authoring surface is
  `tools-off-the-agent-def.md`, which also has to convert the studio's own text
  agent (its tools close over per-session deps, so they need a session slot first).
- A spec has no bundler, so `aai-templates/_tool-discovery.ts` does the same
  lowering with `import.meta.glob` — deliberately not a `readdir` + `import()`,
  which would resolve the tools through Node instead of vitest and hand them a
  second copy of the SDK.

**The correction that mattered was WHERE the derivation may live**, and it is
recorded under "The mechanism is build time, not runtime" below: the entry
generator was the right seam, and the assumption to check was not whether it can
read the project directory but whether every loader of `agent.ts` goes through
it. Two do not — `scaffold/server.mjs` and vitest — which is why the templates'
specs resolve tools explicitly, and why self-hosting is being moved onto a build
step (`tools-off-the-agent-def.md`) rather than given a second scanner.

Two things this document got right and are worth keeping: naming the silent
failure as the motivation rather than the line count, and reading eve as prior
art. Its summary of eve was incomplete in the one way that mattered — see the
same section.

## The duplication, measured

| template | files in `tools/` | `tools:` map entries |
| --- | --- | --- |
| retail | 15 | 16 |
| dispatch-center | 12 | 13 |
| travel-concierge | 10 | 16 |
| solo-rpg | 8 | 8 |
| plan-desk | 4 | 5 |
| support-line | 3 | 4 |
| **total** | **52** | **62** |

(Where entries exceed files, the extra tools are declared inline in `agent.ts`
rather than in `tools/` — see "What inline tools mean for this" below.)

`dispatch-center/agent.ts` is representative: 15 import lines followed by

```ts
  tools: {
    incident_add_note: incidentAddNote,
    incident_create: incidentCreate,
    // …ten more
  },
```

**Every one of those lines is derivable, and the derivation is already
enforced.** `konsistent.json`'s `template-tools` convention:

> A `tools/` file is named for the snake_case tool name the LLM sees (Biome's
> filename convention is overridden for exactly this reason) and exports one
> const named for it in camelCase.

```json
"paths": "packages/aai-templates/templates/{templateName}/tools/{toolName}.ts",
"must": { "exportConstants": ["${toolName.toCamelCase()}"] }
```

So the file name IS the tool name, the export name IS a function of the file
name, and CI fails if either drifts. The map adds no information; it is a
transcription of a checked rule, written 62 times.

## What it costs today

- **A forgotten registration is silent.** Add `tools/incident_close.ts`, satisfy
  konsistent, and forget the map line: the file compiles, exports correctly,
  passes every gate, and the tool simply never reaches the model. There is no
  error anywhere — the agent just cannot do the thing. This is the failure mode
  that motivates the change; the line count is secondary.
- **It is the one place snake_case and camelCase have to be spelled together**,
  so a typo (`incident_add_note: incidentAddNotes`) is a compile error only if
  the wrong identifier does not exist elsewhere.
- **Biome's filename convention is overridden for this directory** to permit
  snake_case, which only makes sense because the filename is load-bearing — and
  the map is what currently makes it *not quite* load-bearing.

## Prior art: eve derives names from paths as a stated principle

`~/Code/eve`'s `AGENTS.md`, coding principle 7:

> **Derive names from file paths.** Connection names, tool names, and similar
> identifiers come from the filesystem path (e.g. `agent/connections/linear.ts`
> → `"linear"`). Do not add redundant `name` fields to definitions.

It applies the rule uniformly — `agent/tools/`, `agent/hooks/`
(`agent/hooks/auth/load-profile.ts` → `"auth/load-profile"`),
`agent/channels/` (file stem is the channel id), `agent/connections/`. Discovery
is the registration; there is no map anywhere.

## Design

`agent({ tools })` keeps working — it is how an inline tool is declared, and the
type inference on `ctx.state` flows through it. What changes is that a
`tools/` directory **beside `agent.ts`** is discovered and merged, so a project
declaring all its tools in files declares no map at all.

- **The tool name is the file's basename.** Nested directories join with `/`
  the way eve's hook slugs do, if we want them; the templates are flat today,
  so a first cut can require flat and reject a nested file with a message rather
  than inventing a convention no template uses.
- **The export is the file's default export**, not a name-matched const.
  Requiring `export const incidentAddNote` keeps the camelCase half of the
  duplication alive for no benefit once nothing imports it by name — a default
  export makes the file's identity purely its path. This retires the
  `template-tools` konsistent convention: with discovery, the export name is
  unobservable, so there is nothing left to check.
- **A name declared both inline and as a file is a BUILD ERROR**, not a
  shadow. Precedence exists so that new code can override old code, and there is
  no old code here to override — so the two spellings of one tool name are a
  mistake, and the only question is which one the author meant. `builtinTools`
  keeps its own precedence rule ("a custom or relayed tool with the same name
  wins — the built-in is dropped") because there the shadowed thing is
  framework-supplied and overriding it is the intended act.
- **A discovered file that does not export a `ToolDef` is a build error naming
  the file.** Discovery moves this class of mistake from "silently absent at
  runtime" to "named at build time", which is the entire point.

### The mechanism is build time, not runtime

This is the one unknown worth settling before committing. The worker bundle is
built by the CLI's Vite/rolldown pipeline (`aai-cli/worker-bundler`), so
discovery has to happen where the bundle is assembled — the guest loads one ESM
artifact and has no directory to scan. Two candidate shapes:

1. **`import.meta.glob`** (Vite's own): the bundler expands it to static imports
   at build time. Cheapest, but it is a Vite feature and the generated entry
   would carry a Vite-ism into user-authored space.
2. **Generate the map in the bundle entry**, which the CLI already synthesizes
   (`toAgentConfig` runs "in the generated bundle entry"). The entry enumerates
   `tools/*.ts` at build time and emits the imports plus the map. No user-facing
   bundler feature, and the generated code is inspectable.

Prefer (2): the entry is already generated and already the place where the
agent's config is materialized, so this adds a step to an existing seam rather
than a new mechanism. Confirm the entry generator can read the project
directory before committing — it is the one assumption this rests on.

**That was the wrong assumption to check.** The entry generator can read the
project directory — `buildWorker(cwd)` writes `.aai/worker-entry.ts` there
already, so (2) is mechanically easy. The assumption that mattered is that
**every consumer of `agent.ts` goes through the bundler, and three do not:**

| Consumer | Path to `agent.ts` | Sees a bundle-entry map? |
| --- | --- | --- |
| `aai dev`, `aai publish` | `buildWorker` → generated entry | yes |
| `scaffold/server.mjs` (`npm start`) | `await import("./agent.ts")` | **no** |
| `templates.test.ts` | `import.meta.glob("./templates/*/agent.ts")` | **no** |
| each template's `agent.test.ts` | `runTool(agentDef, name)` reads `def.tools` | **no** |

Self-hosting is the scaffold's DEFAULT (`packages/aai-templates/CLAUDE.md`,
"Self-hosting is the scaffold's default"): `server.mjs` ships in every project
and advertises "no CLI at run time, no bundler". So (2) yields an agent whose
tools are present under `aai dev` and `aai publish` and **absent when
self-hosted** — the same silent absence this document opens by objecting to,
one level worse, since it takes every tool at once instead of one. It also
empties `def.tools` for the four template specs that drive tools through the
agent's own table.

Option (1) is no better: `import.meta.glob` is a Vite syntax transform, so it
covers dev, deploy and vitest and dies under plain Node — `server.mjs` would look
for a file literally named `tools/*.ts`. A `registerHooks` shim cannot save it;
teaching Node the construct means expanding it in a `load` hook, i.e. shipping a
transformer into the entrypoint whose whole selling point is that it has no build
step.

### What eve actually does, and the part this document's summary missed

`~/Code/eve` does generate a registry, and it is worth reading before the next
attempt (`packages/eve/src/compiler/module-map.ts:99`): a build-time `readdir`
whose output is **lowered into static import statements** in a generated
`.eve/compile/module-map.mjs`, which the bundler then follows.

- It is **gitignored and regenerated on every compile**, so drift is structurally
  impossible and there is **no `--check` gate** anywhere. A committed registry
  plus a staleness gate — the obvious first design here — is strictly worse.
- Tool files **default-export** (`export default defineTool({…})`, no `name`
  field), which is the half of this plan that did land.
- eve has **no filesystem at runtime in production** either
  (`artifacts-config.ts:33`: "routes require the artifacts bundled into the
  server at build time and never touch the filesystem"), so a runtime scan was
  never the answer for anyone.

**The reason it works there is that eve has exactly one way to load an agent:
compile it.** Dev and production both call `compileAgentInWorkspace`, and the
only difference is the import-specifier style (relative for disk, absolute for
bundled) out of one generator. This repo deliberately has two UN-compiled loaders,
which is the whole obstacle — not the bundler seam.

The second thing eve does differently is what a real fix here has to copy:
**tools are not on the agent def.** They live in a compiled manifest the runtime
resolves (`resolve-tool.ts:28`), and eve's own tests never import a tool module
to unit-test it — they install an in-memory synthetic registry
(`compile-from-memory.ts`) with `mockTool`. Our `runTool(agentDef, name)` and
`toolOf(agentDef, name)` read `agentDef.tools` synchronously, and a directory
scan is async, so `tools` cannot be on the def and be discovered. That is
`tools-off-the-agent-def.md`.

### What inline tools mean for this

Three templates declare more tools than they have files (`travel-concierge`
16/10 most notably), so `agent({ tools })` must remain. That is fine and is why
this is a merge rather than a replacement: a tool with a closure over
module-local state, or one built by a wrapper (`retail`'s `retailTool`), is
legitimately an expression rather than a file.

Worth checking during implementation whether those inline tools *should* be
files — if `travel-concierge`'s six are inline only because the map made a
seventh file feel expensive, discovery removes the reason.

## Scope

**Two of these landed and the rest did not** — see "Outcome" above. The default
exports and the retired convention are in; the discovery, the merge and the map
deletion are not, and the epoch bump was not needed because no published
signature moved.

| Change | Where |
| --- | --- |
| Discover `tools/*.ts` beside `agent.ts`; emit imports + map | `aai-cli` bundle-entry generation |
| Merge discovered tools with explicit `tools`; a duplicate name is a build error | `sdk/define.ts` or the entry, whichever keeps `S` inference intact |
| Build error for a file exporting no `ToolDef` | the same generator |
| Delete the `tools:` maps and their imports | 6 templates, 62 entries |
| Retire the `template-tools` convention | `konsistent.json` + its config test |
| Epoch bump for `aai:agent` / `aai:tool` as `--drop` | `contracts/` |

## Open questions

- **Does `S` inference survive the merge?** `tool()` learns the state shape from
  an annotated context and `agent({ tools })` is where `AgentDef`'s generic is
  fixed. If merging discovered tools in the generated entry weakens that, the
  merge belongs in `define.ts` with the discovered set passed in — settle this
  first, since it decides which file the merge lives in.

  **This is transitional, and the ceiling on how much it is worth is low.**
  `2-durable-session-state.md` removes `ToolContext<S>`'s generic and
  `AgentDef.state` outright, so after that plan lands there is no `S` to preserve.
  Do the cheapest thing that keeps the current inference working; do not build
  machinery to protect a generic that is scheduled for deletion.

Nested tool files are **rejected**, with an error naming the file — not given a
join convention. No template nests, so any convention picked now would be a guess
frozen into the discovery rule, and adding one later is a breaking change like
everything else in this series.

- **Does `aai dev`'s watcher pick up a NEW file?** Adding a tool file has to
  trigger a rebuild, not just a reload of changed modules — otherwise discovery
  makes the authoring loop worse than the map it replaces.
