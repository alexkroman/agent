---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Close the API-parity gaps found by comparing the authoring surface against the Anthropic Agent SDK, OpenAI Agents SDK, Mastra and Pydantic AI. Everything here is additive — no published type was renamed and no epoch was dropped.

**`ctx.messages` has a real third arm.** `Message.role` has always included `"tool"` and nothing ever produced one, so a tool could see every word of the call and nothing any tool had returned. A settled call now contributes `{ role: "tool", content, toolName?, toolCallId? }` in all three modes and on resume, capped so a live history and a resumed one are the same history. Read the arm by role — the two id fields are optional.

**Per-tool error classification.** `ToolDef.onError` (and `dialog.tool`, `slot.tool`, `slot.updateTool`) turns a throw into either a result the model may recover from or a fatal failure that stops the turn. Previously every exception — a bad credential, a bug in the tool body — was serialized back to the model and retried until `maxSteps` burned. A tool with no `onError` behaves exactly as before.

**Agent-level guardrails.** `inputGuardrails` / `outputGuardrails` on `agent()`, reusing the subagent `GuardrailVerdict` vocabulary. The output guardrail holds a reply at the single TTS funnel and can discard it unspoken. Pipeline-only: s2s has already spoken the sentence and text mode owns no funnel, so both are refused by name at config time rather than silently doing nothing.

**Dynamic instructions.** `systemPrompt` accepts `(ctx: AgentSessionContext) => string`, resolved per model request. A project carrying a `system-prompt.md` can now use one — `withSystemPrompt` passes a resolver through instead of throwing, and its string-case error no longer suggests a remedy that never worked.

**Host-side usage accounting and budgets.** `usageLimits: { totalTokens }` plus a `usage.updated` session event. The meter counts the conversational loop, `ctx.generate` and `ctx.delegate`/subagents, and is checked at every spend site; durable workflow steps and s2s stay uncounted and say so on the field.

**Agent/subagent parity.** `description`, `maxOutputTokens`, `maxRetries` and `resetToolChoice` on `agent()` — the subagent had several of these and the agent did not. All five model-tuning knobs are refused in s2s mode, where this runtime never assembles the request.

**One vocabulary for delegation.** The `delegate` tool's input key is `subagent`, matching the `subagents` field and the `SubagentDef` type; it was `coworker`. This changes the tool's JSON schema, not any TypeScript type.
