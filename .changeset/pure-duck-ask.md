---
"@alexkroman1/aai": patch
---

STT: stop inheriting the assemblyai SDK's 1000 ms streaming connect deadline, which covers socket open plus the server's Begin and failed healthy handshakes. The AssemblyAI STT opener now pins connectTimeout/maxConnectionRetries/connectionRetryDelay from STT_CONNECT_* constants (2500 ms, 2 retries, 500 ms), overridable per agent via assemblyAI({ connectTimeoutMs, maxConnectRetries }).
