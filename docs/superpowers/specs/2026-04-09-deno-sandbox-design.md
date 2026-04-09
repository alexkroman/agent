# Deno Sandbox Guest Runtime

**Date:** 2026-04-09
**Branch:** feat/deno-sandbox
**Status:** Design approved, pending implementation plan

## Summary

Replace the Node.js guest runtime inside gVisor sandboxes with Deno. Remove
the self-hosted `defineAgent()` / `createServer()` path entirely. Only
directory-based agents (`agent.json` + `tools/*.ts` + `hooks/*.ts`) exist
after this change.

## Goals

- **Security:** Deno's built-in permission model (`--allow-env`, no net/fs/run
  by default) provides defense-in-depth on top of gVisor.
- **Simplicity:** Deno runs TypeScript natively, eliminating the CJS transform
  pipeline and dynamic code evaluation in the guest.
- **Smaller footprint:** Single Deno binary replaces Node binary + bundled
  harness in the sandbox rootfs.
- **Developer experience:** ESM-native bundling, no CJS conversion artifacts.

## Scope

- **In scope:** Platform sandbox guest, bundling pipeline, host-side transport,
  SDK cleanup (remove self-hosted path), Docker images, tests, documentation.
- **Out of scope:** Self-hosted Deno support. The host (`aai-server`) stays
  Node.js.

## Design

### 1. NDJSON Transport Layer

**Replaces:** `vscode-jsonrpc` on both host and guest sides.

**Protocol:** One JSON object per line (`JSON.stringify(msg) + "\n"`). Wire
format follows JSON-RPC 2.0 structure (`id`, `method`, `params`, `result`,
`error` fields).

**Host side** (`packages/aai-server/ndjson-transport.ts`):
- `createNdjsonConnection(readable: Readable, writable: Writable)` returns a
  `Connection` with: `sendRequest()`, `sendNotification()`, `onRequest()`,
  `onNotification()`, `listen()`, `dispose()`.
- Uses `node:readline` `createInterface()` for line splitting on the readable
  stream.
- Pending request map keyed by auto-incrementing `id`.

**Guest side** (inline in Deno harness):
- `TextLineStream` from `@std/streams` on `Deno.stdin.readable`.
- `TextEncoder` + `Deno.stdout.writable` for writing.
- Self-contained, no workspace imports.

**Message types (unchanged):**
```
Host -> Guest: bundle/load, tool/execute, hook/invoke, shutdown
Guest -> Host: kv/get, kv/set, kv/del
```

### 2. ESM Bundling Pipeline

**Replaces:** CJS transform pipeline in `_bundler.ts`.

- esbuild outputs `format: "esm"` for directory-based agents (tools + hooks).
- `transformBundleForEval()` and CJS rewriting deleted.
- `extractAgentConfig()` and `node:vm` usage in bundler deleted (only existed
  for single-file `agent.ts` path which is removed).
- Agent metadata comes from `agent.json` + scanner (already the case for
  directory-based agents).
- Tool schemas extracted statically from tool file exports at scan/build time.
- Bundle delivered via `bundle/load` RPC, loaded in guest via dynamic
  `data:` URL import (`await import("data:application/javascript,...")`).

**Deleted:**
- `transformBundleForEval()`
- `extractAgentConfig()`
- Vite SSR single-file build path
- `node:vm` import in bundler

### 3. Deno Guest Harness

**Replaces:** `guest/harness.ts` + `guest/harness-logic.ts` +
`harness-runtime.ts`.

**New file:** `packages/aai-server/guest/deno-harness.ts` -- self-contained
Deno script, no workspace imports.

**Boot sequence:**
1. Read NDJSON lines from `Deno.stdin.readable` via `TextLineStream`.
2. First message is `bundle/load` with `{ code, env }`.
3. Set env vars: `Deno.env.set("AAI_ENV_" + key, value)` for each entry.
4. Load agent: dynamic `data:` URL import of the ESM bundle code.
5. Extract tools/hooks from `mod.default`.
6. Register RPC handlers for `tool/execute` and `hook/invoke`.
7. Respond to `shutdown` notification with `Deno.exit(0)`.

**RPC dispatch** (same logic as current `harness-logic.ts`):
- `tool/execute` -- Zod parse args, build context (env, state, kv, messages),
  call tool handler, return result + state.
- `hook/invoke` -- dispatch to hook handler, return state + optional result.
- `kv/*` -- send requests to host, await response.
- Tool timeout: 30s via `Promise.race` with `setTimeout`.

