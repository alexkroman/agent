---
"@alexkroman1/aai": patch
"aai-server": patch
"aai-studio-server": patch
"aai-studio-client": patch
"aai-guest": patch
---

Bump dependencies across the workspace: the ai SDK and its provider adapters, zod, vite, vitest, hono, the Supabase clients, xstate, undici, modal, @cartesia/cartesia-js and the build/lint toolchain.

Two source changes come with it. The scripted fake language model emitted a bare-string stream finish reason where the v3 provider spec declares a { unified, raw } pair — harmless until ai@7.0.70 made automatic tool execution conditional on that value, after which a scripted tool call never ran; the fake's doGenerate half already had the pair. And protocol-compat.test.ts moves off zod's deprecated ZodTypeAny to ZodType.
