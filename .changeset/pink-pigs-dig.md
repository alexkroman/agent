---
"@alexkroman1/aai": patch
---

Rewrite hand-rolled state machines as XState statecharts: the AssemblyAI TTS
cancel/reconnect lifecycle, the platform socket reconnect loop, the pipeline
session lifecycle and push-to-talk turn, the browser session connection
lifecycle, the workflow form submission, and the `aai dev` restart supervisor.
Share one backoff reconnect loop (`createBackoffLoop` in `/internal`) between
the inbox and studio event stream.
