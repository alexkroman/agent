---
"@alexkroman1/aai-cli": patch
"aai-templates": patch
---

Fix pnpm install failure when scaffolding pipeline-simple template. The template's package.json was replacing the scaffold's, leaving a workspace:* marker that pnpm cannot resolve outside the monorepo. Pipeline-mode SDKs (ai, assemblyai, @ai-sdk/anthropic, @cartesia/cartesia-js) now live in the scaffold's package.json. Also surface pnpm's actual stdout/stderr on install failure instead of the opaque 'Command failed' wrapper.
