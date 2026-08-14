---
"@alexkroman1/aai-cli": patch
---

The workflow step bundle carries a `createRequire` shim, so a step importing a package with a CommonJS dependency loads instead of throwing `Dynamic require of "node:assert" is not supported` before its first line runs.
