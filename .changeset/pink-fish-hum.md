---
"@alexkroman1/aai-ui": patch
---

`StartScreen`, `ConsoleShell` and `ChatView` no longer draw the AssemblyAI logo
when no `icon` is passed, so an unthemed agent carries no vendor branding.
