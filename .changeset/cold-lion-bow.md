---
"@alexkroman1/aai-cli": patch
---

Faster dev/deploy loop: dev server builds the new server before closing the old one (failed builds keep serving), the file watcher ignores dot-directories like .git (while .env stays watched), deploy bundles are minified and gzip-compressed, and aai test runs the project-local vitest binary instead of npx.
