---
"@alexkroman1/aai": patch
---

Name the workflow-api and ffmpeg entry modules with `@module` tags, so they document under their published subpath rather than their emitted file path, and fix an unresolvable `{@link spawnFfmpeg}` in the ffmpeg module comment.
