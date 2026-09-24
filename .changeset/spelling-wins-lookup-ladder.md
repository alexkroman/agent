---
"@alexkroman1/aai": patch
---

The default prompt's mis-hearing ladder now says which evidence wins when a lookup on a spoken value fails: once the caller has spelled a value, the spelling beats the word that was heard, and retries change only the characters two hearings disagree on — a part the caller spelled, or that was heard the same way twice, is not varied. The read-back before asking again spells the name out as well.
