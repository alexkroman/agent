---
"aai-studio-server": patch
---

Regenerate a project's preview when opening it finds the preview agent gone: the wake-up's sandbox warm-up now doubles as an existence check, and a 404 from the client-config broker clears the stale previewHash stamp and schedules a redeploy instead of leaving the pane pointing at a deleted agent forever.
