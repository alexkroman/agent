# @alexkroman1/aai-server

## 0.9.16

### Patch Changes

- 4ebd7b6: Standardize file and directory naming to idiomatic kebab-case conventions

  - Add ls-lint for file naming enforcement
  - Drop underscore prefix from internal files in aai-server (e.g. `_schemas.ts` → `schemas.ts`)
  - Rename `_components` → `components` and `__fixtures__` → `fixtures` in aai-ui
  - Rename `__fixtures__` → `fixtures` in aai/host
  - Flatten aai-server by removing `src/` directory

- 68f4d84: Make more cross platform
- Updated dependencies [4ebd7b6]
- Updated dependencies [68f4d84]
  - @alexkroman1/aai@0.12.3

## 0.9.15

### Patch Changes

- @alexkroman1/aai@0.12.2

## 0.9.14

### Patch Changes

- 1b8b757: Fix changesets version command and sync scaffold versions during release
- f4762a1: Externalize zod from agent bundles, remove storage cache, improve CI reliability
- 1b960da: Remove zod dependency
- Updated dependencies [f4762a1]
  - @alexkroman1/aai@0.12.1

## 0.9.13

### Patch Changes

- Updated dependencies [99e62c3]
  - @alexkroman1/aai@0.12.0

## 0.9.12

### Patch Changes

- 79fe82c: Replace async-lock with p-lock for all per-slug concurrency control. Consolidate slug-lock.ts into sandbox-slots.ts with two named lock layers (slotLock for sandbox lifecycle, apiLock for deploy/delete serialization). Use AbortController to cancel stale idle-eviction callbacks. Use Promise.withResolvers() in sandbox.ts.

## 0.9.11

### Patch Changes

- c25ee7e: Trigger deploy for SDK and server
- Updated dependencies [c25ee7e]
  - @alexkroman1/aai@0.11.1

## 0.9.10

### Patch Changes

- 491ec37: CLI overhaul: remove generate command, unify output style, template descriptions

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

- 3a86d28: Fix isolate boot: run esbuild install script in Docker prod image
- 0fc9bb8: Fix isolate boot failure: run esbuild install script in Docker prod image
- Updated dependencies [491ec37]
  - @alexkroman1/aai@0.11.0

## 0.9.9

### Patch Changes

- 5deaf04: Increase isolate boot timeout to 15s for Fly.io cold starts
- 8816cfe: Increase isolate boot timeout to 15s for Fly.io cold starts

## 0.9.9

### Patch Changes

- 6f6a43e: Harden platform security and refactor to @hono/zod-validator

  - Fix crash in sandbox-network when host.internal hit without handler
  - Add Zod validation to KV bridge (isolate→host) replacing raw JSON.parse
  - Refactor deploy, secret, and KV handlers to use @hono/zod-validator middleware
  - Fix type errors in \_harness-runtime.ts and sandbox.ts
  - Remove factory.ts, inline into orchestrator
  - Add 185 new security tests for cross-agent isolation, SSRF, and trust boundaries

- Updated dependencies [6f6a43e]
  - @alexkroman1/aai@0.10.4

## 0.9.8

### Patch Changes

- Updated dependencies [8d5f616]
  - @alexkroman1/aai@0.10.3

## 0.9.7

### Patch Changes

- Updated dependencies [9de059e]
- Updated dependencies [1397f37]
  - @alexkroman1/aai@0.10.2

## 0.9.6

### Patch Changes

- Updated dependencies [aa23a1c]
  - @alexkroman1/aai@0.10.1

## 0.9.5

### Patch Changes

- Updated dependencies
  - @alexkroman1/aai@0.10.0

## 0.9.4

### Patch Changes

- Updated dependencies
  - @alexkroman1/aai@0.9.4

## 0.8.9

### Patch Changes

- Fix dependencies
  - @alexkroman1/aai@0.9.3
