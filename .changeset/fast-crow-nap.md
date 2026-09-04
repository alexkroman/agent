---
"@alexkroman1/aai": minor
---

Add an MCP tool client: an agent can declare HTTP MCP servers with `mcpServers`, and `withMcpTools` (@alexkroman1/aai-runtime) connects them and attaches their tools as ordinary tools. Tools are namespaced `mcp_<server>_<tool>` so a server cannot shadow a native tool, pinned by fingerprint against rug pulls, screened for SSRF, and routed through the existing ExecuteTool path. HTTP only; a server that is down or slow costs its own tools and never the session.
