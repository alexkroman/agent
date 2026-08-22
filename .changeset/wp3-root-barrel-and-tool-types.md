---
"@alexkroman1/aai": major
---

Make `InferToolOutput` actually infer, curate two constants off the root barrel, and name the session event types.

**`ToolDef` and `tool()` take a second, defaulted type parameter `R`.** `execute` was declared `Promise<unknown> | unknown`, so a tool body's real return type was erased at the `tool()` call and `InferToolOutput<typeof myTool>` resolved to `unknown` for every tool in existence — a published inference helper whose own doc promises `useToolResult` a single source of truth and delivered none. `ToolDef<P, R>` captures it, `R` defaults to `unknown` so `ToolDef<typeof schema>` keeps its old meaning, and a sync body and an `async` one now infer alike. Source-compatible: every existing annotation still compiles, and the frozen epoch-9 authoring example compiles unchanged. `tool()`'s parameter is now declared as `ToolDef<P, R>` rather than re-stating the shape inline, so the reference finally shows that `execute` takes `(args, ctx)`.

**BREAKING — `ASSEMBLYAI_S2S_KIND` and `ASSEMBLYAI_S2S_API_KEY_ENV` are no longer exported from `@alexkroman1/aai`.** They reached the root only through an `export *` and fail the barrel's own membership test: an `agent.ts` writes `s2s: assemblyAIS2s()` and never names either — the descriptor sets the kind, and credentials resolve server-side. Import them from `@alexkroman1/aai/s2s`, where their eleven `*_KIND`/`*_API_KEY_ENV` peers already live. Nothing else moved.

**New: `SessionEventType`**, the union of every name an `agent({ events })` map may be keyed by. The key set was previously readable only inside the wire schema's own type expression.

Also in this release, all documentation:

- The root entry point now renders as a module page with orientation and a subpath map instead of opening on `KeyedLockTimeoutError`, and `dialog()`, `procedure()` and `workflow()` each state the rule for choosing between the three.
- Both `@alexkroman1/aai/testing` examples that called `agent()`'s default export directly — which always throws, because a tool is a file — route through `withDiscoveredTools`, and `toolOf` now says so when the tool record is empty.
- `AgentDef` says it is what `agent()` returns rather than what you write, and each `*AgentParams` arm says its long string-literal field types are compile-error messages, not accepted values.
- `DEFAULT_GREETING`, `DEFAULT_SILENCE_PROMPT` and `DEFAULT_START_FAILURE_PHRASE` render their actual text instead of `string` (values unchanged), and `DEFAULT_SYSTEM_PROMPT` documents its five sections and how to extend rather than replace it.
- The README lists every published subpath by who reads it, gains a "Testing an agent" section, and shows a multi-field `agent()` configuration.
- Published doc comments no longer navigate by repo-internal file path or name `@internal` symbols a consumer cannot import.
