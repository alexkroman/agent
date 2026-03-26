# API Consistency QA Report

## Summary

Analysis of all four workspace packages (`aai`, `aai-ui`, `aai-cli`, `aai-server`) reveals several API design inconsistencies including duplicate type names across packages, naming convention mismatches, internal implementation details leaking through public exports, missing JSDoc on exported symbols, and a circular dependency between core modules. Fourteen concrete issues are documented below.

## Issues Found

### Issue 1: Duplicate `Message` type with incompatible shapes across packages
- **File**: `packages/aai/types.ts:138`, `packages/aai-ui/types.ts:27`
- **Severity**: High
- **Description**: Both `@alexkroman1/aai` and `@alexkroman1/aai-ui` export a type named `Message`, but with different shapes. The SDK version has `role: "user" | "assistant" | "tool"` (3 roles), while the UI version has `role: "user" | "assistant"` (2 roles). Both are re-exported from their respective package entry points (`aai/index.ts:32`, `aai-ui/index.ts:49`). A consumer importing from both packages will encounter an ambiguous `Message` type with no compiler warning unless both are imported in the same file.
- **Recommendation**: Rename one of them (e.g. `ChatMessage` in aai-ui) or have aai-ui re-export the SDK's `Message` type and use a narrower alias internally. At minimum, the UI `Message` should be documented as a subset of the SDK's `Message`.

### Issue 2: Duplicate `SessionOptions` type name across packages with entirely different shapes
- **File**: `packages/aai/session.ts:39`, `packages/aai-ui/types.ts:76`
- **Severity**: High
- **Description**: `SessionOptions` in `packages/aai/session.ts` configures a server-side S2S session (with fields like `apiKey`, `agentConfig`, `toolSchemas`, `executeTool`), while `SessionOptions` in `packages/aai-ui/types.ts` configures a client-side voice session (with `platformUrl`, `signal`, `batch`). Both are exported from their respective packages. The server-side version is exported via `@alexkroman1/aai/session` and the client version via `@alexkroman1/aai-ui`. This creates confusion for anyone working with both packages.
- **Recommendation**: Rename to `S2sSessionOptions` (server) and `VoiceSessionOptions` (client) to disambiguate.

### Issue 3: Inconsistent deletion method naming between `Kv` and `VectorStore` interfaces
- **File**: `packages/aai/kv.ts:81` (`delete`), `packages/aai/vector.ts:72` (`remove`)
- **Severity**: Medium
- **Description**: The `Kv` interface uses `delete(key)` for removing entries, while the sibling `VectorStore` interface uses `remove(ids)` for the same conceptual operation. Both are core storage abstractions exposed via `ToolContext` and `HookContext`. The inconsistency is further compounded in `aai-server/src/kv.ts:11` where the server-side `KvStore` uses yet a third name: `del()`.
- **Recommendation**: Standardize on a single name. `delete` is the natural choice (matching `Map.delete`), or `remove` everywhere. The server `KvStore.del` should also be aligned.

### Issue 4: Circular dependency between `types.ts` and `define-agent.ts`
- **File**: `packages/aai/types.ts:441`, `packages/aai/define-agent.ts:17`
- **Severity**: Medium
- **Description**: `types.ts` re-exports `defineAgent`, `BuiltinToolSchema`, and `ToolChoiceSchema` from `define-agent.ts`, while `define-agent.ts` imports `AgentDef`, `AgentOptions`, `BuiltinTool`, `DEFAULT_GREETING`, `DEFAULT_INSTRUCTIONS`, and `ToolChoice` from `types.ts`. Both files carry biome-ignore comments acknowledging the cycle. This circular dependency makes it unclear which module "owns" each symbol and complicates tree-shaking.
- **Recommendation**: Move all Zod schemas and the `defineAgent` function into `types.ts` (since it already re-exports them), or create a dedicated `schemas.ts` that both modules import from without cycles.

