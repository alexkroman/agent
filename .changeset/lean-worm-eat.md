---
"aai-studio-client": patch
---

Starter prompts now reference their aai-templates template by name (e.g. "Use the retail template."), so a pick copies the worked template verbatim via use_template instead of re-deriving it from a prose spec.
