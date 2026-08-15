---
"@alexkroman1/aai": major
---

Session state is durable: a sessionSlot owns its own value and stores it, over Postgres when the app has a database and memory otherwise. `ctx.state` and its `any` are gone, along with `AgentDef.state`, the state type parameter on `ToolContext`/`ToolDef`/`AgentDef`, `InferAgentState` and `SlotState`/`SlotStateOf`. `slot.update` is synchronous and hands the body a mutable draft that is committed when it returns; `slot.get` returns a frozen `Readonly<T>`; `syncState` takes `slot.projection(view)`, which is callable so a client derives its own empty state from the same function.
