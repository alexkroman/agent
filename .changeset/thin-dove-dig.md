---
"aai-server": patch
---

Ship the named-wait key grammar. The replay engine now journals a durable wait as `sleep!<label>#<occurrence>` / `hook!<token>#<occurrence>` rather than positionally, and those keys are written to `aai_platform.workflow_sleeps` and `aai_platform.workflow_hooks` — so the platform wants the release that carries them.

No schema change and no statement change: `key` is `text` and the reconcile query was already grammar-independent by design (it reads `delivered`/`closed`/`wake_at`, never the key). Its comment naming the old `hook!<n>` shape is updated.
