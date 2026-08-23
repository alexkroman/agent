---
"@alexkroman1/aai": minor
---

Add decodeHtmlEntities to /utils, toolRunner to /testing, and mockWorkflows to /testing/vitest — the three helpers the templates were each re-deriving. decodeHtmlEntities replaces two byte-identical entity decoders whose whole content was the ordering rule that `&amp;` decodes last; it is a single pass, so no order of the table can produce a different answer. toolRunner is runTool with the agent bound, replacing ten template wrappers. mockWorkflows answers a WorkflowClient's reads from one fixture with a vi.fn per method.
