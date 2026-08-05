---
"@alexkroman1/aai-cli": patch
---

Serialize global-config updates across processes so a concurrent command can no longer discard the API key `aai login` just saved, and surface `aai dev` rebuild failures on stderr instead of silencing them when stdout is a pipe.
