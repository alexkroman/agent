---
"@alexkroman1/aai-runtime": patch
---

Raise the per-turn tool-error budget from 3 to 6. Three failed lookups forced an
answer halfway through the lookup-recovery ladder the system prompt asks for
(earlier hearings, letter confusions, other spellings of a name), so homophone
names (Sofia/Sophia, Yusuf/Yusef) failed authentication and the call was
transferred.
