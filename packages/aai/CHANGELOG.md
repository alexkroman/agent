# @alexkroman1/aai

## 0.12.2

## 0.12.1

### Patch Changes

- f4762a1: Externalize zod from agent bundles, remove storage cache, improve CI reliability

## 0.12.0

### Minor Changes

- 99e62c3: Remove `memoryTools()` and the `"memory"` builtin tool. Users who need KV-backed memory tools should define them directly in their agent's `tools` record.

## 0.11.1

### Patch Changes

- c25ee7e: Trigger deploy for SDK and server

## 0.11.0

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

## 0.10.4

### Patch Changes

- 6f6a43e: Harden platform security and refactor to @hono/zod-validator

  - Fix crash in sandbox-network when host.internal hit without handler
  - Add Zod validation to KV bridge (isolate→host) replacing raw JSON.parse
  - Refactor deploy, secret, and KV handlers to use @hono/zod-validator middleware
  - Fix type errors in \_harness-runtime.ts and sandbox.ts
  - Remove factory.ts, inline into orchestrator
  - Add 185 new security tests for cross-agent isolation, SSRF, and trust boundaries

## 0.10.3

### Patch Changes

- 8d5f616: Use Hono builtins for WebSocket, security headers, and HTML escaping

  - Replace manual WebSocketServer + upgrade handling with @hono/node-ws
  - Replace custom escapeHtml() with Hono's html tagged template
  - Replace manual CSP string with secureHeaders middleware
  - Fix aai rag to use local dev server in dev mode
  - Fix vector upsert model loading in local dev mode
  - Add missing aws4fetch dependency for unstorage S3 driver

## 0.10.2

### Patch Changes

- 9de059e: Add repository.url for npm provenance, fix circular dependency, bump CI actions
- 1397f37: Fix Fly deploy config path and CI improvements

## 0.10.1

### Patch Changes

- aa23a1c: Add repository.url for npm provenance, fix circular dependency, bump CI actions

## 0.10.0

### Minor Changes

- Replace LanceDB with sqlite-vec for vector storage, add `generate` CLI command, extract templates to giget, local dev mode improvements, auth cleanup, and graceful shutdown fixes

## 0.9.4

### Patch Changes

- Release all packages with version increment

## 0.9.3

## 0.9.2

## 0.9.1

### Patch Changes

- Update

## 0.9.0

### Minor Changes

- Updated toolchain
