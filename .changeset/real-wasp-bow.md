---
"@alexkroman1/aai": patch
---

Voice prompt fixes measured on tau2-bench: scope the tool preamble to once per TURN (not per tool call), tell the model a not-found lookup on spelled input is probably a mis-hearing, and stop the false-interruption resume restarting the sentence it was mid-way through.
