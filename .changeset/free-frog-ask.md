---
"@alexkroman1/aai": minor
---

Answer an upload on a deployment with no upload backend as 501, naming what is missing, instead of an opaque 500 the client then retries four times. Adds `UploadsUnavailableError` to `@alexkroman1/aai/runtime`, which is what makes this a minor rather than a patch.
