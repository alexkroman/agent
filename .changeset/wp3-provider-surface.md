---
"@alexkroman1/aai": major
---

Cut the published provider surface to what an agent author writes.

**The four stage subpaths go from 118 exports to 49.** Counted in
`API-EXPORTS.json`: `/stt` 24 → 11, `/llm` 56 → 18, `/tts` 25 → 14, `/s2s`
13 → 6. `/ffmpeg` goes 21 → 15, and the `/llm` reference report drops from 454
lines to 81.

- **The eighteen `*_KIND` and eighteen `*_API_KEY_ENV` constants moved to
  `@alexkroman1/aai/host-internal`**, beside the `resolve*Settings` helpers
  that read them. An author never typed one — a factory returns the `kind`,
  and the host resolves the credential out of the agent's env — and four of
  each set were one string under four names.
- **The eighteen narrowed `*Provider` aliases are gone.** `deepgram()` returns
  `SttProvider`, `anthropic()` returns `LlmProvider`, and so on. They had no
  reference outside their own modules, nothing narrowed on `.kind`, and the
  stage-mismatch guarantee they were credited with comes from the base types'
  `__stage` phantom. `assemblyAIPipeline()` returns the three base types too.
- **Eight byte-identical `{ model: string }` interfaces became one
  `ModelOptions`** (`AnthropicOptions`, `OpenAIOptions`, `GoogleOptions`,
  `GroqOptions`, `MistralOptions`, `XaiOptions`, `OpenRouterOptions`,
  `GatewayOptions`). The STT/TTS option types, which differ, are unchanged.
- **The root barrel exports the five descriptor types its own signature
  names** — `SttProvider`, `LlmProvider`, `TtsProvider`, `S2sProvider`,
  `ProviderDescriptor`. All five were FORGOTTEN exports there: declared in the
  rollup because `AgentDef` references them, exported by nothing, so an author
  typing two stages imported from two subpaths and the shipped authoring
  guide's `agent()` signature block named types no import path could supply.
  `ProviderDescriptor` leaves the four stage subpaths, where one interface had
  four reference pages; the four stage types stay on theirs as well.
- **`ASSEMBLYAI_TTS_VOICES` and `AssemblyAITtsVoice` are on the root too**, for
  the same reason: `agent({ voice })` is typed against them and both were
  forgotten exports. `ASSEMBLYAI_TTS_DEPRECATED_VOICES` went the other way, to
  `/host-internal` — no template read it, and its 21 literals were inlined into
  the published `.d.ts` for nobody.

**Renames.** `AssemblyAIOptions` → `AssemblyAISttOptions`,
`ASSEMBLYAI_STREAMING_EU_URL` → `ASSEMBLYAI_STT_EU_URL`, `ASSEMBLYAI_KIND` →
`ASSEMBLYAI_STT_KIND`, `ASSEMBLYAI_API_KEY_ENV` → `ASSEMBLYAI_STT_API_KEY_ENV`
(the AssemblyAI STT module was the one stage keeping bare names while the other
three infixed theirs); `DEFAULT_DEEPGRAM_ENDPOINTING_MS` →
`DEEPGRAM_DEFAULT_ENDPOINTING_MS`, matching every other provider constant; and
`elevenlabs()` → `elevenLabsStt()`, so the bare name is free for the TTS stage
ElevenLabs is better known for.

**Two option fields.** `elevenLabsStt({ languageCode })` is `{ language }` and
`soniox({ languageHints })` is `{ languages }`, leaving one spelling per
cardinality across the four STT vendors instead of four. Each vendor's own wire
name is still applied host-side, so nothing on the wire changes.
`assemblyAIS2s()` gained `apiKeyEnv`, a field the host had always read off any
descriptor generically — S2S honoured an override its own options type could
not spell — and `AssemblyAIS2sOptions`/`OpenaiRealtimeOptions` are interfaces
now, like the other three stages'.

**`@alexkroman1/aai/ffmpeg`.** Two exported type names collided with DOM
globals and are renamed: `MediaStream` → `MediaStreamInfo` and `MediaSource` →
`FfmpegSource`. API Extractor was already emitting them as
`MediaStream_2`/`MediaSource_2` to produce a report at all. Six operator knobs
moved to `/host-internal` — `FFMPEG_PATH_ENV`, `FFPROBE_PATH_ENV`,
`DEFAULT_FFMPEG_TIMEOUT_MS`, `DEFAULT_MAX_FFMPEG_OUTPUT_BYTES`,
`FFMPEG_STDERR_TAIL_CHARS` and `ffmpegVersion` — since a `.d.ts` an author
imports is the wrong place to publish where the binaries live on this machine.

**The gateway catalog stopped being a published data table.**
`ASSEMBLYAI_GATEWAY_MODELS`, `GatewayModelInfo` and `gatewayModelIds` are on
`/host-internal`; `AssemblyAIGatewayModel` stays public, and
`gen-gateway-models.mjs` now emits it as an explicit string-literal union
instead of `keyof typeof`. The catalog's 30 rows were inlined into the
published `.d.ts` to express that one type — roughly 190 of the 454 lines the
`/llm` report used to be — so regenerating the catalog, which is routine ops,
moved a contract hash and demanded a classification for a change no author
could see.
