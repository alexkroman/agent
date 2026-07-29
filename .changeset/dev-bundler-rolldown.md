---
"@alexkroman1/aai-cli": patch
"aai-server": patch
"aai-templates": patch
---

Drop the direct esbuild dependency: the CLI now bundles with Rolldown end to end.

- `aai dev`'s fast worker builds (`_dev-bundler.ts`) run on Rolldown — the native bundler Vite 8 itself uses, so the dependency dedupes to zero extra install weight. Fresh builds land in tens of ms, so the old incremental esbuild context is no longer needed; non-compile failures still fall back to the cold Vite path.
- Deploy/studio worker minification switches from `minify: "esbuild"` (which loaded esbuild as Vite's optional peer) to Vite 8's native `"oxc"` minifier. The studio inherits this automatically via `@alexkroman1/aai-cli/worker-bundler`.
- The scaffold's pnpm build-script approval for esbuild is removed — no scaffold dependency runs an install-time build script anymore.
