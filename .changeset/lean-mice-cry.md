---
"@alexkroman1/aai": minor
---

agent({ systemPrompt }) now takes a thunk as well as a string, resolved on every turn — for a prompt that has to carry something the model only learns mid-call. A string is unchanged, byte for byte; the text-agent path resolves through the same one spelling the transports do.
