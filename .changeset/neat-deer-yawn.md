---
"@alexkroman1/aai-ui": patch
---

Allow `tools` display config alongside a custom `component` in `client()`. The provider already wrapped both tiers, so the labels were honoured at runtime; only the type rejected them.
