---
"@alexkroman1/aai-ui": patch
---

Document the `@alexkroman1/aai-ui/client-dir` subpath. It is published and has
always carried a worked `createAgentServer` example on `defaultClientDir()`, but
it was absent from the API reference — the package declared one TypeDoc entry
point. It now has its own page, and its module comment carries an `@module` tag
so the page is named after the subpath a consumer imports rather than the file
TypeDoc read.
