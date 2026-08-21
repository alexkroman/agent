---
"@alexkroman1/aai-cli": patch
---

Templates: dispatch-center, retail and solo-rpg now declare their dialog order with flow() instead of prose plus hand-rolled guards. retail's requiresAuth boolean becomes a per-tool when, and the transfer to a human is a terminal state so every tool refuses afterwards — which the policy asked for and nothing enforced. solo-rpg drops the redundant phase field, gates the roll tools on a character existing, makes burn_momentum's burn window a state rather than a null check, and makes game over final. dispatch-center gates its six mutating incident and resource tools on something having been logged, and every converted tool's result now carries the position it landed in and what that position expects next.
