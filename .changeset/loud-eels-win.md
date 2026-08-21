---
"@alexkroman1/aai": minor
---

Add graph() — run a state machine to completion as one unit of work inside a tool call, the sibling of flow(). A flow is where a conversation is (persisted in a slot, moved by the caller's turns); a graph is one piece of work (never stored, driving itself through invoked actors). run(input, { signal }) takes ctx.signal so a long multi-stage loop stops on a barge-in, and rejects with GraphNotFinishedError for a run that did not finish — xstate's own toPromise resolves undefined for a stopped actor, which hands a half-built output back typed as a finished one.
