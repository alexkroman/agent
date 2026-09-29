---
"@alexkroman1/aai-runtime": minor
---

An eval case can clear the suite's identity: `clientId: null`, `phone: null` or `call: null` in `EvalCaseOptions` means "none for this case", so a "not a placed call" refusal can sit inside a suite that sets `call`. Absent still means the suite's.
