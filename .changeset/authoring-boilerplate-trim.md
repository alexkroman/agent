---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": minor
"@alexkroman1/aai-cli": minor
---

Less authoring boilerplate, backward-compatibly:

- `agent({ syncState })` takes a slot projection or a list of them
  (`syncState: cartSlot.projected`, `syncState: [cartSlot.projected, prefsSlot.projected]`).
  The record form `{ cart: cartSlot.projected }` still works and is deprecated;
  `agent()` still returns the record keyed by slot name.
- One way to project a slot: declare the view on the slot
  (`sessionSlot(key, create, { view })`) and pass `slot.projected` at both ends.
  `slot.projection(fn)` is deprecated.
- `AgentDeclaration` is the authored field reference; `AgentDef` (what `agent()`
  returns) extends it with the resolved-only `tools`/`toolsets`.
  `WorkflowAppAgentParams` replaces the deprecated `StaticAgentParams`, and
  `AgentInstructions` is deprecated in favour of `AgentSystemPrompt`.
- The deploy preflight and `aai dev` derive each MCP server's `tokenEnv` and the
  keys of `brave_search`/`google_places`/`text_me` into the env check, so they no
  longer need repeating in `requiredEnv`.
- Actionable errors for a partial provider triple, a missing mount element, an
  unknown upload id and failed `aai login` responses.