### Issue 5: Export path `./internal-types` maps to file `_internal-types.ts` -- inconsistent naming convention
- **File**: `packages/aai/package.json:59-63`
- **Severity**: Medium
- **Description**: The package.json export `"./internal-types"` maps to source file `./_internal-types.ts`. The underscore prefix convention (`_`) is used throughout the codebase to signal "private/internal" files (e.g. `_utils.ts`, `_mock-ws.ts`), yet this file is explicitly exported as a public subpath. The export path drops the underscore prefix, creating a mismatch between the import specifier (`@alexkroman1/aai/internal-types`) and the actual filename (`_internal-types.ts`). Similarly, `./utils` maps to `./_utils.ts`.
- **Recommendation**: Either rename the files to drop the underscore (since they are exported), or add the underscore to the export path to be consistent, or mark them as `@internal` and remove from package.json exports.

### Issue 6: Hardcoded version string in `telemetry.ts` will drift from `package.json`
- **File**: `packages/aai/telemetry.ts:28`
- **Severity**: Medium
- **Description**: The OpenTelemetry scope version is hardcoded as `const VERSION = "0.9.3"` rather than being derived from `package.json`. When the package version bumps (currently at `0.9.3`), this constant must be manually updated. If forgotten, telemetry will report the wrong SDK version, making production debugging misleading.
- **Recommendation**: Import the version from `package.json` at build time, or use a build-time replacement plugin to inject it.

### Issue 7: `_internals` test-seam pattern exported from public modules without `@internal` annotation
- **File**: `packages/aai/session.ts:55`, `packages/aai-server/src/sandbox.ts:270`, `packages/aai-server/src/metrics.ts:169`, `packages/aai-server/src/transport-websocket.ts:10`
- **Severity**: Low
- **Description**: Multiple modules export `const _internals = { ... }` as a testing seam to allow mocking internal functions. While the underscore prefix signals "private", these are regular `export` statements and appear in the compiled output. Consumers can import and depend on them. None carry a `@internal` JSDoc tag.
- **Recommendation**: Add `/** @internal */` JSDoc to all `_internals` exports so API Extractor can flag them, and document that they are not part of the public API contract.

### Issue 8: Missing `@public` JSDoc tags on all exports in `server.ts`, `runtime.ts`, and `telemetry.ts`
- **File**: `packages/aai/server.ts`, `packages/aai/runtime.ts`, `packages/aai/telemetry.ts`
- **Severity**: Medium
- **Description**: The core public types in `types.ts`, `kv.ts`, `vector.ts`, and `testing.ts` all carry `@public` JSDoc tags. However, the exported types and functions in `server.ts` (`ServerOptions`, `AgentServer`, `createServer`), `runtime.ts` (`Logger`, `LogContext`, `S2SConfig`, `consoleLogger`, `DEFAULT_S2S_CONFIG`), and `telemetry.ts` (`tracer`, `meter`, `withSpan`, all counters/histograms) have no `@public` tags at all. This inconsistency means API Extractor cannot enforce the public API surface for these subpath exports.
- **Recommendation**: Add `@public` to all intentionally public exports in these modules, and `@internal` to those that are implementation details.

### Issue 9: `HookInvoker` interface uses inconsistent parameter naming (`sessionId` vs `sid`)
- **File**: `packages/aai/middleware.ts:37-62`
- **Severity**: Low
- **Description**: The `HookInvoker` type uses `sessionId` for `onConnect`, `onDisconnect`, `onTurn`, `onError`, and `onStep`, but switches to `sid` for `resolveTurnConfig`, `beforeTurn`, `afterTurn`, `interceptToolCall`, `afterToolCall`, and `filterOutput`. The timeout parameter also switches between `timeoutMs` and `ms`. This inconsistency exists within a single type definition spanning 25 lines.
- **Recommendation**: Use `sessionId` and `timeoutMs` consistently throughout the interface.

