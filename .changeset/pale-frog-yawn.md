---
"@alexkroman1/aai": patch
---

Execute the run_code builtin inside the gVisor guest instead of node:vm on the orchestrator. Hostile agent code enabling run_code can no longer reach the host Node process.
