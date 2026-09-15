---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Add Cerebras as an LLM provider.

`cerebrasLlm({ model })` on `@alexkroman1/aai/llm`, resolving `CEREBRAS_API_KEY` host-side like every other vendor. [Cerebras Inference](https://inference-docs.cerebras.ai) serves a small set of open-weight models on its own hardware behind an OpenAI-compatible chat-completions endpoint.

**No new dependency.** Like OpenRouter, it is `@ai-sdk/openai`'s `.chat()` client repointed at a base URL — so the registry entry is four lines and the guest bundle grows by nothing.

**It is not an aggregator, and that is the one thing to know at a call site.** `openRouterLlm` and `gatewayLlm` front hundreds of models addressed `"creator/model"`; this catalogue is a handful, addressed by BARE id (`"qwen-3.8-27b"`, `"gpt-oss-120b"`). The reason to name the vendor is serving LATENCY rather than reach: the same `qwen-3.8-27b` returned a complete tool call in ~0.55s here against ~0.95s on a self-hosted vLLM endpoint of the same model, and a voice pipeline pays that difference on every turn.

Verified through the real `resolveLlm` path rather than by shape: generate, STREAMING (which the voice pipeline requires and a non-streaming endpoint would fail mid-session rather than at boot), and a tool call returning the right function name and arguments.

`_lazy-model.test.ts` gains the eagerly-constructed twin its coverage assertion demands, so the deferred model is proven equivalent to a directly-built one rather than assumed to be.

`aai:llm` goes to epoch 8, RETAINED — the change is purely additive, so epoch 7 still compiles, and its frozen example now pins what an additive vendor quietly depends on and no other fixture stated: that **every** vendor factory on this surface answers the same `LlmProvider` shape, one `kind` discriminant plus an `options` bag. That uniformity is why adding a vendor costs a factory and a registry entry instead of re-splitting `ModelOptions` across every call site.
