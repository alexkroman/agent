---
"@alexkroman1/aai-cli": patch
---

Scaffolded templates: give the four prompt-only starters (code-interpreter, math-buddy, personal-finance, web-researcher) a unit-tier `agent.test.ts`, which `aai build` runs before it bundles, and make every `tools/` file default-export its tool rather than re-export it.

The templates ship inside this package's tarball, so the carrier is named here rather than `aai-templates`, which reaches nobody on its own version (`guard-invariants` rule 20). Also tightens the repo's structural conventions, which changes no shipped behaviour: provider factory signatures and options interfaces, provider and channel descriptor purity, store factory return types, the `sdk/`→`host/` boundary, boundaries for `aai-studio-server` and `aai-evals`, and a test asserting the boundary matrix is total.
