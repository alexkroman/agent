---
"@alexkroman1/aai": major
---

Remove legacy code, dead exports, and silent fallbacks across the SDK, CLI, UI, and server.

Breaking changes:

- `@alexkroman1/aai`: removed the dead `MAX_VALUE_SIZE` constant and the unused `ASSEMBLYAI_STREAMING_URL` STT constant; removed the legacy STT model aliases `"u3pro-rt"` and `"universal-3.5-pro"` (use `"universal-3-5-pro"`); removed the dead `theme` manifest field and `HostConfigMessage` type; `PipelineTransportOptions.executeTool` is now required (it previously defaulted to a stub that threw mid-turn).
- `@alexkroman1/aai-ui`: removed the dead `floatToPcm16` export.
- `@alexkroman1/aai-cli`: removed the deprecated no-op `--skipApi` init flag; the global config dir no longer falls back to the pre-env-paths legacy path (macOS/Windows users authenticated at the old path will be re-prompted for their API key); an unreadable or malformed `.env` now fails loudly instead of silently running with no secrets.
- aai-server (private): removed the legacy `POST /:slug/deploy` route (deploys go through `POST /deploy` with the slug in the body); a corrupt stored env record now fails the agent boot instead of degrading to an empty env; the platform default Vector factory is now required (no silent in-memory fallback).
