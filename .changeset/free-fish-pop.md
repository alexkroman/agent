---
"@alexkroman1/aai-cli": minor
---

Warn when a host-target build has no value for a variable `.env.example` declares, naming the command that sets it. Declarations ship and values come from the host, so a deployment whose credentials were never set built green and failed at its first session; `missingEnv` is on the build result for `--json` readers.
