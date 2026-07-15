---
"@alexkroman1/aai": patch
---

Fix an OpenAI Responses API 400 ("Item 'msg_...' of type 'message' was provided without its required 'reasoning' item: 'rs_...'") on multi-turn tool calls in pipeline mode. Persisted-history reasoning stripping is now conditional: reasoning parts that carry provider metadata needed on replay are kept — OpenAI reasoning items (`openai.itemId`) required alongside their message/tool-call items, and Anthropic thinking/redacted-thinking (`anthropic.signature` / `anthropic.redactedData`). Only metadata-less reasoning traces (the ones that triggered the Anthropic "unsupported reasoning metadata" warning) are still stripped.
