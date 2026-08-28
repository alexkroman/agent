---
"@alexkroman1/aai-runtime": minor
---

Move workflow upload records to the platform's own database, so a deployed guest keeps nothing durable on local disk. createUploadStore chose an upload's home from whether the agent had a ctx.db, on the premise that a database meant durable runs — which the platform workflow world falsified. A deployed guest with no DATABASE_URL therefore got durable runs with their uploads in a directory that recycles, which is how one sandbox filled its filesystem and ENOSPC'd every write. The platform arm is now checked first, ahead of a DATABASE_URL, the same way the workflow world is.
