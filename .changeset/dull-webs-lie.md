---
---

Fix the microVM backend fetching its own loopback for a deployed agent's bundle:
the bundle URL rides the boot env rather than the agent env, so the loopback
rewrite never reached it.
