---
"@alexkroman1/aai": minor
"@alexkroman1/aai-cli": minor
"@alexkroman1/aai-server": patch
"@alexkroman1/aai-templates": minor
---

Remove SDK, UI, and testing harness as user-facing dependencies

Replace defineAgent/defineTool/Zod with plain agent.toml + tools.ts contract. Users define agents via static TOML config and optional TypeScript tools file with JSON Schema parameters. No SDK imports required.
