---
"@alexkroman1/aai-cli": patch
---

Fix three `aai dev` defects: the Vite proxy's `/workflows` prefix no longer swallows the project's own `workflows/` source directory (a file that exists on disk is served by Vite, everything else still proxies to the agent server), Vite binds the same loopback address the backend does instead of resolving `localhost` to IPv6-only, and `aai workflow` takes `--agent <url>` to target a server you are running yourself — with an undeployed project now naming that instead of asking you to log in.
