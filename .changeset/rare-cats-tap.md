---
"@alexkroman1/aai": patch
"@alexkroman1/aai-ui": patch
---

Replace hand-rolled code with established libraries: HTML entity decoding via entities, <link> parsing via htmlparser2 (fixes entity-encoded hrefs and attribute values containing '>'), percent-decoded static asset paths in the dev server, a new internal createCoalescingRunner primitive, and use-stick-to-bottom for message-list auto-scroll (height changes no longer silently unpin the transcript).