**Deno permissions** (defense-in-depth on top of gVisor):
- `--allow-env` -- needed for `AAI_ENV_*` injection.
- `--no-prompt` -- deny everything else by default.
- No `--allow-net`, `--allow-read`, `--allow-write`, `--allow-run`.

**Deleted:**
- `guest/harness.ts` (Node.js harness)
- `guest/harness-logic.ts` (shared logic -- absorbed into `deno-harness.ts`)
- `harness-runtime.ts` (legacy SecureExec dispatcher)

### 4. Sandbox VM, gVisor & Docker Changes

**`sandbox-vm.ts`:**
- Spawn `deno run --allow-env --no-prompt <harness>` instead of `node`/`fork()`.
- Dev sandbox (macOS): `child_process.spawn("deno", [...])`. Requires Deno
  installed locally.

**`gvisor.ts`:**
- Mount Deno binary in rootfs instead of Node binary.
- Same gVisor flags: `--rootless`, `--network=none`, `--ignore-cgroups`, tmpfs
  overlay.

**Host-side connection (`sandbox.ts`):**
- `createNdjsonConnection(child.stdout, child.stdin)` replaces
  `StreamMessageReader` / `StreamMessageWriter` from vscode-jsonrpc.

**Docker changes:**

| File | Change |
|------|--------|
| `packages/aai-server/Dockerfile` | Install Deno binary alongside Node. Update `GUEST_HARNESS_PATH`. |
| `packages/aai-server/guest/Dockerfile.gvisor` | Install Deno binary for gVisor integration tests. |
| `Dockerfile.test` | Install Deno binary for sandbox-related tests. |
| `packages/aai-templates/scaffold/Dockerfile` | No change (user deploy container, not sandbox). |

### 5. SDK Cleanup -- Remove Self-Hosted Path

**Deleted from `packages/aai/`:**
- `host/server.ts` -- `createServer`, `createAgentApp`
- `host/runtime.ts` -- `createRuntime`, `Runtime`, `RuntimeOptions`
- `host/runtime-config.ts`
- `host/tool-executor.ts`
- `host/session.ts`, `host/session-ctx.ts`
- `host/s2s.ts`
- `host/ws-handler.ts`
- `host/builtin-tools.ts`
- `host/_run-code.ts` -- `node:vm` sandbox for `run_code`

**Deleted exports from `package.json`:**
- `./server` export removed entirely.
- `.` export updated: remove `defineAgent`, `defineTool` re-exports.

**Kept:**
- `isolate/` modules (types, protocol, kv, hooks, manifest, utils).
- `./testing` export (test harness for agent directories).
- `./types`, `./kv`, `./protocol` exports.
- `host/testing.ts`, `host/matchers.ts` (test utilities).
- `host/unstorage-kv.ts` (used by platform server).

**`run_code` builtin tool:** Needs Deno-native replacement for the `node:vm`
eval execution. Security boundary is gVisor, not the eval mechanism.

### 6. Testing Strategy

**Unit tests:**
- `ndjson-transport.test.ts` -- host-side NDJSON connection: framing,
  request/response correlation, notifications, errors.
- `deno-harness.test.ts` -- guest harness logic.
- `sandbox-vm.test.ts` -- updated for Deno spawning.
- `_bundler.test.ts` -- remove CJS transform tests, verify ESM output.

**Integration tests:**
- `fake-vm-integration.test.ts` -- spawn Deno guest harness locally, full RPC
  round-trip.
- `sandbox-integration.test.ts` -- updated for NDJSON + Deno.

**gVisor integration tests:**
- Updated for Deno binary in sandbox.
- Verify Deno permission denials (net/fs/run blocked).
- Verify env injection via `Deno.env`.

**E2E tests:**
- Unchanged -- transparent to browser client.

**Deleted tests:**
- `extractAgentConfig`, `transformBundleForEval` tests.
- `createServer`/`createRuntime`/`defineAgent` tests.
- `run_code` `node:vm` tests (replaced with Deno equivalent).

**CI requirement:** Deno must be installed in CI and documented for local dev.

### 7. Documentation Updates

**CLAUDE.md (root + agent/):**
- Remove self-hosted references.
- Update architecture: guest runs Deno.
- Update SDK structure, key files, security model.
- Document Deno requirement for dev.

**`packages/aai-templates/scaffold/CLAUDE.md`:**
- Remove "Self-hosting with `createServer()`" section.
- Remove "Headless voice session" section.

**Package changes:**
- `@alexkroman1/aai` -- remove `./server` export.
- `@alexkroman1/aai-server` -- remove `vscode-jsonrpc` dependency.

**Changeset:** Major bump -- breaking change (removes `./server` export and
`defineAgent`/`defineTool`).