### Issue 10: `aai-ui` re-exports `SessionErrorCodeSchema` (a Zod runtime value) from a types-focused module
- **File**: `packages/aai-ui/types.ts:50`, `packages/aai-ui/index.ts:53`
- **Severity**: Medium
- **Description**: `aai-ui/types.ts` re-exports the Zod schema `SessionErrorCodeSchema` from `@alexkroman1/aai/protocol`. This means the UI package's main entry point ships a Zod runtime dependency to browser consumers, even though the schema is only needed for validation (which happens server-side). The `SessionErrorCode` type alone would suffice for the UI. This increases the UI bundle size unnecessarily.
- **Recommendation**: Only export the `SessionErrorCode` type from `aai-ui`. If validation is needed client-side, document why and keep it; otherwise remove the runtime Zod schema re-export.

### Issue 11: `Kv.set` TTL unit is milliseconds, but `KvStore.set` (server) TTL unit is seconds
- **File**: `packages/aai/kv.ts:75` (milliseconds via `expireIn`), `packages/aai-server/src/kv.ts:11` (seconds via `ttl`)
- **Severity**: High
- **Description**: The public `Kv` interface documents TTL as `expireIn` in **milliseconds** (e.g. `{ expireIn: 60_000 }` for 1 minute). The server-side `KvStore.set` accepts a `ttl` parameter in **seconds** (passed directly to Redis `{ ex: ttl }`). The naming differs (`expireIn` vs `ttl`) and the units differ (ms vs s). Since the harness runtime bridges between these two interfaces, a unit mismatch bug is easy to introduce and hard to detect.
- **Recommendation**: Standardize on one unit (milliseconds, matching the public API) and one parameter name (`expireIn` or `ttl`). Add explicit JSDoc stating the unit on both interfaces.

### Issue 12: S2S types use `snake_case` while the rest of the SDK uses `camelCase`
- **File**: `packages/aai/s2s.ts:143-160`
- **Severity**: Low
- **Description**: The `S2sSessionConfig` type uses `system_prompt` (snake_case), while the rest of the SDK exclusively uses camelCase for TypeScript-facing properties (e.g. `sttPrompt`, `toolChoice`, `maxSteps`). Similarly, `S2sToolCall` uses `call_id` instead of `callId`. The `S2sEvents` map also mixes conventions: event names use `snake_case` (`speech_started`, `user_transcript_delta`) while the broader `ClientEvent` protocol uses `snake_case` for some (`tool_call_start`) but `camelCase` for fields (`toolCallId`, `toolName`). This happens because S2S types mirror the AssemblyAI wire format, but the inconsistency leaks into the exported API surface.
- **Recommendation**: Create internal wire-format types that mirror the S2S API verbatim, and separate SDK-facing types that use camelCase consistently. Map between them at the boundary.

### Issue 13: `aai-ui` `index.ts` and `components.ts` are near-identical barrel files
- **File**: `packages/aai-ui/index.ts`, `packages/aai-ui/components.ts`
- **Severity**: Low
- **Description**: `index.ts` exports everything that `components.ts` exports, plus `VoiceSession`, `createVoiceSession`, and session-related types. The `components.ts` barrel exists as the `./components` subpath export, but it re-exports the exact same component set as the root entry. This means `import { App } from "@alexkroman1/aai-ui"` and `import { App } from "@alexkroman1/aai-ui/components"` are equivalent, which is confusing and provides no actual tree-shaking benefit since both resolve to the same component implementations.
- **Recommendation**: Either make `./components` export only the leaf components (without `mount`, `SessionProvider`, etc.) to provide genuine separation, or remove the `./components` subpath entirely and direct users to the root import.

### Issue 14: `VectorStore.remove` accepts `string | string[]` while `Kv.delete` only accepts `string`
- **File**: `packages/aai/vector.ts:72`, `packages/aai/kv.ts:81`
- **Severity**: Low
- **Description**: For batch operations, `VectorStore.remove` accepts either a single ID or an array of IDs (`ids: string | string[]`), while `Kv.delete` only accepts a single key (`key: string`). These are sibling interfaces exposed together in `ToolContext`, so users expect consistent patterns. There is no batch-delete capability on the KV side, even though batch operations are common (e.g. clearing all keys with a prefix requires listing then deleting one-by-one).
- **Recommendation**: Add a batch variant to `Kv.delete` (either overload or a separate `deleteMany` method), or document why the asymmetry is intentional.
