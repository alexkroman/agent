---
"aai-studio-server": patch
---

Correct two docs that said the studio's coding-agent tools cannot be files because they close over a directory. The coding-agent template ships nine tools that close over one directory as files; what rules files out for the studio is per-session lifetime, not closure.
