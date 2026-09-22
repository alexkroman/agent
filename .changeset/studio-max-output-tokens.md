---
"aai-guest-core": patch
"aai-guest-studio": patch
"aai-studio-server": patch
---

Set the studio agent's output-token ceiling, and stop a truncated step failing silently.

The coding agent kept stopping mid-build with nothing wrong on the server, and it worked before the AI SDK bump. **`ai@7.0.70` is where that changed.** `isToolExecutionAllowedFinishReason` now runs a step's tool calls only when the step finished `stop` or `tool-calls`; any other finish reason drops them unexecuted. No tool result means no continuation, so the turn ends — and from outside it is indistinguishable from the agent deciding it was done. Before that version the call still ran.

The finish reason that reaches this in normal use is **`length`**: the step hit its output ceiling mid-tool-call. Which brings up the setting that was never made — **the studio agent set no `maxOutputTokens` at all**, and unset is not "no limit", it is whatever the gateway picks. A coding agent that writes a whole source file inside a tool-call argument is exactly the shape that reaches such a ceiling, and the two facts together turn a routine truncation into a turn that stops dead.

So the ceiling is explicit now (32k, threaded host → session-init → `agent()` beside `maxSteps`). Sized against the JOB rather than the model — 32k tokens is ~128 KB, far more than any file written in one step — and deliberately NOT any model's true maximum, because the gateway serves a catalog (`STUDIO_LLM_MODELS`) whose smaller members would 400 on a value sized for the largest. `STUDIO_MAX_OUTPUT_TOKENS` overrides it, so tuning is a secret edit rather than a guest-image rebuild — which matters because the value is read on the server and spent inside the sandbox.

**A bad override falls back rather than reaching the provider**, empty string included: the whole point of the setting is that an out-of-range ceiling truncates a step, and a truncated step now loses its tool calls, so handing the model call a `NaN` would cause the exact failure being fixed.

**And the silent stop is named.** `onStepFinish` logs any finish reason outside `stop`/`tool-calls` with the number of tool calls discarded. A larger ceiling makes truncation rarer, not impossible, and the reason this took so long to find is that there was nothing in the log to find — the next occurrence is answerable from the server instead of inferred from a chat transcript.

This does not replace the keep-going force added alongside it; that covers a model that chooses to stop, where this covers one that was cut off.
