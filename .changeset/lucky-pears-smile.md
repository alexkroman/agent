---
"aai-templates": minor
"@alexkroman1/aai-cli": patch
---

Add `roadside-assist`, the template for a dialog that describes a CALL rather than a form: a silence ladder, an abandonment deadline, an uninterruptible disclosure, and per-state LLM knobs.

The CLI is named alongside it because that is what actually ships a template — `bundle-templates.mjs` copies `templates/` and the scaffold into the CLI's dist at build time, so a changeset naming `aai-templates` alone bumps a version nobody resolves and delivers the template to no one.
