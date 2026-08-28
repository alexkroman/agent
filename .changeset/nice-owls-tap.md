---
"@alexkroman1/aai-runtime": patch
"@alexkroman1/aai-ui": patch
"@alexkroman1/aai-cli": patch
---

Make a deployed agent's session state durable, and stop reporting an absent run as a server error. The runtime read the platform pair (`AAI_PUBLIC_BASE_URL`/`AAI_GUEST_TOKEN`) out of the AGENT's env, where the platform never puts it, so every deployed agent fell back to the memory backend and a session did not survive its sandbox restarting; uploads fell back to local for the same reason. A 404 from platform run storage now becomes the DevKit's own `WorkflowRunNotFoundError`, so GET/DELETE/wake on an unknown run answer 404/`cancelled:false`/`woken:0` instead of 500. The browser client reports a refusal close's own reason instead of discarding it, and a dev-mode `aai init` pins the third-party deps it shares with the linked workspace so two copies of xstate cannot fail the typecheck gate.
