---
"@alexkroman1/aai": patch
---

Speak alphanumeric identifiers one character at a time end to end. "Speak phone numbers and codes digit by digit" was followed only halfway: measured against Full-Duplex-Bench audio, the agent wrote `ABC123`, `two K2` and `DELIV`, which TTS then rendered as "ABC one hundred twenty three", "2K2" and "Delive" — a caller cannot tell "123" from "one two three", and a quantity abutting a product code becomes one unsayable token. With the rule the same five utterances produce `two of K-two` and `D-E-L-I-V`, and transcribing the agent's own audio back shows the caller now hears `2 of K2` rather than `2K2`, and `Deliv` rather than `Dulif`.

Also quote money and counts from the tool-result field that holds them rather than computing them, and fix `firstPartMs` in the per-turn LLM trace so it times the model's first content part instead of the AI SDK's synchronous `start`/`start-step` parts — it reported 0-2 ms on every real turn, hiding time-to-first-token entirely, and now reports a p50 of 799 ms on the same turns.
