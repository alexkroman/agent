# @alexkroman1/aai-cli

## 0.10.4

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

## 0.10.3

### Patch Changes

- 8d5f616: Use Hono builtins for WebSocket, security headers, and HTML escaping

  - Replace manual WebSocketServer + upgrade handling with @hono/node-ws
  - Replace custom escapeHtml() with Hono's html tagged template
  - Replace manual CSP string with secureHeaders middleware
  - Fix aai rag to use local dev server in dev mode
  - Fix vector upsert model loading in local dev mode
  - Add missing aws4fetch dependency for unstorage S3 driver

- Updated dependencies [8d5f616]
  - @alexkroman1/aai@0.10.3

## 0.10.2

### Patch Changes

- Updated dependencies [9de059e]
- Updated dependencies [1397f37]
  - @alexkroman1/aai@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies [aa23a1c]
  - @alexkroman1/aai@0.10.1

## 0.10.0

### Minor Changes

- Replace LanceDB with sqlite-vec for vector storage, add `generate` CLI command, extract templates to giget, local dev mode improvements, auth cleanup, and graceful shutdown fixes

### Patch Changes

- Updated dependencies
  - @alexkroman1/aai@0.10.0

## 0.9.4

### Patch Changes

- Release all packages with version increment
- Updated dependencies
  - @alexkroman1/aai@0.9.4

## 0.9.3

### Patch Changes

- Fix dependencies
  - @alexkroman1/aai@0.9.3

## 0.9.2

### Patch Changes

- Fixed dependencies
  - @alexkroman1/aai@0.9.2

## 0.9.1

### Patch Changes

- Update
- Updated dependencies
  - @alexkroman1/aai@0.9.1

## 0.9.0

### Minor Changes

- Updated toolchain

### Patch Changes

- Updated dependencies
  - @alexkroman1/aai@0.9.0
