---
"aai-templates": minor
"@alexkroman1/aai-cli": patch
---

Add `hiring-desk`, a port of CrewAI's `lead-score-flow` — the most complex example in `crewAI-examples` — as a voice agent: one crew scores a stack of applicants against a role (`ctx.generate` with a schema, fanned out through `mapConcurrent`), the human-in-the-loop router becomes a `dialog()` whose `reviewing` state offers the caller the same three choices, the feedback cycle gains the bound their flow lacks, and the other crew writes every applicant an email as a `subagent()` with `expectedOutput` and a `guardrail`. `crews.ts` carries the attribution and the their-name → our-name table.

The CLI is named alongside it because that is what actually ships a template — `bundle-templates.mjs` copies `templates/` into the CLI's dist at build time, so a changeset naming `aai-templates` alone bumps a version nobody resolves and delivers the template to no one.
