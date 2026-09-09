---
"@alexkroman1/aai-runtime": minor
---

`describeEval` now refuses a `stubReply` that calls a tool the agent does not declare, and says so when the agent declares none.

A tool is a FILE, so `agent.ts`'s default export carries an empty tool table and `virtual:aai/agent` is the lowered agent that carries the real one. Handing `describeEval` the authored def used to be accepted silently: the suite booted, the scripted model emitted a `tool-call` nothing served, and the case failed dozens of lines away on `expected [] to contain 'look_up_order'` — the symptom, with the cause on the `describeEval(...)` line. `toolRunner` has refused the same mistake at bind for a while; this is that guard for the other door.

Two halves. A `stubReply` step naming an undeclared tool now throws at case DECLARATION, naming the case, the bad tool and the tools the agent does declare — plus, when it declares none, the same import remedy `toolRunner` gives. There is no legitimate reading of that shape, so the throw has no false positives. Complementing it, a suite over an agent declaring no tools and no workflows prints a line on the same channel as the mode announcement; that is a WARNING and must stay one, since a purely conversational agent is a legal eval target and a live run has no script to inspect.

Minor rather than patch because a suite can now fail to collect where it used to run. The only suites that can is one whose scripted tool calls were reaching nothing — i.e. one that was already measuring nothing and passing.
