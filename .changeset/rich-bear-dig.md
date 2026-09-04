---
"@alexkroman1/aai-runtime": patch
---

Generalize the gateway tool-schema prune into a provider-compat layer: the verified $schema/propertyNames removal still runs for every model, and a Gemini layer selected by model id additionally folds the constraints its function-calling subset cannot express (string formats and lengths, number bounds, array lengths, defaults) into the schema description rather than dropping them, and restates const, oneOf, type unions and tuples inside the subset.
