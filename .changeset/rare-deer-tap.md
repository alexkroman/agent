---
"aai-server": patch
"aai-studio-server": patch
"aai-studio-client": patch
---

Auto-create studio projects from the first chat message with server-generated v0-style names (prompt-derived base + random suffix) at shareable /studio/chat/<name> URLs; slugless CLI deploys now generate slugs from the agent's config name via the same shared generator.
