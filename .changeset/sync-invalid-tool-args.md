---
"@alexkroman1/aai": patch
---

Fix "Sync turn failed: malformed server response" when a turn's model emits an invalid tool call. The AI SDK surfaces an unparsable tool call as a `tool-call` stream part whose `input` is the raw argument string rather than a parsed object; the sync-turn runner shipped it verbatim in `toolCalls[].args`, the client's response schema rejected the whole body, and the workflow run died. Tool-call args are now coerced to a plain record (`toArgsRecord`, exported from `@alexkroman1/aai/utils`) on both the sync path and the WebSocket pipeline's `tool_call` observability frame, sync turns run the same tool-call repair the pipeline transport uses, failed/invalid calls are recorded with an error result instead of dangling, and the client's malformed-response error now names the offending field.
