---
"@alexkroman1/aai": minor
---

Extract the step-authoring helpers the workflow templates had duplicated: `@alexkroman1/aai/step-errors` (`toStepError`/`throwStepError`/`throwFatalStepError`) turns a Response or a StepGenerateError into the FatalError/RetryableError the Workflow DevKit reads — and reads the retryAfter the gateway already reported, which nothing did before; `stepGenerateJson` on /utils asks a model for JSON and validates it against a Standard Schema; and `stubGateway` on /testing is the fake LLM gateway for testing a step that calls one.
