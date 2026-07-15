---
"@alexkroman1/aai": patch
---

Strengthen the default voice-agent prompt's ASR-robustness guidance (voice-specific; defers all policy/identification specifics to the host-injected domain policy). On a failed lookup of a spoken value (name, email), the agent now stops retrying the mis-heard value and asks the customer to spell it, confirms, then searches again — or switches to another identification method the policy allows. Also: ask the customer to repeat anything not clearly caught instead of acting on a rough transcription, and vary turn openers instead of repeating the same acknowledgment. Patterns adapted from LiveKit's voice-agent prompting guide.
