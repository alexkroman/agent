---
"@alexkroman1/aai": patch
---

Harden the default voice-agent prompt against failure patterns seen in tau2-voice runs (all voice-/behavior-specific; defers policy/identification specifics to the host-injected domain policy):
- On a failed lookup of a spoken value (name, email), stop retrying the mis-heard value — ask the customer to spell it, confirm, then retry; otherwise use another identification method the policy allows.
- Ask the customer to repeat anything not clearly caught instead of acting on a rough transcription.
- Vary turn openers instead of repeating the same acknowledgment.
- Treat a non-argument tool error (e.g. "order cannot be modified" because it isn't pending) as a signal to re-read the record's state and switch to the allowed action — never repeat the same tool call with the same arguments, which otherwise loops into a too-many-errors termination.
