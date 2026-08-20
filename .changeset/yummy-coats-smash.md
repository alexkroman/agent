---
---

Fix the local workflow world failing to start in deployed guests: `@workflow/world-local` read its own `package.json` relative to its module location, which a bundled harness has no copy of, and its `"bundled"` fallback is a version string its own parser rejects. Patched to read the version from a constant.
