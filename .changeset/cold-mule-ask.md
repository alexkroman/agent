---
"@alexkroman1/aai-runtime": patch
---

Serve every route from a table, and let the platform's guest-route map import it instead of re-typing it. `SERVER_ROUTES` and `WORKFLOW_CALLBACK_ROUTES` (on `/internal`) name every path this package serves; `createServer` dispatches off them, and `aai-server`'s `GUEST_ROUTES` composes ten of its seventeen entries from them rather than transcribing the strings. A renamed path is a compile error, and a new one fails a test instead of only a grep.
