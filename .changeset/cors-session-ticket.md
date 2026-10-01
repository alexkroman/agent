---
"aai-server": patch
---

Allow the `aai-session-ticket` header through the platform's CORS policy, so a client embedded on an allowed origin can resume its session: the browser presents its last ticket in that header on `client-config`, and a preflight that refused it left the client unable to reach its sandbox again.
