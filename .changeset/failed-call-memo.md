---
"@alexkroman1/aai-runtime": patch
---

Tool calls that already failed with the same arguments are no longer run again.
The session remembers failed calls and answers an identical repeat with a
`repeated_failure` result telling the model to change something, before the tool
runs — so no tool speech, and in host mode no relayed call. A failure's model
copy also lists every failed call so far. Any success, or a reset, forgets them.
This replaces the tool-error budget's rule that let an identical repeat run and
then ended the turn; on replayed tau2 retail recoveries it halved identical
resends (44 → 18).
