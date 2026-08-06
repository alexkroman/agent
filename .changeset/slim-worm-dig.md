---
"@alexkroman1/aai": patch
---

Fix S2S sessions going permanently deaf: pin the AssemblyAI Voice Agent API's only supported sample rate (24 kHz, both directions) and declare the audio format on the wire.

The default system prompt now asks for numerals rather than spelled-out words ("$154" and "12 items", not "one hundred fifty-four dollars"). Measured, this changes nothing the caller hears — TTS voices numerals correctly and the audio is the same length — while keeping the real value in the transcript that captions, logs, and evals read.

The prompt no longer tells the model to speak a phrase before every tool call. `holdPhrase` already fires on exactly that condition, instantly and without an LLM round-trip, and the time-based dead-air cover handles the long tool chains a one-sentence preamble never could; asking the model as well made it narrate each step of a chain.

A cancelled tool call's result now names the tool instead of reporting a bare "This operation was aborted".
