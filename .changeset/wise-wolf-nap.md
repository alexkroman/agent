---
"@alexkroman1/aai-runtime": patch
---

An expired workflow webhook token answers 404 instead of 500, so a third party stops retrying a dead callback; and a refused upload part offset names its real reason instead of always reporting misalignment.
