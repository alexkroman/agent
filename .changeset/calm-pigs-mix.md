---
"@alexkroman1/aai": patch
"aai-server": patch
---

Remove unused code and fallback paths: legacy host-guest RPC schemas, backward-compat aliases (`pendingKvRequests`, `handleKvResponse`), unused exports (`jsonLogger`, `touchSlot`, `S2sEvent`, `DEFAULT_THEME`, unused metric label types), legacy OpenAI Realtime beta event-name fallbacks, inert CLI flags (`--server`/`--yes` on commands that never read them), and over-exported internal types.
