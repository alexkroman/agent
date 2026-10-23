---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

`assemblyAIStt()` now pins English when `languages` is unset: `["en"]` is sent
as `language_codes` (`DEFAULT_STT_LANGUAGES`), where previously nothing was sent
and the service detected the language per turn. An agent that needs per-turn
detection for a genuinely multilingual line opts out explicitly with
`assemblyAIStt({ languages: [] })`. The S2S descriptor is unchanged and still
detects per turn unless pinned.
