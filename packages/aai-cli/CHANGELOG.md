# @alexkroman1/aai-cli

## 1.0.1

### Patch Changes

- b4ff42e: Redeploy aai-server and refresh client/CLI/SDK releases
- Updated dependencies [5517333]
- Updated dependencies [5d55c12]
- Updated dependencies [b4ff42e]
  - aai@1.0.1

## 1.0.0

### Minor Changes

- befca9a: Simplify agent surface area: directory-based agent format with agent.json, tools/_.ts, hooks/_.ts replacing defineAgent/Zod
- d06b4fd: Remove global ASSEMBLYAI_API_KEY — each agent provides its own key via .env
- 0456e37: Replace esbuild with Vite library mode, unify dev/prod on tools.ts + agent.json
- 94bc25a: Prompt for AssemblyAI API key once on first use, store globally in ~/.config/aai/config.json
- 192d8ae: Fix deploy pipeline, streamline scaffold, improve dev CLI workflow
- 7b451c7: Extract agent config at build time and defer V8 isolate boot until custom tool/hook execution
- 26d9d44: Remove template selection from aai init — always scaffolds the simple template
- bb87a1d: Add structured JSON output for all CLI commands (auto-detected in non-TTY, --json flag)

### Patch Changes

- 9211c65: Add default aai-ui client served by the server when no custom client is deployed. Remove zod externalization from the worker bundler — zod 4 works natively in Deno sandboxes. Update S2S API endpoint and fix load test event handling.
- f6e7a5c: BREAKING: Align SDK naming with S2S API

  - `instructions` → `systemPrompt` in AgentOptions/AgentDef
  - `DEFAULT_INSTRUCTIONS` → `DEFAULT_SYSTEM_PROMPT`
  - `onTurn` → `onUserTranscript` hook
  - Protocol events renamed: `transcript` → `user_transcript_delta`, `turn` → `user_transcript`, `chat` → `agent_transcript`, `chat_delta` → `agent_transcript_delta`, `tts_done` → `reply_done`, `tool_call_start` → `tool_call`

- 05f8759: Replace hand-rolled utilities with dependencies: dotenv for .env parsing, mime-types and escape-html in dev server, p-debounce for file watcher
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
- Updated dependencies [1678546]
- Updated dependencies [5fd5cb3]
- Updated dependencies [64d83b6]
- Updated dependencies [6d3ec72]
  - aai@1.0.0

## 0.12.3

### Patch Changes

- 55afc5c: Fix release workflow to trigger CI on version PRs
- 68f4d84: Make more cross platform
- Updated dependencies [4ebd7b6]
- Updated dependencies [68f4d84]
  - @alexkroman1/aai@0.12.3

## 0.12.2

### Patch Changes

- 5900685: Add centralized error handling to CLI commands
- 5e3538c: Skip changeset-status pre-push hook on changeset-release branches to fix release workflow
- 59a9a10: Use pnpm for scaffolded projects and accept --server flag on all commands
  - @alexkroman1/aai@0.12.2

## 0.12.1

### Patch Changes

- 1b8b757: Fix changesets version command and sync scaffold versions during release
- f4762a1: Externalize zod from agent bundles, remove storage cache, improve CI reliability
- 1b960da: Remove zod dependency
- Updated dependencies [f4762a1]
  - @alexkroman1/aai@0.12.1

## 0.12.0

### Patch Changes

- e2f72a2: Auto-sync scaffold package.json versions with workspace packages during release
- Updated dependencies [99e62c3]
  - @alexkroman1/aai@0.12.0

## 0.11.1

### Patch Changes

- Updated dependencies [c25ee7e]
  - @alexkroman1/aai@0.11.1

## 0.11.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [491ec37]
  - @alexkroman1/aai@0.11.0

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
