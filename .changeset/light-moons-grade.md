---
"@alexkroman1/aai-runtime": minor
---

Publish the TEXT-AGENT eval harness on `@alexkroman1/aai-runtime/eval`: `openEvalTextAgent({ agent })` stands up a real `createTextAgent` — the resolved model, the real tool executor, `ctx` and its slots, the step budget — and hands back a `send()` that returns the `EvalTurn` it provoked, plus `sendAll`, `events()`, `said()` and `toolCalls()`. The sibling of `openEvalSession`, which structurally cannot serve a text agent because `createRuntime` refuses `text: true` by name, and deliberately the same shape: the turn record, the event readers and every assertion above them are shared rather than reimplemented, since a text agent emits the same `SessionEvent` union.

A turn ends on a real terminator rather than a timer, and here that is structural: the harness consumes the turn's own stream, so `reply.completed`/`reply.cancelled` has passed through by the time `send()` resolves and the next message cannot be sent inside the previous turn. One agent per conversation, so `ctx.state` and the model's view of the history carry across turns; a turn nothing about the agent can be read off (the model stream failed, or a tool was called the agent has no definition for) throws instead of reporting a reply that said nothing.
