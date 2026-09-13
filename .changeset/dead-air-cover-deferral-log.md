---
"@alexkroman1/aai-runtime": patch
---

Log when the dead-air cover DEFERS, not only when it fires.

**A deferral was invisible, and it is the same silence the firing log exists to make answerable.** When the caller is talking — or a tool is speaking its own declared lines — the cover re-arms rather than speaking across the gap, which is right. But a deferral speaks no words, records no history and sends no client frame, so from outside a STARVED cover (a predicate stuck true, re-arming forever) and a cover that was never armed are the identical observation: nothing at all. Measured on a graded tau2-bench retail run: **19 of 45 first-token stalls over 5 seconds produced no cover line — up to 15.2s of dead air each — and the log could not say which of the two had happened**, so the investigation ended in a hypothesis rather than a cause. `Pipeline dead-air cover deferred` carries the reason (`caller-speaking` / `tool-covering`), the window that actually elapsed, and a CONSECUTIVE deferral count; consecutive rather than cumulative because the number exists to spot starvation, and a gap repeatedly filled by the caller and then covered is healthy.

**Behaviour is unchanged, deliberately.** The two candidate fixes this points at — a first-token deadline, and an explicit `maxRetries` on the LLM request — are behaviour changes on a live call, and there is no measurement yet that says which of them the stalls need. The same split the turn-latency trace was landed under.

`createDeadAirCover` is its own module now (`transports/pipeline-dead-air.ts`): the timer, the backoff, the phrase cycle and both log lines, behind a seam of three callbacks — speak a filler, has the model spoken, is the gap already filled. `pipeline-stream-parts.ts` sat at 495 of the 500-line source cap with no room for the line above, and is 345 now. It also comes off the no-co-located-test allowlist: the cover had no spec of its own, and the starvation case is one that cannot be observed through anything but the line it asserts (A/B verified — removing the log fails exactly the five specs that describe it, and neither of the two that describe what was already there).
