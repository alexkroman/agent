---
"aai-guest-studio": patch
"aai-studio-server": patch
---

Studio guest: the end-of-turn TURN-COMPLETE sync now waits for in-flight workspace checkpoints, so a stale mid-turn checkpoint can no longer land after it; and a session-init for a different project arriving during the sandbox's first install is refused instead of being handed a session over the first project's tree.
