---
"aai-studio-server": patch
"@alexkroman1/aai-cli": patch
"@alexkroman1/aai": patch
---

A repository synced to GitHub from the studio is now a complete project: the scaffold (package.json scripts and toolchain, .gitignore, .env.example, CLAUDE.md pointer) is layered under the workspace the same way `aai pull` does, so a clone can `pnpm install` and run `pnpm dev`, `pnpm test` and `pnpm build`. Previously the stub workspace manifest was committed verbatim and installed nothing.
