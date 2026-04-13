---
"@alexkroman1/aai-cli": patch
"aai-templates": patch
---

Fix scaffold missing client.tsx and route pnpm install through safe-chain

- Add client.tsx to scaffold with correct `client` import from aai-ui (fixes build failure from stale `defineClient` reference)
- Detect safe-chain on PATH and route pnpm install through it with `--safe-chain-skip-minimum-package-age` to avoid blocking newly published packages
