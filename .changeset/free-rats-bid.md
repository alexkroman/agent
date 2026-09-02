---
"@alexkroman1/aai-runtime": patch
"aai-guest": patch
"aai-server": patch
---

Fix a durable-workflow livelock and the park cadence that hid it.

A workflow step longer than the guest's idle window never completed in production. The guest counted workflow work by HTTP RESPONSE, so the platform's 60s delivery abort read as an idle guest while the walk carried on; the sandbox self-exited mid-step `AGENT_IDLE_EXIT_MS` later and a fresh one restarted the same step, forever. Activity is now counted at the WALK — the promise the delivery door already awaits — so a running step keeps the guest alive and an idle one still exits promptly. A parked delivery is credited nothing, deliberately.

The guest half reaches production through a platform DEPLOY rather than through its own version — the harness is baked into the guest image, whose content-addressed tag the server pins at deploy time — which is why `aai-server` is named alongside it.

The park delay is also proportionate to the walk instead of a flat 5 seconds: `clamp(walkingForSeconds / 8, 5, 120)`, with the log line on the same curve. A 15-minute step now costs ~24 queue round trips and ~24 log lines rather than ~170 of each, while a brief race between two deliveries still gets its fast 5s retry.
