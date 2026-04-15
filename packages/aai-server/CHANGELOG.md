# @alexkroman1/aai-server

## 1.0.9

### Patch Changes

- Updated dependencies [ed0dfbb]
- Updated dependencies [231ebc1]
  - @alexkroman1/aai@1.2.0
  - @alexkroman1/aai-ui@1.2.0

## 1.0.8

### Patch Changes

- db7a96c: Replace host / rootfs with empty directory + bind mounts in gVisor sandbox; tighten dev mode env vars and filesystem access
- a6bf890: Defer sandbox VM startup until first tool call for faster WebSocket connections

## 1.0.7

### Patch Changes

- 5cda7c5: Add ctx.send for real-time tool-to-client events

  Tools can now push arbitrary events to the browser client via `ctx.send(event, data)`. Events flow over the existing WebSocket as `custom_event` messages. The new `useEvent` React hook subscribes to named events. Migrated solo-rpg, pizza-ordering, dispatch-center, and night-owl templates from `useToolResult` to `ctx.send` + `useEvent`.

- Updated dependencies [5cda7c5]
- Updated dependencies [41fab1a]
- Updated dependencies [f342260]
  - @alexkroman1/aai@1.1.0
  - @alexkroman1/aai-ui@1.1.0

## 1.0.6

### Patch Changes

- 27faac9: Fix missing CSS in scaffolded agents: remove client.tsx and index.html from scaffold, serve pre-built default UI when no custom client exists, provide fallback index.html via Vite plugin for custom clients
  - @alexkroman1/aai@1.0.6
  - @alexkroman1/aai-ui@1.0.6

## 1.0.5

### Patch Changes

- b3bafa7: Fix missing CSS in scaffolded agents: remove client.tsx and index.html from scaffold, serve pre-built default UI when no custom client exists, provide fallback index.html via Vite plugin for custom clients
  - @alexkroman1/aai@1.0.5
  - @alexkroman1/aai-ui@1.0.5

## 1.0.4

### Patch Changes

- @alexkroman1/aai@1.0.4
- @alexkroman1/aai-ui@1.0.4

## 1.0.3

### Patch Changes

- @alexkroman1/aai@1.0.3
- @alexkroman1/aai-ui@1.0.3

## 1.0.2

### Patch Changes

- 76d25d4: Deploy server: picks up @alexkroman1/aai fix that stops vitest from leaking into the runtime barrel bundle.
- a3d3835: Force all libraries and the server to publish/deploy after the 1.0.1
  release failure. Restores the `@alexkroman1/` scope on publishable
  packages so npm accepts the publish, and bumps `aai-server` to trigger
  the Fly.io deploy job in the release workflow.
- Updated dependencies [76d25d4]
- Updated dependencies [a3d3835]
  - @alexkroman1/aai@1.0.2
  - @alexkroman1/aai-ui@1.0.2

## 1.0.1

### Patch Changes

- b4ff42e: Redeploy aai-server and refresh client/CLI/SDK releases
- Updated dependencies [5517333]
- Updated dependencies [5d55c12]
- Updated dependencies [b4ff42e]
  - aai@1.0.1
  - aai-ui@1.0.1

## 1.0.0

### Major Changes

- 874001a: Replace Firecracker with gVisor sandbox + vscode-jsonrpc (no KVM, works on Fly.io)
- 36a8e75: Replace secure-exec V8 isolates with per-agent Firecracker microVMs for hardware-level cross-agent isolation

### Minor Changes

- 8ecb7d1: Add protocol compat fixtures and harden wire format for rolling upgrades
- befca9a: Simplify agent surface area: directory-based agent format with agent.json, tools/_.ts, hooks/_.ts replacing defineAgent/Zod
- 9211c65: Add default aai-ui client served by the server when no custom client is deployed. Remove zod externalization from the worker bundler — zod 4 works natively in Deno sandboxes. Update S2S API endpoint and fix load test event handling.
- 1f5bbb1: Replace HTTP sidecar and RPC server with secure-exec bindings IPC
- 7b451c7: Extract agent config at build time and defer V8 isolate boot until custom tool/hook execution

### Patch Changes

- 3bd18a9: Fix security vulnerabilities: run_code sandbox escape, SSRF wiring, credential key enforcement, DNS rebinding, path traversal, harness auth bypass, timing-safe hash comparison
- b9b5c02: Deduplicate shared utilities, fix N+1 KV list, async static serving, and race timer leak
- d890d04: Remove backward compatibility in agent config launching — agentConfig is now required
- dc9d402: Remove deprecated terminate() backwards compat alias on Sandbox type
- a3fde24: Remove redundant validateWorkerBundle from deploy handler
- 5cc9550: Security hardening: deploy ownership check, SSRF DNS fail-closed + hostname blocking, timing-safe auth tokens, run_code timer cleanup, WebSocket payload limits, message buffer cap, clientFiles size limits, HTML escape completeness, KV error sanitization
- 0da527e: Add adversarial chaos tests, lower jail memory limit, plug sandbox eviction leaks, validate agent bundles at deploy time
- f6e7a5c: BREAKING: Align SDK naming with S2S API

  - `instructions` → `systemPrompt` in AgentOptions/AgentDef
  - `DEFAULT_INSTRUCTIONS` → `DEFAULT_SYSTEM_PROMPT`
  - `onTurn` → `onUserTranscript` hook
  - Protocol events renamed: `transcript` → `user_transcript_delta`, `turn` → `user_transcript`, `chat` → `agent_transcript`, `chat_delta` → `agent_transcript_delta`, `tts_done` → `reply_done`, `tool_call_start` → `tool_call`

- 061a04f: Update secure-exec to 0.2.1, replace virtual hosts with real sidecar server
- 1678546: Simplify codebase: use p-timeout for shutdown, html-to-text for HTML conversion, deduplicate secret key validation
- d6ad61e: Harden nsjail: restrict socket() to AF_UNIX, add cgroup namespace and rlimit_nproc, add post-escape integration tests
- fa7b928: Change default dev server port from 8787 to 8080
- Updated dependencies [8ecb7d1]
- Updated dependencies [3bd18a9]
- Updated dependencies [befca9a]
- Updated dependencies [9211c65]
- Updated dependencies [b9b5c02]
- Updated dependencies [99db30d]
- Updated dependencies [5cc9550]
- Updated dependencies [4c1cd20]
- Updated dependencies [ab98c61]
- Updated dependencies [837e34f]
- Updated dependencies [f6e7a5c]
- Updated dependencies [7669733]
- Updated dependencies [14d0653]
- Updated dependencies [9d2141b]
- Updated dependencies [05f8759]
- Updated dependencies [486fb23]
- Updated dependencies [1678546]
- Updated dependencies [5fd5cb3]
- Updated dependencies [64d83b6]
- Updated dependencies [6d3ec72]
  - aai@1.0.0
  - aai-ui@1.0.0

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
