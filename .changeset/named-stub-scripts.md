---
"@alexkroman1/aai": major
---

Build tool shapes from their source, and give the testing helpers narrow, named shapes.

- `SlotToolDef` and `DialogToolDef` are now built from `ToolDef` (`Omit<ToolDef, "execute">` plus their own `execute`), so slot-backed and dialog-gated tools can declare `messages` (tool-call speech) and every future `ToolDef` field. The dialog's `when`/`send`/`sendFrom` are the new `DialogGate` interface.
- New `ModelTuning` (`temperature`, `maxOutputTokens`, `maxRetries`), extended by `AgentModelTuning` and — without `maxRetries` — by `SubagentDef`. **Breaking:** the guardrail's revision budget `SubagentDef.maxRetries` is renamed `SubagentDef.maxRevisions`, and `DEFAULT_GUARDRAIL_MAX_RETRIES` is renamed `DEFAULT_GUARDRAIL_MAX_REVISIONS`. `subagent({ maxRetries })` is now a compile error whose message names `maxRevisions`, rather than a field that silently changed meaning; a subagent takes no provider-retry setting and retries on the AI SDK default.
- **Breaking:** stub scripts name their shape — `stubGenerate`, `stubDelegate`, `stubStepDelegate`, `installStubStepDelegate`, and `createToolContext`/`scriptedToolContext`'s `generate`/`delegate` take `{ reply }` or `{ routes }`. `StubGenerateRoutes` is removed; `StubDelegateScript` is new.
- `deployedAgent`, `commandedBuiltins` and `expectPromptBuiltinsDeclared` take structural shapes of only the fields they read, and `ToolContextOverrides` names each field explicitly.
