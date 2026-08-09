---
"@alexkroman1/aai": patch
---

Add `omitUndefined()` to `@alexkroman1/aai/utils` — the one way to build the optional half of an object under `exactOptionalPropertyTypes`, replacing 41 hand-written `...(x !== undefined ? { x } : {})` spreads. Also annotates `StartScreen`'s return type, so the published declarations no longer carry an inferred union leaking React's `JSXElementConstructor`.
