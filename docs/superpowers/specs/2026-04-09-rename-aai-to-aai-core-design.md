# Rename `aai` to `aai-core`

## Summary

Rename `packages/aai/` from a public SDK package to `packages/aai-core/`, a
private internal shared library. Consolidate 10 export subpaths into 4 focused
barrels. Move user-facing testing utilities to `aai-cli`. Drop the self-hosted
path (`defineAgent`, `defineTool`, `createServer` as public API).

## Motivation

The `aai` package was designed as a public SDK, but it was never released and
has no external consumers. Its actual role is shared infrastructure between
`aai-cli`, `aai-server`, and `aai-ui`. The "SDK" branding creates confusion
about what's public vs internal. The 10 subpath exports (split into "public"
and "internal" categories) are an artifact of that framing.

## Decisions

- **Name**: `@alexkroman1/aai-core` (idiomatic Node convention)
- **Private**: `"private": true` — not published to npm
- **Self-hosted path**: removed (`defineAgent`, `defineTool`, `createServer` as
  public API are dropped)
- **Testing**: moves to `aai-cli` (user-facing test harness)
- **Exports**: consolidated from 10 subpaths to 4 focused barrels
- **No backward compatibility**: package was never released

## Package Identity

| Property | Before | After |
|---|---|---|
| Directory | `packages/aai/` | `packages/aai-core/` |
| npm name | `@alexkroman1/aai` | `@alexkroman1/aai-core` |
| private | no | yes |
| In changesets fixed group | yes | no |
| In scaffold package.json | yes (dependency) | no |

## Export Subpaths

### `.` (root) — shared fundamentals, no Node deps

Types, KV interface, hooks, utils, constants. Everything that any consumer
might need with no Node.js dependency.

**Exports**: `Kv`, `InMemoryKv`, `AgentHookMap`, `AgentHooks`,
`callResolveTurnConfig`, `createAgentHooks`, `HookFlags`, `errorMessage`,
`parseEnvFile`, `errorDetail`, `toolError`, `BuiltinTool`, `ToolChoice`,
`Message`, `ToolContext`, `HookContext`, `ToolDef`, `ToolResultMap`,
`AgentOptions`, `AgentDef`, `DEFAULT_SYSTEM_PROMPT`, `DEFAULT_GREETING`,
`BuiltinToolSchema`, `ToolChoiceSchema`, `MAX_WS_PAYLOAD_BYTES`, `AGENT_CSP`,
`DEFAULT_STT_SAMPLE_RATE`, `DEFAULT_TTS_SAMPLE_RATE`, `HOOK_TIMEOUT_MS`,
`TOOL_EXECUTION_TIMEOUT_MS`, `DEFAULT_SESSION_START_TIMEOUT_MS`,
`DEFAULT_IDLE_TIMEOUT_MS`, `FETCH_TIMEOUT_MS`, `RUN_CODE_TIMEOUT_MS`,
`DEFAULT_SHUTDOWN_TIMEOUT_MS`, `MAX_TOOL_RESULT_CHARS`, `MAX_PAGE_CHARS`,
`MAX_HTML_BYTES`, `MAX_VALUE_SIZE`, `DEFAULT_MAX_HISTORY`,
`MAX_MESSAGE_BUFFER_SIZE`.

**Source**: barrel re-exporting from `isolate/types.ts`, `isolate/kv.ts`,
`isolate/hooks.ts`, `isolate/_utils.ts`, `isolate/constants.ts`.

**Consumers**: `aai-cli`, `aai-server`, `aai-ui`.

### `./protocol` — wire format contract

WebSocket message schemas shared between server and client.

**Exports**: `AUDIO_FORMAT`, `MessageEnvelopeSchema`, `lenientParse`,
`KvRequestSchema`, `KvRequest`, `SessionErrorCodeSchema`, `SessionErrorCode`,
`ClientEventSchema`, `ClientEvent`, `ClientSink`, `AudioFormatId`,
`ReadyConfigSchema`, `ReadyConfig`, `ServerMessageSchema`, `ServerMessage`,
`ClientMessageSchema`, `ClientMessage`, `buildReadyConfig`,
`TurnConfigSchema`, `TurnConfig`.

