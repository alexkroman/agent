---
"aai-server": patch
---

Build aai-runtime in the Modal image. The studio server imports @alexkroman1/aai-runtime/internal, which resolves to dist/internal.js in the image, but BUILD_COMMAND never built that package — so the image built green and the entry died at warm-up on ERR_MODULE_NOT_FOUND.
