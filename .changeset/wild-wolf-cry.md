---
"@alexkroman1/aai": minor
"aai-server": minor
---

llm() takes an optional contextWindow (tokens). A pipeline session budgets each
request against it, so a model off the AssemblyAI gateway catalog (a Cerebras
model, say) is no longer trimmed as if it had the smallest known window (32,768
tokens). A fallback([...]) is budgeted against its smallest member; a declared
window is capped at the largest the catalog carries.
