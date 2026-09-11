---
"@alexkroman1/aai": minor
---

A FAST/SLOW two-tier architecture, behind `agent({ twoTier })` and OFF by default.

The shape is Pine AI's TalkAct: a cheap conversational model holds the call while an expensive one does the work. Their problem statement is the one a voice agent with tools always has — a frontier model driving a task takes seconds per step (they measure p50 4.2s) and natural conversation wants a reply inside one — and their measurement is p50 **0.63s** against **10.89s** for the same model doing both jobs, at 8/8 task success either way.

**The fast tier gets no tools at all.** Not "is asked not to mutate" and not "its mutating calls are reviewed": with `twoTier` declared, the request carries no tool list, so the only tier that can change anything is the slow one — guaranteed by the request rather than by a policy. That is also what makes a small conversational model usable as the fast tier, several being tool-free by capability.

Three couplings, each landing on plumbing this SDK already had rather than a channel invented for the feature:

- **The state digest.** The slow tier writes a rolling summary as a mandatory `state_summary` argument on every tool call — TalkAct's mechanism, and the reason it costs nothing — rendered into the fast tier's system prompt through the same suffix seam `dialog()` uses. So the fast tier is grounded on a turn where no tool ran, which is exactly the turn a caller asks "so it's all set?".
- **`ask_user` / `tell_user`** are `Transport.injectTurn`, the verb that already existed for "a durable run finished, tell the caller". The return path is the session's own transcript, relayed unconditionally — so the fast tier is asked for no text protocol, which is what TalkAct's two queues and three scaffolding-stripping regexes exist to work around.
- **Digest-gated completion.** A tool declared `completes` is REFUSED while the digest holds unsettled work, and the refusal names what is outstanding. This is the half of TalkAct's contract that was a prompt rule there — written after early versions "hallucinated 'it's submitted!' and hung up" — and it is aimed at a failure mode measured by name on tau2: the agent says "I've updated your address" with no tool call behind it.

`ToolDef` gains `mutates` and `completes`, both optional DECLARATIONS rather than heuristics over a tool's name. That is the classification SABER (arXiv:2512.07850) measures: each additional deviation on a mutating step cuts the odds of success by up to 96% on τ-bench Retail and up to 92% on Airline, while deviations on non-mutating steps have little to no effect. They ride on `ToolSchema` too, so a deployed agent's gate classifies the same tools `aai dev`'s does.

`twoTier.effort` is a first-class knob because the one published ablation on a second reasoning tier of this shape attributes its gain to the reasoning BUDGET rather than to prompt wording. No effect size is claimed for it here.

**Nobody waits for the slow tier.** It runs detached from every turn, so failing open is a property of the shape rather than a policy — there is no branch in which a hung second model makes the caller wait, which is the failure this repo has measured as 63 seconds of silence across four caller utterances.

Omit `twoTier` and every path behaves exactly as it did: one model with its own tools, no digest, no second request, the same prompt bytes. That is a measurement requirement, not caution — the published numbers behind this design are single-trial or measured against a different user simulator, so the two arms have to be comparable inside one build.

One fix falls out and applies to every agent: a request with no tools now omits the `tools` key entirely rather than sending an empty one, which several small models refuse outright (the AssemblyAI gateway answers `400 … does not support tools`).
