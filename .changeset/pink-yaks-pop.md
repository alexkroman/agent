---
"@alexkroman1/aai": minor
---

Vercel-idiomatic API: rename tool({ parameters }) to tool({ inputSchema }) and accept any Standard Schema convertible to JSON Schema (Zod remains the default), let ctx.generate take a Zod schema directly with a typed object result (generateObject parity), accept model-id strings for llm (creator/model via the Vercel AI Gateway, bare ids via the AssemblyAI LLM Gateway), add a system alias for systemPrompt, extend toolChoice with none and { type: 'tool', toolName }, and add InferToolInput / InferToolOutput / InferAgentState type helpers.
