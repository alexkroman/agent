---
"@alexkroman1/aai": patch
---

Adopt two Vercel AI SDK features in the pipeline instead of hand-rolling / going without:
- `experimental_transform: smoothStream({ chunking: "word", delayInMs: null })` coalesces LLM text deltas into whole words before they reach TTS (cleaner than raw sub-word tokens), with no added streaming latency.
- `experimental_repairToolCall` re-derives valid tool arguments (via `generateObject` constrained to the tool's JSON Schema) when the model emits a schema-invalid tool call, instead of failing the turn. Unknown-tool errors are passed through; a failed repair falls back to the original error. Lives in a focused `pipeline-repair.ts` module.
