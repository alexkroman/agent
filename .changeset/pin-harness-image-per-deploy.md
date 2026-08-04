---
"@alexkroman1/aai": patch
---

Deploys are pinned to the harness snapshot image they ran against. The
content-addressed image tag is recorded on the agents row at deploy time and
the agent's sandboxes spawn from that image ever after, so platform upgrades
(new harness, base image, or Node version) never change the runtime
environment under an already-deployed bundle. Redeploying re-pins to
current; an unresolvable pin falls back with a warning; pinned agents skip
the warm pool.
