---
"@alexkroman1/aai-cli": patch
---

Emit a Vercel deployment through the Build Output API (`.vercel/output/`) instead of an `api/` entry beside a generated `vercel.json`. Vercel reads `vercel.json` before running the build, so a config the build writes never applied to that deployment; the Build Output tree is read after it. The function is now assembled rather than traced, so `.aai/worker.mjs` and `.env.example` — both reached by paths no static tracer can follow — are present, the built client is CDN-served from `static/`, and a WebSocket upgrade arrives through Vercel's per-request context and is re-emitted onto the same server `aai dev` runs. Also cuts `@alexkroman1/aai-cli/start` off the build toolchain: it reached `build.ts` (hence vite and rolldown's native binding) for one path constant, which made the bundled entry fail on import.
