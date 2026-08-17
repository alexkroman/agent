---
"@alexkroman1/aai": patch
---

Fix the README examples: the SDK README documented `ctx.state`, `agent({ state })` and `agent({ tools })`, none of which exist — a reader following it wrote code that does not compile and that `agent()` throws on. Replaced with the `sessionSlot` + tool-is-a-file shape. The aai-ui README passed an ELEMENT to `client({ sidebar })`, which takes a component.
