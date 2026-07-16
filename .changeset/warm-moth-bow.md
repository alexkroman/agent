---
"@alexkroman1/aai": patch
---

Simplify internals with modern built-ins and existing deps: `Promise.withResolvers` + `p-timeout` for the TTS flush wait, S2S/OpenAI Realtime connect races, and the host-mode relay executor; `fs.cp` for scaffold layering, `stream/consumers` `text()` for stdin, and shared JSON file helpers in the CLI.
