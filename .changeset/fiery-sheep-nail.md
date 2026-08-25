---
---

Bind disposable resources with `await using` instead of calling
`[Symbol.asyncDispose]()` by hand, and add `guard-invariants` rule 27 to hold
it. No published behaviour changes: the only edit inside a published package is
a comment recording why one call site is exempt.
