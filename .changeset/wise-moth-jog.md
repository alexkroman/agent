---
"@alexkroman1/aai-runtime": patch
---

No SDK change. The platform's run-storage route: one bearer-gated POST that scopes every DevKit Storage call to the calling agent, with the five methods whose lookup key is not a run id each handled by name.
