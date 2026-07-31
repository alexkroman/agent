---
"@alexkroman1/aai": patch
---

Fix the user's barge-in utterance flickering in the UI: a final-triggered barge-in now re-emits the interim caption after the cancel, so the utterance no longer disappears for the settle window before reappearing as a committed message
