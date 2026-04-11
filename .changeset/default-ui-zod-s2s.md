---
"aai-ui": minor
"aai-server": minor
"aai-cli": patch
"aai": patch
---

Add default aai-ui client served by the server when no custom client is deployed. Remove zod externalization from the worker bundler — zod 4 works natively in Deno sandboxes. Update S2S API endpoint and fix load test event handling.
