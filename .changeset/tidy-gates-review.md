---
"aai-gates": patch
---

Make three gates cover what they claim, and share the readings the specs duplicated.

The literal-path existence check ran over rule 16 alone while rules 24 and 25 grew literal lists of their own that nothing checked; the two doc-examples specs silently dropped any declared document their globs could not reach; and `ship.yml`'s `needsOf` failed open over a hardcoded five-job roster. All three are derived now, each A/B'd against a broken tree. Plus the workflow-job reader, `packageDirOf`, `withoutYamlComments` and the doc-example corpus moved to shared modules, and `CLAUDE.md` no longer contradicts `_gate-support.ts` about what `GATE_WIRING` holds.
