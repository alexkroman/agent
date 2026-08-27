---
"@alexkroman1/aai-runtime": minor
---

Add the platform's queue-delivery door: a host-only `POST /workflow-queue` that dispatches a delivered message to the flow or step entrypoint by the DevKit's queue-name grammar. One door rather than widening the loopback gate on the two callbacks, so that grammar is parsed on the side that depends on the DevKit; refused unless the composition vouches for the caller, which `aai dev`, host mode and a self-hosted server do not.
