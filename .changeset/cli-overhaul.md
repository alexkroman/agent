---
"@alexkroman1/aai-cli": minor
"@alexkroman1/aai": patch
"@alexkroman1/aai-ui": patch
"@alexkroman1/aai-server": patch
---

CLI overhaul: remove generate command, unify output style, template descriptions

- Remove `generate` and `run` commands and AI SDK dependencies
- Unify CLI output to use @clack/prompts style consistently
- Add template descriptions shown as hints in `aai init` select prompt
- Fix deploy slug mismatch between bundle and deploy steps
- Clean deploy error messages (no stack traces)
- Add `@alexkroman1/aai-cli` to scaffold devDependencies
- Remove fly.toml from scaffold
- Use cyanBright for all URLs in CLI output
- Remove eventsource-parser patch
- Add link-workspace-packages to .npmrc
- Fix Dockerfile: run esbuild install script, remove patches references
