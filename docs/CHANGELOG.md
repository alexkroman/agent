# aai-docs

## 0.0.1

### Patch Changes

- d98169a: Lint the docs workspace. It was excluded from Biome twice over — `docs/**` was
  absent from `files.includes`, and no invocation pointed at it — and had no
  `lint` script, so `turbo run lint` resolved `aai-docs#lint` to `<NONEXISTENT>`
  and `pnpm check` skipped it silently. That is the failure AGENTS.md already
  names for a package with no `lint` script, one workspace over.
  
  Latent rather than live, because the workspace holds zero TypeScript: what was
  unlinted is the four config JSONs, including the `typedoc.json` and
  `typedoc.markdown.json` whose options the docs guide calls load-bearing. Both
  carry explanatory comments, so a Biome override allows comments in
  `docs/typedoc*.json` — Biome's built-in JSONC filename list covers
  `turbo.json` and `tsconfig.json` but not these.
