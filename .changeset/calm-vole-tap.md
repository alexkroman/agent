---
"@alexkroman1/aai": major
"@alexkroman1/aai-ui": major
---

Narrow the public export surface: remove registry/wire internals from the provider barrels (ASSEMBLYAI_LLM_KIND, GATEWAY_KIND, OPENROUTER_KIND, ASSEMBLYAI_TTS_KIND, CARTESIA_KIND, RIME_KIND, gateway URLs, ASSEMBLYAI_TTS_HOST, OPENROUTER_BASE_URL, default-voice constants), EMPTY_PARAMS/ExecuteTool/SessionMode from the manifest barrel, duplicate createRuntime/Runtime/RuntimeOptions/safeFetch/RunCodeExecutor re-export paths from the runtime barrel, and the WebSocketConstructor test-seam type from aai-ui. Provider factories, their Options/Provider types, and *_API_KEY_ENV constants are unchanged.
