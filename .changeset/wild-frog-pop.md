---
"@alexkroman1/aai": minor
---

Deduplicate and simplify shared logic across the workspace: byte-buffer joins, a bounded-concurrency worker pool, upload pause/resume, and the guest base-image tag each now have one definition instead of two to four hand-written copies.

Note one user-visible change: aai-ui's upload progress now formats byte counts with the SDK's formatBytes, so a KB value renders as `512 KB` rather than `512.0 KB`. The SDK helper is otherwise strictly more robust (NaN/negative guard, carries 1024 KB up to 1.0 MB, and has a TB step).
