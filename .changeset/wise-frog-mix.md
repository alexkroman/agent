---
"@alexkroman1/aai-ui": minor
---

Resume an interrupted upload instead of losing it, and let a person pause one. A round that fails for a reason that looks like an outage — a redeploy, an idle sandbox reclaim, a dev-server restart — is re-entered with `resume: true` and sends only the windows the store does not have, on a budget that outlasts a restart. The same mechanism is exposed as `pauseUpload`/`resumeUpload` on both submit hooks, with a control on `<UploadProgressBar>` and `paused` on `UploadStatus`.
