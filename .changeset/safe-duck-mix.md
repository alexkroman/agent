---
"@alexkroman1/aai": patch
---

Fix pipeline history cap orphaning a tool result: the LLM-view trim is index-based, so its boundary could split an assistant tool-call from the `tool` message answering it. Both Anthropic and OpenAI reject an unmatched tool result, so every turn past ~200 messages in a long tool-using call failed at the provider and the caller heard the error phrase instead of a reply.
