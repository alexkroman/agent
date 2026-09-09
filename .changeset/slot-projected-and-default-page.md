---
"@alexkroman1/aai": minor
---

A slot can declare its view once. `sessionSlot(name, init, { view })` builds `slot.projected` at declaration, so `agent({ syncState: cartSlot.projected })` and `useAgentState(cartSlot.projected)` are the same identity-stable object. Passing `slot.projection(view)` at both ends meant repeating the view and, if the two ever drifted, the frame the browser saw before the first push disagreed with every frame after it. `projection(view)` stays for the multi-view case.

A workflow app needs no `client.tsx`. `mountPage`'s `component` is optional and defaults to a shell built from each workflow's own input schema — the listing, the fields, the run's progress and its result — and, more importantly, the prebuilt page an agent gets with no `client.tsx` at all now branches on its declared front door instead of always mounting the voice client. A workflow app previously got a start screen and then a websocket the server declines by design.

`createWorkflowApi` returns the full `AgentClient` (a documented superset), so a page gets `config()` without a second factory, and `fetchClientConfig()` defaults its URL to `pageBaseUrl()` from the same package.
