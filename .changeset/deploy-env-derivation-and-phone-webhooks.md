---
"@alexkroman1/aai-cli": minor
---

`aai build --target <host>` now derives the env a deployment needs from the agent itself — `requiredProviderEnvVars(config) ∪ requiredEnv`, unioned with `.env.example` — instead of from `.env.example` alone. An agent declaring `requiredEnv: ["ORDERS_API_KEY"]` with no example entry previously got neither a warning nor its `env add` step, which is the opposite of what the docs promised. Expect new warnings on projects that were quiet before; that is the fix, not a regression.

`aai deploy` now prints the exact phone webhook URL for each declared carrier with `?carrier=` already filled in, carries them on the `--json` result, and warns when a declared carrier's signing secret is absent from the uploading env — a Telnyx agent reached without that query parameter was framed as Twilio and 403'd on "Invalid webhook signature". The studio Publish output carries the same lines, since Publish is the path most users take.
