---
"@alexkroman1/aai": patch
---

Teach the default agent prompt to recover from non-argument tool errors instead of looping. A state error (e.g. "order cannot be modified" because it isn't pending) now instructs the agent to re-read the record's status and switch to the action the policy allows — never to repeat the same tool call with the same arguments, which previously looped into a too-many-errors termination in tau2-voice runs.
