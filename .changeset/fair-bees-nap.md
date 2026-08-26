---
"@alexkroman1/aai-cli": patch
---

aai publish: honor --skipTypecheck end-to-end (it was silently ignored — the in-sandbox deploy always type-checked), and fail with the real reason when the entry agent.ts is dropped for exceeding the file cap instead of a later "No agent.ts found".