**Source**: `isolate/protocol.ts` (unchanged).

**Consumers**: `aai-server`, `aai-ui`.

### `./runtime` — Node.js runtime engine

The full runtime stack for running agents. Requires Node.js.

**Exports**: `createRuntime`, `Runtime`, `RuntimeOptions`, `createServer`
(kept as internal utility for CLI dev server), `Session`, `SessionWebSocket`,
`wireSessionSocket`, `ExecuteTool`, `resolveAllBuiltins`,
`createUnstorageKv`, `toAgentConfig`, plus s2s, session-ctx, tool-executor
exports. Also includes `makeStubSession` (test utility used by `aai-server`).

**Source**: barrel re-exporting from `host/runtime.ts`, `host/server.ts`,
`host/s2s.ts`, `host/session.ts`, `host/session-ctx.ts`,
`host/ws-handler.ts`, `host/tool-executor.ts`, `host/builtin-tools.ts`,
`host/unstorage-kv.ts`, `host/runtime-config.ts`, `host/_test-utils.ts`.

**Consumers**: `aai-server`, `aai-cli` (dev server).

### `./manifest` — agent manifest parsing

Manifest schema, parsing, and tool-to-schema conversion.

**Exports**: `parseManifest`, `Manifest`, `ToolManifest`, `HookFlags`,
`agentToolsToSchemas`, `systemPromptTemplate`.

**Source**: `isolate/manifest.ts`, `isolate/_internal-types.ts`,
`isolate/system-prompt.ts`.

**Consumers**: `aai-cli`, `aai-server` (test only).

### Removed subpaths

| Old subpath | Disposition |
|---|---|
| `.` (old index) | Rewritten as new root barrel |
| `./server` | Self-hosted path dropped; `createServer` kept in `./runtime` as internal utility |
| `./testing` | Moved to `aai-cli/testing` |
| `./testing/matchers` | Moved to `aai-cli/testing/matchers` |
| `./isolate` | Replaced by root `.` |
| `./host` | Replaced by `./runtime` |
| `./types` | Absorbed into root `.` |
| `./kv` | Absorbed into root `.` |
| `./hooks` | Absorbed into root `.` |
| `./utils` | Absorbed into root `.` |

## Consumer Import Migration

### aai-cli

| Current import | New import |
|---|---|
| `@alexkroman1/aai/isolate` -> `parseManifest`, `HookFlags`, `Manifest`, `agentToolsToSchemas` | `@alexkroman1/aai-core/manifest` |
| `@alexkroman1/aai/utils` -> `errorMessage`, `parseEnvFile` | `@alexkroman1/aai-core` |
| `@alexkroman1/aai/server` -> `createRuntime`, `createServer`, `AgentServer` | `@alexkroman1/aai-core/runtime` |
| `@alexkroman1/aai/types` -> `AgentDef` | `@alexkroman1/aai-core` |

### aai-server

| Current import | New import |
|---|---|
| `@alexkroman1/aai/host` -> runtime symbols | `@alexkroman1/aai-core/runtime` |
| `@alexkroman1/aai/host` -> `errorMessage`, `AGENT_CSP` | `@alexkroman1/aai-core` |
| `@alexkroman1/aai/isolate` -> `MAX_WS_PAYLOAD_BYTES` | `@alexkroman1/aai-core` |
| `@alexkroman1/aai/protocol` -> schema/types | `@alexkroman1/aai-core/protocol` |
| `@alexkroman1/aai/types` -> `AgentDef`, `Message`, `ToolContext` | `@alexkroman1/aai-core` |
| `@alexkroman1/aai/kv` -> `Kv` | `@alexkroman1/aai-core` |
| `@alexkroman1/aai/hooks` -> `AgentHooks`, `callResolveTurnConfig`, `createAgentHooks` | `@alexkroman1/aai-core` |
| `@alexkroman1/aai/testing` -> `makeStubSession` | `@alexkroman1/aai-core/runtime` (kept as internal test util) |

### aai-ui

| Current import | New import |
|---|---|
| `@alexkroman1/aai/protocol` -> schemas/types | `@alexkroman1/aai-core/protocol` |
| `@alexkroman1/aai/utils` -> `errorMessage` | `@alexkroman1/aai-core` |

