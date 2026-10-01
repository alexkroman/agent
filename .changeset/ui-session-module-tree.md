---
"@alexkroman1/aai-ui": patch
---

Internal restructure, no behaviour or API change: the browser session core, the audio layer and the upload machinery now live in `session/`, `audio/` and `upload/`, each entered through its own `index.ts`. The published exports (`.`, `./client-dir`, `./internal`, `./styles.css`) are unchanged.
