---
"@alexkroman1/aai-runtime": patch
"aai-server": patch
---

Model-provider fetch wrappers now take their delegate as a required argument,
named once by the LLM registry (still the ambient fetch, read per call); agent
boot artifacts in a contained guest are written under the guest scratch dir
(/var/tmp) instead of a hardcoded /tmp.
