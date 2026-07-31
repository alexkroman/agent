---
"@alexkroman1/aai": patch
---

Add voice-agent prompt rules drawn from EVA's itsm voice tasks: a policy-required follow-up write (assign the tier, log the interaction) is part of the action and must happen in the same turn as the write; an unmet prerequisite becomes the job, worked in order from step one and without narrating the policy; a date, time, window, or urgency is never the agent's to invent; and a validation error that spells out a required prefix has already answered the question, so correct a one-character confusable difference rather than asking the caller to confirm it.
