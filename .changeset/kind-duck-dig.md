---
"aai-server": patch
---

Release the composer follow-up queue's dispatch latch when the send itself settles, not only when a render happens to observe a busy turn — a dispatched follow-up whose turn opened and closed inside one commit left the latch armed forever, wedging the composer and Publish until a reload
