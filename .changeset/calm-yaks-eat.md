---
"aai-templates": patch
"@alexkroman1/aai-cli": patch
---

Parse third-party JSON in the recap-workflow, podcast-digest and call-audit workflow bodies with declared zod schemas instead of hand-rolled per-field guards, keeping every degradation path (a malformed payload, a missing optional field, a field of the wrong type) exactly as it was.
