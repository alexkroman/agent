---
"@alexkroman1/aai-ui": patch
---

Keep a fatal session error on screen: the host's own teardown frames (a cancelled turn, a reply boundary) no longer clear the banner or paint a live-mic state over it, so a missing provider key stays visible instead of flashing for a fraction of a second.
