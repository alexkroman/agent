---
"@alexkroman1/aai": major
---

**BREAKING — the STT/TTS opener contract moved off `@alexkroman1/aai/stt` and `@alexkroman1/aai/tts` to `@alexkroman1/aai/runtime`.**

Eleven types are affected. If your build broke with `has no exported member`, change the import path — nothing about the types themselves changed:

| moved from | moved to | names |
| --- | --- | --- |
| `@alexkroman1/aai/stt` | `@alexkroman1/aai/runtime` | `SttOpenOptions`, `SttSession`, `SttEvents`, `SttError`, `SttTurnMeta`, `Unsubscribe` |
| `@alexkroman1/aai/tts` | `@alexkroman1/aai/runtime` | `TtsOpenOptions`, `TtsSession`, `TtsEvents`, `TtsError`, `TtsWordTiming`, `Unsubscribe` |

```diff
-import type { SttEvents, SttOpenOptions, SttSession } from "@alexkroman1/aai/stt";
+import type { SttEvents, SttOpenOptions, SttSession } from "@alexkroman1/aai/runtime";
```

These are the types a HOST application implements a speech provider against, and they now sit beside `registerSttKind`/`registerTtsKind` — the seam you hand the opener to — instead of on the subpath an agent author imports a factory from. Writing an agent needs none of them. `SttProvider` and `TtsProvider`, which are what a factory RETURNS, stay on `/stt` and `/tts`.

Also in this release, all non-breaking:

- `ProviderDescriptor` — the base of `SttProvider`, `TtsProvider`, `S2sProvider` and `LlmProvider` — is now exported from `/stt`, `/tts` and `/s2s` as well as `/llm`, so a page showing `SttProvider = ProviderDescriptor<…>` defines the type it names.
- Every provider page now opens with what it is FOR and a compiling example of putting that stage in front of an agent, instead of an internal note about `noReExportAll` budgets. All 18 factories (`assemblyAIStt`, `deepgram`, `elevenlabs`, `soniox`, `anthropic`, `openai`, `google`, `mistral`, `xai`, `groq`, `openrouter`, `gateway`, `assemblyAILlm`, `assemblyAITts`, `cartesia`, `rime`, `assemblyAIS2s`, `openaiRealtime`) gained an `@example`.
- The `/stt` page now states what an unset language field means for each of the four vendors, and `DeepgramOptions.language` says out loud that unset means **English** — `deepgram()` is the one STT provider here that pins a language where the other three auto-detect, so moving an agent onto it silently drops non-English transcription with no symptom but a plausible-looking mis-hearing.
- `DEFAULT_DEEPGRAM_ENDPOINTING_MS` and the root's `DEFAULT_MIN_TURN_SILENCE_MS`/`DEFAULT_MAX_TURN_SILENCE_MS` now cross-reference each other as the one end-of-turn knob seen from two vendors.
- `@alexkroman1/aai/runtime`'s own page now leads with the handful of names a host application actually imports, rather than with the enumerated-exports rationale.
