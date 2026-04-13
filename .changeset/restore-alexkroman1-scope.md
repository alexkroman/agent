---
"@alexkroman1/aai": patch
"@alexkroman1/aai-ui": patch
"@alexkroman1/aai-cli": patch
---

Restore `@alexkroman1/` scope on publishable packages. The unscoped names
`aai`, `aai-ui`, and `aai-cli` are taken on npm by other publishers, so
the 1.0.1 release failed with `404 Not Found - PUT https://registry.npmjs.org/aai`.
The `scripts/check-publish-names.mjs` guard now fails CI if a publishable
package is ever renamed to an unscoped or unsupported scope again.
