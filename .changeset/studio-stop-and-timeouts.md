---
"aai-server": patch
"aai-studio-client": patch
---

Studio: a hung tool call no longer hangs the chat turn, and the user can cancel one.

- Every coding-agent tool (studio, web, and MCP) now runs under a per-call deadline (`STUDIO_TOOL_TIMEOUT_MS`, default 120s) — a dead sandbox RPC or silent MCP server resolves to an error tool result instead of leaving the tool row shimmering forever.
- The studio composer's send button becomes a Stop button while a turn streams; stopping aborts the SSE request, which cancels the server-side LLM stream, in-flight tool calls, and the session sandbox. Tool rows abandoned by a stop no longer shimmer.
- A failed sandbox provisioning is no longer cached for the rest of the turn — one transient spawn failure used to answer "Sandbox unavailable" to every later `test_agent` call. Provisioning failures are now also logged host-side.
