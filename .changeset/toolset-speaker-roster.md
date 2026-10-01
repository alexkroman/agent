---
"@alexkroman1/aai": major
"@alexkroman1/aai-runtime": major
"aai-server": patch
---

One `Toolset` under every tool source, and one `SpeakerDef` for subagents and personas.

- **`Toolset`** (`list()`, `gate(name, ctx)`, `execute(name, args, ctx)`) is the one shape a `tools/` file set, builtins, an MCP server, a roster and a delegated run's tools hand the runtime; `agentToolsToSchemas` and `executeToolCall` consume only toolsets, composed first-wins (`agentToolsets`, `composeToolsets`, `toolset` on `/manifest`). Who runs a tool is the entry's explicit `executor` (`"host"` or `"client"` for a `clientTool`). `AgentDef.toolsets` is RESOLVED — `agent()` mints the roster's, `withMcpTools` appends an MCP server's (it no longer merges remote tools into `tools`).
- **Refusals are one shape**: `ToolRefusal` is a `ToolFailure` plus `reason` (`unknown_tool`, `invalid_arguments`, `cancelled`, `persona`, `dialog`, `roster`), built with `toolRefusal()`. An unknown tool, bad arguments, a roster entry that is not on the line and a dialog tool out of state all answer it; a dialog's gate is `Dialog.gate`, layered over every toolset.
- **`speaker()` / `SpeakerDef` replace `subagent()`/`SubagentDef` and `persona()`/`PersonaDef`**, and **`roster([...])` replaces `personas([...])` and `agent({ subagents })`**: one list, where a `speaks: true` entry is put on the line by the minted `handoff` and the rest are handed a task by the minted `delegate`. Declare it with `agent({ roster })`. `Personas`→`Roster`, `PersonaPosition`→`SpeakerPosition` (`position.speaker`), `SubagentAnswer`/`SubagentToolCall`/`SubagentGuardrail`→`DelegateAnswer`/`DelegateToolCall`/`SpeakerGuardrail`, `ToolSet`→`ToolMap`. `runTool(agent, name)` runs a tool through its toolset's gate; `toolOf` is the plain lookup.
