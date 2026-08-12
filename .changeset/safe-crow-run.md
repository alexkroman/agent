---
"aai-studio-server": patch
---

A studio project created in workflow mode has its database switched on from the start. The journal IS the durability, so a workflow project without storage boots, answers calls, and rejects every `ctx.workflows` call — inert at the one thing it exists for, with the fix two panes away in Settings. Only the intent is stamped, since no slug exists yet to provision; the project's first deploy provisions each environment through the existing reconcile hook. Storage stays off by default for a voice project, where it is incidental.
