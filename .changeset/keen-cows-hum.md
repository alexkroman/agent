---
"@alexkroman1/aai-cli": minor
"aai-templates": minor
---

Wire pluggable STT/LLM/TTS providers through the managed-platform sandbox. Previously providers were defined as live Vercel AI SDK / SDK-client instances in agent.ts, which meant the bundle shipped '@ai-sdk/anthropic' etc. into the guest Deno sandbox — the SDK's eager ANTHROPIC_BASE_URL env read crashed under '--allow-env'-free Deno. The server's createRuntime() also ignored stt/llm/tts entirely, so pipeline mode never activated in production. Now factories under @alexkroman1/aai/{stt,tts,llm} return '{ kind, options }' descriptors (JSON-serializable, no AI-SDK imports). The host resolves them to real openers at session start via a new resolver. IsolateConfig carries mode + descriptors through deploy, and sandbox.ts threads them into createRuntime. The agent bundle is now ~66 KB with zero AI-SDK code.
