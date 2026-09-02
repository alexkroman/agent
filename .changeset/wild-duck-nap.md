---
"@alexkroman1/aai": patch
---

Extract three duplicated internals into shared helpers: one `missingEnvMessage` behind `requireEnv`/`requireStepEnv`, one `createLlmModelCache`/`isLlmDescriptor` behind `ctx.generate` and `ctx.delegate`, and one `credentialVerdict` behind the two eval credential checks. No behaviour change — each pair had a verbatim copy of the string or the memo, which is how the two halves come to disagree.
