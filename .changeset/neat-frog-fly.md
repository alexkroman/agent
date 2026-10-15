---
"aai-studio-server": patch
---

Studio: a replica going down in a deploy now drains its coding-agent sandboxes
(bounded) before terminating them, and the client regenerates a turn whose
sandbox dropped mid-stream instead of showing an error.
