---
"@alexkroman1/aai-ui": patch
"aai-server": patch
"aai-studio-client": patch
---

Ship a favicon.ico on the studio and voice agent pages: the AssemblyAI mark is bundled with the studio client and the default agent client, served at /favicon.ico (studio) and /:slug/favicon.ico (agents, with a custom client's own favicon taking precedence).
