---
"@alexkroman1/aai": minor
---

Fix the test review sweep: correctness and quality findings across every
package, plus the gates that decide whether the tests mean anything.

The one published behaviour change: `publishStepEnv(undefined)` now
unpublishes the step env instead of publishing an undefined record, so a
test teardown can restore the unpublished state. An empty record and an
unpublished env are now distinguishable, and both are pinned.

The rest is tests and repo machinery. Highlights, all of which were
false-green before: the two flagship SSRF redirect tests made zero fetch
calls (both were satisfied by an NXDOMAIN lookup, so redirect
re-screening to 127.0.0.1 and 169.254.169.254 was covered by nothing);
an SSE fuzz property called its subject zero times across 200 runs; the
`as any` escape-hatch budget was entirely JSDoc prose because the gate
had no comment filter; and the required CI check reported success when
the build failed, because it omitted `setup` from its `needs` and
accepted `skipped` as a pass.
