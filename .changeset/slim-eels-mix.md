---
"@alexkroman1/aai": minor
"aai-server": minor
---

AssemblyAI STT now defaults to English on Universal-3.5 Pro (the default model):
an unset `assemblyAIStt({ languages })` on that family sends
`language_codes=["en"]` (`ASSEMBLYAI_STT_DEFAULT_LANGUAGES`), turning its
code-switching off. Unset used to mean code-switching across 18 languages, which
on English calls turned backchannels ("mm-hm") into non-English text the
pipeline treated as caller turns. Other streaming models are unchanged: unset
still sends no `language_codes`. An explicit list is still sent exactly as
given, on any model; pass `languages: []` to opt back into full code-switching,
or several codes (`["en", "es"]`) to code-switch within a set.
`assemblyAIS2s({ languages })` is unchanged.
