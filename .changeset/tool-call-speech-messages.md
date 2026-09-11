---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Add `ToolDef.messages` — what a tool says while it runs, and the outcome that answers without the model.

A port of Vapi's tool `messages` design. Four kinds per tool, declared beside
`execute` and normalized onto the wire `ToolSchema`, so the feature means the
same thing under `aai dev`, in a deployed guest and in host mode:

- **`start`** — spoken as the call begins. `start: true` draws from
  `DEFAULT_TOOL_START_PHRASES` (Vapi's own five); several entries are VARIANTS
  and one is drawn per invocation, so a turn calling three tools does not say
  the same sentence three times. `blocking: true` holds the call until the line
  has been spoken, bounded at `TOOL_START_BLOCKING_MAX_MS` by a `pTimeout` at
  the call site.
- **`delayed`** — `afterMs` from the start of the call. **Same timing means
  variants; different timings mean STAGED updates**, so 3000/3000/8000 is a
  two-rung ladder with a coin flip on the first rung's wording, and the rungs
  fire at 3s and 8s rather than 3s and 11s.
- **`complete`/`failed`** — the role switch, and the reason this is worth
  having. `role: "assistant"` is spoken verbatim and **the model is not called
  at all**: the line latches and `startLlmStream` folds that latch into
  `stopWhen`, so a deterministic outcome costs zero further LLM round-trips.
  `role: "system"` is the other arm — the content rides back with the tool's
  result as a hint and the model writes the sentence, which is almost always
  the better answer for a failure.

All four take `when` conditions over the call's ARGUMENTS (Vapi's six
operators), so one tool can say a different thing for a refund than for a
lookup.

**Filler cannot cost a caller a reply, which is the invariant the dead-air
cover already paid for.** `start` and `delayed` go out `record: false` — the
flag `HeardTracker.spokeRecordable()` reads — so a turn that has played only
tool filler still cannot be spoken over, and neither line reaches
`ctx.messages`, the model's view or a committed transcript. The runner owns no
signal, cancels no TTS and flushes nothing: a `blocking` start waits out the
line's ESTIMATED length rather than a provider acknowledgement, deliberately,
because waiting on the TTS session means touching the lifecycle of the reply in
flight. Vapi's "idle messages are disabled during tool calls" is here too — the
generic dead-air cover stands down while a tool is covering its own gap, rather
than speaking a second, generic sentence about one silence.

`quickstart-agent`'s `get_weather` is the worked example. Eight `aai`
capabilities are bumped with their previous epoch retained: `ToolDef` gained an
optional field and appears in all eight reports.
