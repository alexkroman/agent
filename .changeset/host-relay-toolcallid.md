---
"@alexkroman1/aai": patch
---

Fix relayed tool calls failing with "invoked without a toolCallId" in host + pipeline mode. The sandbox/RPC `executeTool` wrapper dropped its 5th `callOpts` argument (which carries `toolCallId`), so the relay executor couldn't correlate the client's `tool_result` and rejected every call. The wrapper now forwards `callOpts` to the RPC executor. Latent until host mode began running the STT→LLM→TTS pipeline (S2S sourced the id from a different path).