### aai-templates

| Current import | New import |
|---|---|
| `@alexkroman1/aai/testing` -> `createTestHarness` (14 test files) | `@alexkroman1/aai-cli/testing` |
| `@alexkroman1/aai` -> `ToolResultMap` (solo-rpg) | `@alexkroman1/aai-cli/types` |

## Testing Migration to aai-cli

### Files that move from `packages/aai/host/` to `packages/aai-cli/`

- `testing.ts` — `createTestHarness`, `TurnResult`, `TestHarness`,
  `RecordedToolCall`, `TestHarnessOptions`
- `matchers.ts` — `toHaveCalledTool` + `expect.extend()` side-effect
- `_mock-ws.ts` — `MockWebSocket`, `installMockWebSocket`

### Files that stay in `aai-core`

- `_test-utils.ts` (`flush`, `makeStubSession`) — used by `aai-server` tests
  directly, so must remain in core. `aai-cli/testing` re-exports from core.

### New aai-cli subpaths

- `@alexkroman1/aai-cli/testing` — `createTestHarness`, `MockWebSocket`,
  `installMockWebSocket`, `flush`, `makeStubSession`, `TurnResult`,
  `TestHarness`
- `@alexkroman1/aai-cli/testing/matchers` — `toHaveCalledTool` +
  auto-registration
- `@alexkroman1/aai-cli/types` — re-exports user-facing types from
  `aai-core` (`ToolResultMap`, `Message`, `ToolContext`, `AgentDef`, etc.)

### Scaffold changes

- `packages/aai-templates/scaffold/package.json`: remove `@alexkroman1/aai`
  from `dependencies`. `@alexkroman1/aai-cli` stays as `devDependencies`
  (provides binary + testing + types).
- `packages/aai-templates/scaffold/CLAUDE.md`: remove self-hosted path
  docs, update testing import to `@alexkroman1/aai-cli/testing`, update
  type import to `@alexkroman1/aai-cli/types`.

## Removed Code

### Self-hosted path — deleted

- `defineAgent` function from `isolate/types.ts` (keep `AgentDef` type)
- `defineTool`, `defineToolFactory` functions from `isolate/types.ts` (keep
  `ToolDef` type)
- `createServer` as a public SDK concept — the function itself stays in
  `host/server.ts` as an internal utility exported from `./runtime`
- `createAgentApp` function — unused outside `aai`, delete
- `ServerOptions` type — unused outside `aai`, delete
- `AgentServer` type — used by `aai-cli` (`_server-common.ts`,
  `_dev-server.ts`) as a type-only import, keep and export from `./runtime`

### Type-level tests — deleted

- `packages/aai/types.test-d.ts` — tested public SDK API contracts that no
  longer exist
- `packages/aai/published-exports.test.ts` — tested published exports
- Vitest project `aai-types` removed from root `vitest.config.ts`

### Old barrel files — rewritten

- `packages/aai/index.ts` → rewrite as new root barrel
- `packages/aai/isolate/index.ts` → remove
- `packages/aai/host/index.ts` → remove

## Config & Tooling Changes

### Workspace config

- Root `package.json` scripts: update `test:aai` filter and references
- Root `vitest.config.ts`: rename project `aai` -> `aai-core`, remove
  `aai-types` project
- `pnpm-workspace.yaml`: no change (directory rename is transparent)

### Changesets

- `.changeset/config.json`: remove `@alexkroman1/aai` from `fixed` array.
  Only `@alexkroman1/aai-ui` and `@alexkroman1/aai-cli` remain.
- No changeset file needed (aai-core is private, aai was never released).

### Build

- `packages/aai-core/package.json` exports map: rewrite to 4 new subpaths
  pointing at `.ts` source (dev mode convention)
- `packages/aai-core/tsconfig.json`: update if paths reference old name
- `scripts/check.sh`: update hardcoded references

### Documentation

- `agent/CLAUDE.md`: update architecture table, package name, dependency
  flow, export documentation, SDK structure section, test commands
- `packages/aai-templates/scaffold/CLAUDE.md`: remove self-hosted docs,
  update imports
