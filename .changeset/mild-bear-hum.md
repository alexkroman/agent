---
"@alexkroman1/aai": patch
---

Fix 'unsupported reasoning metadata' warning in pipeline mode: replace smoothStream with a text-only word-coalescing transform so Anthropic thinking signatures on reasoning parts survive multi-step tool turns
