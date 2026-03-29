# @alexkroman1/aai-server

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
