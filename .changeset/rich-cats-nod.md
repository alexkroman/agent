---
"@alexkroman1/aai-runtime": patch
---

evalNetwork accepts METHOD-qualified route keys ("POST crm.example"), sharing one route-key matcher with stubFetchRoutes; aai dev's Vite proxy is now derived from the runtime's route table, so /session-events is proxied; aai secret --local writes .env through the shared atomic writer.
