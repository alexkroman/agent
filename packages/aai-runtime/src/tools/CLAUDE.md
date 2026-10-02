---
summary: >-
  Tool execution: toolsets, `withToolsDir`, the tool-result message, error
  classification, `clientTool`, tool speech
read_when: >-
  editing anything under `src/tools/`
---

# aai-runtime `tools/`

Package-wide rules are in [`../../CLAUDE.md`](../../CLAUDE.md); the flat `src/`
modules' in [`../CLAUDE.md`](../CLAUDE.md). Outside this directory, import its
`index.ts` only (`guard-invariants` rule 37).

## Tools

### Every tool source is a `Toolset`, and the executor reads nothing else

`agentToolsToSchemas` and `executeToolCall` consume `Toolset`s
(`aai/sdk/toolset.ts`): `agentToolsets(agent)` (files, then `agent.toolsets` —
the roster's, MCP's — each layered with the dialogs' gates), then the
`"builtin"` set LAST from `mergeBuiltinSurface`. `createToolDispatcher` composes
them first-wins, the same table the schemas were drawn from.

- **`executeToolCall(name, args, { toolset })`**: entry lookup
  (`reason: "unknown_tool"`), schema (`"invalid_arguments"`), context, cancel
  check (`"cancelled"`), then `toolset.gate` — a refusal is the result, the body
  never runs — then `toolset.execute` under the entry's deadline.
- **No gate lives in a wrapped `execute`** except `dialog.tool`'s own re-check
  (for a spec calling it directly); a roster entry's tools are the author's
  defs.
- **The executor is the ENTRY's** (`ToolsetEntry.executor`), set by `toolEntry`,
  the one function that reads the `clientTool` brand.
- MCP attaches an `"mcp"` toolset after the agent's (`withMcpTools`), so a
  remote tool can never shadow an authored one; a subagent's map is a
  `"subagent"` set.

### ONE call core runs every transport's tools

`runToolCall` (`run-tool-call.ts`) is a single call: coerce the arguments to the
declared schema, snapshot the history, run the `beforeExecute` hook, call
`executeTool`, record the result, and return the model's copy (record
collections as rows). The pipeline's `to-vercel-tools.ts` (inside `streamText`)
and S2S's `../session/tool-steps.ts` (on `tool.called`) both call it. Never
re-implement a step in a caller.

- **A rejection is rethrown untouched, with nothing recorded.** What it BECOMES
  depends on the transport (the `fatalTool` capability): the pipeline latches
  it, and S2S answers the call with a serialized failure.
- **`executeTool` starts synchronously when there is no hook.** An `await` on
  nothing yields a microtask, and a barge-in in that gap would abort a signal
  the tool never saw.

### Tool discovery off the platform

`withToolsDir(def, dir)` (`tools-dir.ts`) turns a DIRECTORY into a tool registry
for a plain Node process (no bundler to glob). It is here because it needs
`node:fs` and dynamic `import()`, and the SDK must stay browser-loadable.

- **It adds a source, never a second set of rules** — naming, spec skip,
  nested-file error, default-export checks and collisions stay in
  `toolRegistry`; the attach stays in `withTools`. `sdk/tool-registry.ts`'s
  module doc states the invariant (every source arrives as `path → module`).
- Module keys are RELATIVE to the scanned directory (an absolute key under a
  directory not named `tools` would read as a nested file).
- The scan is recursive so a nested file hits the nested-file error rather than
  being silently absent; a MISSING directory throws.

### A settled tool call writes a `role: "tool"` message, and the shape has ONE home

- **Build it with `toolResultMessage()` (`result-message.ts`), never a
  literal.** It caps the result, which keeps live and resumed histories
  byte-identical; every producer (`to-vercel-tools.ts`,
  `../text-agent/agent.ts`, `../session/tool-steps.ts`,
  `../session/event-history.ts`) goes through it.
- **Read the arm by ROLE, never by the presence of a field** — a completion
  whose `tool.called` fell off the event log has no name.

The two SILENT traps (resume anchors index the client-visible list;
`toModelMessage` maps non-`user` roles to `assistant`, hence `isLlmSeedable`)
are in [`../../TOOL-OUTCOMES-CLAUDE.md`](../../TOOL-OUTCOMES-CLAUDE.md).
Author-facing account: `packages/aai/src/sdk/CLAUDE.md`, "`ctx.generate`,
`ctx.messages`, `ctx.delegate`".

