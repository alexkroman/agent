---
"@alexkroman1/aai-cli": minor
---

Require `aai login`: an exported ASSEMBLYAI_API_KEY no longer authenticates the CLI. Non-interactive callers point AAI_CONFIG_DIR at a config dir holding a logged-in key; in a project the variable stays a provider credential for `aai dev`.
