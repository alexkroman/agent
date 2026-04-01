---
"@alexkroman1/aai-cli": patch
---

Improve cross-platform consistency in CLI

- Use platform-aware config directories (APPDATA on Windows, XDG on Unix)
- Add ci-info to detect CI and fail fast instead of hanging on interactive prompts
- Use execFileSync array form for safe process spawning with special characters in paths
