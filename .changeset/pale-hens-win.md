---
"@alexkroman1/aai-runtime": patch
---

The session-event stream reported `tail: 0` for a session this process never handled, so a cold read of a DURABLE stream answered with a full page of events beside a cursor of zero — and `startIndex=-N` counted back from that zero and returned the whole stream.
