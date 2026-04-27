---
"@alexkroman1/aai": minor
---

Pluggable Vercel AI SDK LLM providers in pipeline mode: add openai, google, mistral, xai, groq typed factories alongside the existing anthropic. Each is a { model } descriptor; the host resolver lazy-loads the corresponding @ai-sdk/* package via createRequire. All six AI SDK packages move to optional peer dependencies, so self-hosted users only install the ones they actually use; the managed server installs all six as direct deps in aai-server.
