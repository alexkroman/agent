---
"@alexkroman1/aai": patch
---

The default prompt's confirmation rule no longer lets a request stand in for a
yes when the agent's own instructions require an explicit confirmation, and it
says what a yes is: an answer to a question the caller heard. A backchannel
("uh-huh") over the agent's speech is not agreement, and a yes after a reply
that ended in `[interrupted]` cannot answer a question the cut removed, so the
agent asks again before acting. On tau2 retail, three writes ran without a heard
yes, one of them licensed by the old "the request is the authorization" line.
This is not yet measured by replay.