### A tool's throw is CLASSIFIED, and only the author can call one FATAL

`execute` RETURNING a `ToolFailure` means "the model can recover"; a throw is a
bug; `ToolDef.onError` says which kind. `error-policy.ts` decides
(`resolveToolError` → `default` / `recovered` / `fatal`). A tool with no
`onError` behaves as if the field did not exist.

- A fatal verdict stops the turn in pipeline and text mode through
  `FatalToolLatch` (the AI SDK swallows the rejection). `withFatalSignal` folds
  it into the REQUEST signal, never the turn's, or it reads as a barge-in.
- **S2S cannot abort** and degrades to a serialized failure — the `fatalTool`
  capability, warned once at session start for an agent whose tools declare
  `onError`.
- **The wire's `fatal` stays `false` for both arms**: `fatal: true` means the
  SESSION is over and `aai-ui` ends the call.
- The four guard rules are in
  [`../../TOOL-OUTCOMES-CLAUDE.md`](../../TOOL-OUTCOMES-CLAUDE.md).

### A `clientTool` is answered by the PAGE, over the wire host mode already speaks

`clientTool()` (SDK) is an ordinary `ToolDef` carrying a brand (its
`timeoutMs`), which `toolEntry` turns into a `"client"` entry with that
deadline. The self-hosted dispatcher in `../runtime/tools.ts` hands each call
its wait on `client-tool-broker.ts`, keyed by (session, `toolCallId`), as
`clientCall`; `executeToolCall` binds it onto the `ToolContext` only for a
`"client"` entry, after the gate, and the tool's own `execute` calls it. The
session emits `tool.called` / `tool.completed` as for any tool; the page's
`tool_result` reaches the broker through `ServerSessionOptions.clientTools`,
which `../session/core.ts` consults only when there is no relay (`onToolResult`
owns every `tool_result` in host mode).

- **The wait rides the CONTEXT, never a swapped `execute`**: a `dialog.tool`
  around a `clientTool` calls the inner `execute` itself (the gate and
  transition bracket it), and replacing the outer `execute` would skip both.
- **`ctx.delegate` strips `clientCall`** — a subagent's tools must not wait on
  the parent's call id.
- **An answer may beat its wait** (neither transport orders `tool.called` after
  the executor starts), so the broker HOLDS an unmatched answer, bounded
  runtime-wide (`MAX_EARLY_ANSWERS`, oldest evicted), never swept per session.
- **The brand and the per-call wait are registered boundary keys**
  (`clientTool`, `clientToolCall` in the SDK's `_boundary.ts`): the bundle and
  this runtime hold two SDK copies ("The bundle/runtime boundary" in
  `packages/aai/CLAUDE.md`). Read the brand only through `clientToolBrand`,
  whose one caller is `toolEntry`.

### A tool can SPEAK, and a filler line may not open the barge-in gate

`ToolDef.messages` declares `start`, `delayed`, `complete` and `failed` lines;
`messages-runner.ts` speaks them from inside `execute` (`to-vercel-tools.ts`);
the design is on `aai/sdk/tool-messages.ts`.

- **A `role: "assistant"` completion means the model is NOT called again.** The
  line latches `ToolSpeechController.verbatim()`, which `startLlmStream` folds
  into `stopWhen`. The sentence is in no step's response, so `consumeLlmStream`
  APPENDS it to the turn's messages; the latch is per TURN (`beginTurn()` clears
  it).
- **Filler goes out `record: false`, and nothing here may abort anything.**
  Every line goes through `ToolSpeechChannel.speak` → `speakInReply`
  (`../transports/pipeline/reply/lines.ts`), the dead-air cover's placement, so
  it is separated from the words around it. START/DELAYED lines use the dead-air
  flag that `HeardTracker.spokeRecordable()` reads, so filler alone never makes
  a turn interruptible. The runner owns no signal, cancels no TTS, flushes
  nothing; a `blocking` wait is an ESTIMATE of spoken length bounded by
  `pTimeout`, never a TTS acknowledgement (touching the reply's lifecycle is
  what once muted an agent for 20+ s).
- The generic dead-air cover stands down while a tool covers its own gap
  (`toolCovering` in `../transports/pipeline/reply/stream-parts.ts`).
