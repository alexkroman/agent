---
"@alexkroman1/aai-cli": minor
---

Run the credential preflight and a bundle smoke test in the CLI at deploy time. The platform no longer extracts or stores an agent config, so aai deploy now imports the worker it just built: a bundle whose top level throws fails in your project directory instead of as a sandbox that never starts, and missing provider credentials are reported as a warning naming the keys. Deploys also send the agent name as a slug hint.
