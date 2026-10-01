---
summary: >-
  The upload store: bytes as objects, the record's two homes, immutability,
  window sizing and concurrency
read_when: >-
  editing anything under `src/uploads/`
---

# aai-runtime `uploads/`

Package-wide rules are in [`../../CLAUDE.md`](../../CLAUDE.md); the flat
`src/` modules' in [`../CLAUDE.md`](../CLAUDE.md). Outside this directory,
import its `index.ts` only (`guard-invariants` rule 37).

## An upload's bytes are OBJECTS, and its record has two homes

One store (`store-blobs.ts`) over `UploadRecords` (the record) and
`UploadBackend` (one object per `UPLOAD_PART_BYTES` window). Bytes stay out of
Postgres; `blobs.ts` carries why.

- **The pairing follows the WORLD, off `DATABASE_URL`: an upload is at least as
  durable as the runs that read it.** With a database the record goes there and
  the bytes need a bucket (no bucket is the one refusal). Without one both go in
  the local data directory (`files.ts`), and `installWorkflowSupport`
  announces it once.
- **A FINISHED upload is immutable, at both layers.** `assertUploadOpen` throws
  `UploadCompleteError` (409). The KIND refusal is checked first (a finished
  streamed upload keeps its 400), and a re-sent CLAIM naming only windows
  already held at the same lengths is a NO-OP (the completing request is the one
  whose answer can be lost). The byte route refuses independently
  (`aai-server/upload-handler.ts`).
- **A streamed upload's first windows are cut small** —
  `windows(body, limit, grow)` doubles from `UPLOAD_CHUNK_BYTES` to
  `UPLOAD_PART_BYTES` so `size` (the contiguous READABLE prefix) advances. Never
  count bytes that merely arrived. Only a published cut may be non-uniform,
  because `create` derives boundaries from `windowList`.
- **Neither direction takes turns with the socket**:
  `UPLOAD_WINDOW_CONCURRENCY` on write, `UPLOAD_READ_AHEAD` on read, both via
  `mapStream`.
- Upload-id validation at the router is in
  [`../workflow/api/CLAUDE.md`](../workflow/api/CLAUDE.md).
