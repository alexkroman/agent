---
"@alexkroman1/aai-server": patch
"@alexkroman1/aai-ui": patch
"@alexkroman1/aai": patch
---

Standardize file and directory naming to idiomatic kebab-case conventions

- Add ls-lint for file naming enforcement
- Drop underscore prefix from internal files in aai-server (e.g. `_schemas.ts` → `schemas.ts`)
- Rename `_components` → `components` and `__fixtures__` → `fixtures` in aai-ui
- Rename `__fixtures__` → `fixtures` in aai/host
- Flatten aai-server by removing `src/` directory
