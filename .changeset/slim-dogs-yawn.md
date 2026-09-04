---
"@alexkroman1/aai-runtime": patch
---

ctx.generate now validates a schema call's reply against the caller's own schema. jsonSchema() only describes a shape to the provider and carries no validator, so a model reply that missed the schema was returned as GenerateObjectResult<T>.object typed as T and unchecked. A Standard Schema call now returns the PARSED value and throws naming the failing property; a plain JSON Schema call keeps working, with the reply's top-level type checked against the document's own.
