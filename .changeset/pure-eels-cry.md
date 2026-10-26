---
"@alexkroman1/aai": patch
---

composio(): two calls that lose the same Composio session at once now share one
remake, so neither fails with a 404 when the session store's delete is slower
than its get
