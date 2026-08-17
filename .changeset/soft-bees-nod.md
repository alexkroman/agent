---
"@alexkroman1/aai": patch
---

Studio projects get a database (`ctx.db`) by default. The Settings pane's Database switch is now an opt-out: an unset project reads as enabled, each environment's schema is still provisioned by the deploy that claims its slug, and switching it off records an explicit opt-out that later deploys respect. Updates the shipped authoring guide accordingly.
