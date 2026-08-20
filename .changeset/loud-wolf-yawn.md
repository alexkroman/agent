---
"@alexkroman1/aai-ui": minor
---

useAgentState now accepts a slot projection directly: `useAgentState(cartProjection)` infers the state's type from the projection and derives the pre-first-push frame by running it, memoized on the projection's identity. This closes a round-trip authors were wiring by hand — the projection had to be composed at both ends (`syncState` on the agent, again in the client) with nothing checking that the two named the same view, the empty frame was derived with `slot.projection(view)(undefined)`, and the state's type was restated three times. The two existing overloads are unchanged; prefer the `fallback` one only when a slot's `create()` is expensive to import into the browser, since the projection overload calls it.
