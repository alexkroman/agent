---
"@alexkroman1/aai": patch
---

Add an optional `temperature` to the pipeline (`PipelineTransportOptions.temperature`), forwarded to `streamText`. It's omitted from the request unless explicitly set, so models that don't support it (e.g. the Claude 5 family, which ignores temperature and warns on every call) stay quiet, while temperature-capable models can opt into deterministic sampling (e.g. `0`) for consistent tool arguments and policy following.
