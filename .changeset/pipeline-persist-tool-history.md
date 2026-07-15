---
"@alexkroman1/aai": patch
---

Persist tool calls and their results across turns in pipeline mode. Previously only the spoken transcript survived into the next turn, so the model lost the raw results of earlier lookups (a user id, an order id) and had to re-derive them. The pipeline now keeps a Vercel AI SDK `ModelMessage` history and appends each turn's `streamText` step messages (assistant tool-call + `tool` result + text) — the SDK-idiomatic way — so tool context carries forward. Conversation memory was extracted into a focused `pipeline-history.ts` module (text view for the client/resume/tool-context; ModelMessage view for the LLM). Also fixes the test LLM fake to report `finishReason: "tool-calls"` on tool steps so multi-step response messages reconstruct correctly.
