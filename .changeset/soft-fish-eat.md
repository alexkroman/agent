---
"@alexkroman1/aai": minor
---

Add transport selection to agent(): declare transport: "sync" (pipeline mode only) and the default browser client runs connectionless HTTP turns against POST /sync — VAD mic, text composer, and spoken-reply playback with no custom client.tsx. The transport choice is served pre-connection via the new GET /client-config endpoint (GET /:slug/client-config deployed) with the agent name and greeting; every lookup failure degrades to the WebSocket default. aai-ui exports the new SyncChatView shell plus fetchClientConfig/buildAgentUrl, and the aai dev Vite proxy now forwards /sync and /client-config so sync clients work under dev.
