---
"aai-studio-server": patch
---

Rebuild a GitHub sync commit onto a branch head that moved, instead of telling the user to try again. "That branch moved while the sync was running" answered every 409 and 422 in the push, so a tree GitHub would not accept or a ref name it would not create both read as a transient race and the retry advice never worked. Retryable ref conflicts are now retried by the sync itself; everything else keeps GitHub's own message.
