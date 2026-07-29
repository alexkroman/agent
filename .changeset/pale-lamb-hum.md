---
"@alexkroman1/aai": minor
---

Add a zod-free `@alexkroman1/aai/utils` subpath export exposing the shared utilities plus the platform slug contract (`VALID_SLUG_RE`, `RESERVED_SLUGS`, new `sdk/slug.ts`). Client wire constants (`MIC_BUFFER_SECONDS`, `MIC_SEND_MAX_BUFFERED_BYTES`, `FILE_SEND_BACKOFF_MS`) and the `custom_event` relay caps now live in `sdk/constants.ts`; `isPathInside` is exported from the runtime. The CLI and UI re-export these from the SDK instead of carrying their own copies.
