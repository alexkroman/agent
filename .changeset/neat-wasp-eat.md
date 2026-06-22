---
"@alexkroman1/aai": patch
---

Simplify aai package internals: dedupe error-message/provider-descriptor helpers, remove dead code and redundant allocations, hoist constants out of hot paths, and tighten types — no behavior changes.
