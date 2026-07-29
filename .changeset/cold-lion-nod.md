---
"@alexkroman1/aai": patch
---

Fix deployed pipeline agents rejecting holdPhrase and the other voice tuning fields: validate the runtime config against the effective providers, which the platform passes as options rather than on the agent object
