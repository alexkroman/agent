---
"@alexkroman1/aai": minor
"aai-server": minor
---

AssemblyAI STT now defaults to English: an unset `assemblyAIStt({ languages })`
sends `language_codes=["en"]` (`ASSEMBLYAI_STT_DEFAULT_LANGUAGES`), turning
Universal-3.5 Pro code-switching off. Unset used to mean code-switching across
18 languages, which on English calls turned backchannels ("mm-hm") into
non-English text the pipeline treated as caller turns. An explicit list is still
sent exactly as given; pass `languages: []` to opt back into full
code-switching, or several codes (`["en", "es"]`) to code-switch within a set.
`assemblyAIS2s({ languages })` is unchanged.
