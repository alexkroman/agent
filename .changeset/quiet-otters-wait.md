---
"@alexkroman1/aai": patch
---

Pipeline barge-in now requires the agent to be audibly speaking rather than merely mid-turn. A reply that has not yet emitted audio cannot be spoken over, so an utterance arriving in that window is buffered and answered as a chained turn instead of aborting the reply in progress. Previously any utterance during a slow reply restarted the turn, and since each restart redid the work on a longer history it outlived the next re-prompt — a caller saying "hello? any update?" into the silence could starve the reply indefinitely. Once a turn has spoken it keeps the floor for the rest of its run, so a mid-reply TTS stall does not reopen the window.
