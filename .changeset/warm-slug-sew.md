---
"@alexkroman1/aai-cli": patch
---

Fail the workflow build when the flow bundle would require a Node builtin, instead of deploying a workflow that dies at replay with `require is not defined`
