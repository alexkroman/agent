---
"aai-templates": patch
"@alexkroman1/aai-cli": patch
"aai-server": patch
---

Fix missing CSS in scaffolded agents: remove client.tsx and index.html from scaffold, serve pre-built default UI when no custom client exists, provide fallback index.html via Vite plugin for custom clients
