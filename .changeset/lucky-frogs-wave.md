---
"@alexkroman1/aai": patch
---

Drop two dangling `db` references from `ToolContext`'s published docs. `ctx.generate`
and `ctx.delegate` described themselves as executing "on the host, like `db`" — a field
removed outright, so the comparison pointed at nothing.
