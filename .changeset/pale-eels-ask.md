---
"@alexkroman1/aai": patch
---

A rejected provider credential now says so. `errorMessage` never answers with an empty string: an HTTP failure is described by its status, the host that answered and the sentence in its response body, a `fetch failed` reports the reason in its cause, and an `AggregateError` reports its members. A rejected API key reached a browser client as {"code":"llm","message":""} — the AI SDK copies an absent HTTP reason phrase into `APICallError.message` — so the banner said an error occurred and refused to say what. Pipeline mode now reports it as "The LLM provider rejected this agent's API key: Invalid API key (HTTP 401 from llm-gateway.assemblyai.com). Check the API key in the agent's environment.", once rather than twice: the "No output generated" throw that follows an error part no longer paints over the sentence naming the cause.
