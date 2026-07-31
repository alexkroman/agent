---
"aai-studio-server": minor
"aai-server": patch
---

The studio LLM now runs exclusively on the caller's own AssemblyAI API key
(the request bearer) via the LLM Gateway — the platform holds no studio LLM
credential: the `ASSEMBLYAI_API_KEY`/`ANTHROPIC_API_KEY` host fallbacks,
`STUDIO_LLM_PROVIDER`, and the chat 503-when-unconfigured path are removed
(`STUDIO_LLM_MODEL`/`STUDIO_LLM_REGION` remain as host model config). With
`web_search` now keyless, the dev-boot key check (`assertDevKeys`) is
removed from both services.
