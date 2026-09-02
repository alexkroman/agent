---
"@alexkroman1/aai-runtime": patch
---

Refuse a session event the platform cannot read instead of dropping it from the page. A read of the session event stream is a cursor, so a skipped entry was an event silently gone rather than a degraded answer — and an entry whose index coerced to `0` was worse, taking the place of the session's real first event. Both ends of the wire now refuse what they cannot read.
