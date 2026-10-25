---
"@alexkroman1/aai-cli": patch
---

A deployed worker carries only the speech SDKs its agent declares. The worker is
one file, so every vendor STT/TTS opener the runtime loads lazily was inlined
regardless: the quickstart's worker was 9.8 MB, 42% of it the ElevenLabs SDK,
for an agent on the default AssemblyAI pipeline. aai build and aai deploy now
read the agent's own config and leave out the vendors it cannot reach; a stub
throws, naming what was left out, only if a runtime is handed such a provider
anyway.
