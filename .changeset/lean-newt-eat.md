---
"@alexkroman1/aai-ui": patch
---

Never derive the public origin's scheme from the in-container request URL: behind Modal's TLS termination it is always cleartext http, which made studio Publish lose its Authorization header on the http→https redirect (401) and made the bare-slug redirect downgrade the scheme. A failed client-config lookup also no longer latches the session off the broker path.
