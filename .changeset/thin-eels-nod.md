---
"aai-server": patch
"aai-studio-server": patch
---

Stop cutting live calls on deploy, and make a deploy reach every replica.

- A deploy/secret/storage mutation now **retires** the superseded sandbox
  instead of terminating it: it is detached from its slot synchronously (so no
  new session can be brokered onto it) and its remaining calls drain in the
  background before it shuts down, bounded by `SANDBOX_RETIRE_DRAIN_MS`.
- The slot's idle timer now checks the slug epoch as well as the session
  count, so a deploy that landed on another replica is picked up within
  `IDLE_SANDBOX_MS` instead of only at that replica's next session broker.
  Previously a sandbox with continuous traffic was never reclaimed at all.
- The shutdown drain counts sessions inside the guest sandboxes, not just
  WebSockets to the server process. Sessions dial the sandbox tunnel
  directly, so the old count always read zero and scale-in tore down live
  calls immediately despite a 120s drain budget.
