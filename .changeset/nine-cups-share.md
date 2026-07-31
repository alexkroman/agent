---
---

Studio codegen evals: drop the `generation` rubric criterion left over from the
removed `workflow()` cases, add `CONFIG_CASES` asserting that generated agents
default to AssemblyAI providers (S2S unless another provider or cascaded mode is
named) and declare `allowedHosts` for tool-code fetches, and scope the
`capabilities` criterion to the prompt rather than the reference. The studio
preamble now states the mode default separately from the provider default.
