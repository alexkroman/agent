# @alexkroman1/aai

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
