---
"aai-studio-server": patch
---

Landing on a studio project now wakes its preview: the once-per-open session broker call reschedules a stale preview deploy (one dropped by a replica restart no longer leaves the pane on "Updating preview…" until the next edit) and warms the preview agent's sandbox through the platform's client-config broker, so an idle-evicted preview is booting before the Preview pane's iframe asks for it.
