---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Continuation: when the caller starts speaking again within
`interruption.continuationWindowMs` (default 2500ms, `0` disables) of a
committed turn, that speech is treated as the rest of the turn — the reply
already answering the first fragment is cut, and the agent answers once the
caller finishes. Covers callers who pause mid-sentence (reading out a ZIP,
recalling an email) and were split into two turns, where the agent used to reply
to half the sentence first. Respects `interruption: "off"` and a held floor,
goes through false-interruption recovery so noise resumes the reply, and is
capped at two per ten seconds so re-prompting cannot starve a reply.
