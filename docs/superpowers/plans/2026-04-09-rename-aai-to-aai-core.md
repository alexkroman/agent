# Rename `aai` to `aai-core` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `packages/aai/` to `packages/aai-core/`, make it private, consolidate 10 export subpaths to 4, move testing to `aai-cli`, drop the self-hosted public API.

**Architecture:** The `aai` package becomes `aai-core` — a private internal shared library with 4 focused export barrels (`.`, `./protocol`, `./runtime`, `./manifest`). Testing utilities move to `aai-cli/testing`. The self-hosted SDK surface (`defineAgent`, `defineTool`, `createServer` as public API) is removed.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Biome, changesets

---

### Task 1: Rename directory and update package identity

**Files:**
- Modify: `packages/aai/package.json` (becomes `packages/aai-core/package.json` after rename)

- [ ] **Step 1: Rename the directory**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/investigate-aai-pkg
git mv packages/aai packages/aai-core
```

- [ ] **Step 2: Update package.json name, add private flag, update repository directory**

In `packages/aai-core/package.json`:

Change `"name": "@alexkroman1/aai"` to `"name": "@alexkroman1/aai-core"`.

Add `"private": true` after the name field.

Change `"directory": "packages/aai"` to `"directory": "packages/aai-core"`.

Remove the `"files": ["dist"]` field (private packages don't need it).

Remove the `peerDependencies` and `peerDependenciesMeta` for vitest (testing is moving to aai-cli).

Remove `"check:publint"` and `"check:attw"` scripts (private packages don't need package validation).

- [ ] **Step 3: Rewrite the exports map to the 4 new subpaths**

Replace the entire `"exports"` field in `packages/aai-core/package.json` with:

```json
"exports": {
  ".": {
    "@dev/source": "./index.ts",
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  },
  "./protocol": {
    "@dev/source": "./isolate/protocol.ts",
    "types": "./dist/isolate/protocol.d.ts",
    "import": "./dist/isolate/protocol.js"
  },
  "./runtime": {
    "@dev/source": "./host/runtime-barrel.ts",
    "types": "./dist/host/runtime-barrel.d.ts",
    "import": "./dist/host/runtime-barrel.js"
  },
  "./manifest": {
    "@dev/source": "./isolate/manifest-barrel.ts",
    "types": "./dist/isolate/manifest-barrel.d.ts",
    "import": "./dist/isolate/manifest-barrel.js"
  }
}
```

- [ ] **Step 4: Run pnpm install to update workspace resolution**

```bash
pnpm install
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: rename packages/aai to packages/aai-core

Rename directory, update package name to @alexkroman1/aai-core,
mark as private, rewrite exports map to 4 subpaths."
```

---

### Task 2: Create new barrel files for aai-core

**Files:**
- Create: `packages/aai-core/index.ts` (rewrite root barrel)
- Create: `packages/aai-core/host/runtime-barrel.ts`
- Create: `packages/aai-core/isolate/manifest-barrel.ts`
- Delete: `packages/aai-core/isolate/index.ts`
- Delete: `packages/aai-core/host/index.ts`

- [ ] **Step 1: Rewrite root barrel (index.ts)**

Replace `packages/aai-core/index.ts` with:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * aai-core — shared fundamentals with no Node.js dependencies.
 *
 * Types, KV interface, hooks, utils, and constants used across
 * aai-cli, aai-server, and aai-ui.
 */

// biome-ignore-all lint/performance/noReExportAll: barrel file by design

export * from "./isolate/types.ts";
export * from "./isolate/kv.ts";
export * from "./isolate/hooks.ts";
export * from "./isolate/_utils.ts";
export * from "./isolate/constants.ts";
```

- [ ] **Step 2: Create runtime barrel (host/runtime-barrel.ts)**

Create `packages/aai-core/host/runtime-barrel.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Runtime barrel — the full Node.js runtime engine for running agents.
 *
 * Used by aai-server (sandbox) and aai-cli (dev server).
 */

// biome-ignore-all lint/performance/noReExportAll: barrel file by design

export * from "./_runtime-conformance.ts";
export * from "./builtin-tools.ts";
export * from "./runtime.ts";
export * from "./runtime-config.ts";
export * from "./s2s.ts";
export * from "./server.ts";
export * from "./session.ts";
export * from "./session-ctx.ts";
export * from "./tool-executor.ts";
export * from "./unstorage-kv.ts";
export * from "./ws-handler.ts";
export { flush, makeStubSession } from "./_test-utils.ts";
```

- [ ] **Step 3: Create manifest barrel (isolate/manifest-barrel.ts)**

Create `packages/aai-core/isolate/manifest-barrel.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Manifest barrel — agent manifest parsing and tool schema conversion.
 *
 * Used by aai-cli (scanner, bundler) and aai-server (tests).
 */

export * from "./manifest.ts";
export * from "./_internal-types.ts";
export * from "./system-prompt.ts";
```

- [ ] **Step 4: Delete old barrel files**

```bash
rm packages/aai-core/isolate/index.ts
rm packages/aai-core/host/index.ts
```

- [ ] **Step 5: Verify the new barrels compile**

```bash
cd packages/aai-core && pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: create new barrel files for aai-core

Root exports shared fundamentals (types, kv, hooks, utils, constants).
./runtime exports the Node.js runtime engine.
./manifest exports manifest parsing and tool schemas.
./protocol unchanged (isolate/protocol.ts).
Remove old isolate/index.ts and host/index.ts barrels."
```

---

### Task 3: Remove self-hosted public API

**Files:**
- Modify: `packages/aai-core/isolate/types.ts` — remove `defineAgent`, `defineTool`, `defineToolFactory`
- Modify: `packages/aai-core/host/server.ts` — remove `createAgentApp`, `ServerOptions` export; update JSDoc
- Delete: `packages/aai-core/types.test-d.ts`
- Delete: `packages/aai-core/published-exports.test.ts`

- [ ] **Step 1: Remove defineAgent, defineTool, defineToolFactory from types.ts**

In `packages/aai-core/isolate/types.ts`, remove the `defineAgent` function (keep the `AgentDef` type), remove the `defineTool` function (keep the `ToolDef` type), and remove the `defineToolFactory` function.

These are helper functions that wrap type assertions — they add no runtime logic. The types they return (`AgentDef`, `ToolDef`) remain.

- [ ] **Step 2: Update server.ts JSDoc**

In `packages/aai-core/host/server.ts`:
- Remove the JSDoc `@example` block at lines 94-102 (references `defineAgent` and `@alexkroman1/aai`)
- Remove the `ServerOptions` type export (only used internally by `createServer`)
- Keep `createServer`, `AgentServer`, and the re-export of `createRuntime`/`Runtime`/`RuntimeOptions`
- Update JSDoc comments to remove "self-hosted" language and references to `@alexkroman1/aai`

- [ ] **Step 3: Delete type-level and published-export tests**

```bash
rm packages/aai-core/types.test-d.ts
rm packages/aai-core/published-exports.test.ts
```

- [ ] **Step 4: Run tests to verify nothing breaks**

```bash
pnpm vitest run --project aai 2>&1 | head -30
```

Note: this will fail because the vitest project name hasn't been updated yet — that's expected. Check that the remaining test files in aai-core don't import from the deleted files.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove self-hosted public API from aai-core

Remove defineAgent, defineTool, defineToolFactory functions (keep types).
Remove ServerOptions export. Delete type-level and published-export tests.
The self-hosted path is no longer part of the public API."
```

---

### Task 4: Update aai-server imports

**Files:**
- Modify: `packages/aai-server/package.json` — rename dependency
- Modify: `packages/aai-server/sandbox.ts`
- Modify: `packages/aai-server/orchestrator.ts`
- Modify: `packages/aai-server/transport-websocket.ts`
- Modify: `packages/aai-server/bundle-store.ts`
- Modify: `packages/aai-server/error-handler.ts`
- Modify: `packages/aai-server/kv-handler.ts`
- Modify: `packages/aai-server/guest/harness-logic.ts`
- Modify: `packages/aai-server/harness-runtime-v2.ts`
- Modify: `packages/aai-server/test-utils.ts`
- Modify: `packages/aai-server/smoke.test.ts`
- Modify: `packages/aai-server/ws-integration.test.ts`
- Modify: `packages/aai-server/kv-handler.test.ts`
- Modify: `packages/aai-server/kv.test.ts`
- Modify: `packages/aai-server/schemas.test.ts`

- [ ] **Step 1: Update package.json dependency**

In `packages/aai-server/package.json`, change `"@alexkroman1/aai": "workspace:*"` to `"@alexkroman1/aai-core": "workspace:*"`.

- [ ] **Step 2: Update all source file imports**

Apply these import rewrites across all files in `packages/aai-server/`:

| Old import from | New import from | Applies to |
|---|---|---|
| `@alexkroman1/aai/host` → runtime symbols (`createRuntime`, `AgentHookMap`, `AgentHooks`, `AgentRuntime`, `ExecuteTool`, `resolveAllBuiltins`, `createUnstorageKv`, `SessionWebSocket`, `wireSessionSocket`, `Session`) | `@alexkroman1/aai-core/runtime` | `sandbox.ts`, `orchestrator.ts`, `ws-integration.test.ts`, `smoke.test.ts`, `kv.test.ts`, `kv-handler.test.ts` |
| `@alexkroman1/aai/host` → `errorMessage` | `@alexkroman1/aai-core` | `bundle-store.ts`, `error-handler.ts`, `kv-handler.ts` |
| `@alexkroman1/aai/host` → `AGENT_CSP` | `@alexkroman1/aai-core` | `transport-websocket.ts` |
| `@alexkroman1/aai/isolate` → `MAX_WS_PAYLOAD_BYTES` | `@alexkroman1/aai-core` | `orchestrator.ts` |
| `@alexkroman1/aai/protocol` → any symbol | `@alexkroman1/aai-core/protocol` | `orchestrator.ts`, `kv-handler.ts`, `kv-handler.test.ts`, `ws-integration.test.ts`, `schemas.test.ts` |
| `@alexkroman1/aai/types` → any symbol | `@alexkroman1/aai-core` | `guest/harness-logic.ts`, `harness-runtime-v2.ts` |
| `@alexkroman1/aai/kv` → `Kv` | `@alexkroman1/aai-core` | `harness-runtime-v2.ts`, `test-utils.ts` |
| `@alexkroman1/aai/hooks` → any symbol | `@alexkroman1/aai-core` | `guest/harness-logic.ts` |
| `@alexkroman1/aai/testing` → `makeStubSession` | `@alexkroman1/aai-core/runtime` | `ws-integration.test.ts` |

For `smoke.test.ts`: it imports `defineAgent`, `defineTool`, `AgentDef`, `agentToolsToSchemas`, `resolveAllBuiltins`, `toAgentConfig` from `@alexkroman1/aai/host`. After removing `defineAgent`/`defineTool`, update this test to construct `AgentDef` objects directly (plain object literal) instead of using the helper functions. Import `agentToolsToSchemas` from `@alexkroman1/aai-core/manifest`. Import `resolveAllBuiltins`, `toAgentConfig` from `@alexkroman1/aai-core/runtime`. Import `AgentDef` from `@alexkroman1/aai-core`.

- [ ] **Step 3: Run pnpm install**

```bash
pnpm install
```

- [ ] **Step 4: Verify aai-server typechecks**

```bash
pnpm --filter @alexkroman1/aai-server typecheck
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: update aai-server imports to @alexkroman1/aai-core

Rewrite all imports from @alexkroman1/aai/* to the new aai-core
subpaths: root for types/utils/constants, ./protocol for wire format,
./runtime for Node.js runtime engine, ./manifest for manifest parsing."
```

---

### Task 5: Update aai-cli imports

**Files:**
- Modify: `packages/aai-cli/package.json` — rename dependency
- Modify: `packages/aai-cli/_scanner.ts`
- Modify: `packages/aai-cli/_bundler.ts`
- Modify: `packages/aai-cli/_server-common.ts`
- Modify: `packages/aai-cli/_dev-server.ts`
- Modify: `packages/aai-cli/cli.ts`
- Modify: `packages/aai-cli/init.ts`

- [ ] **Step 1: Update package.json dependency**

In `packages/aai-cli/package.json`, change `"@alexkroman1/aai": "workspace:*"` to `"@alexkroman1/aai-core": "workspace:*"`.

- [ ] **Step 2: Update all source file imports**

Apply these import rewrites:

| File | Old | New |
|---|---|---|
| `_scanner.ts:11` | `from "@alexkroman1/aai/isolate"` → `parseManifest`, `HookFlags`, `Manifest` | `from "@alexkroman1/aai-core/manifest"` |
| `_bundler.ts:6` | `from "@alexkroman1/aai/isolate"` → `agentToolsToSchemas` | `from "@alexkroman1/aai-core/manifest"` |
| `_bundler.ts:7` | `from "@alexkroman1/aai/utils"` → `errorMessage` | `from "@alexkroman1/aai-core"` |
| `_server-common.ts:5` | `from "@alexkroman1/aai/server"` → `AgentServer` | `from "@alexkroman1/aai-core/runtime"` |
| `_server-common.ts:6` | `from "@alexkroman1/aai/types"` → `AgentDef` | `from "@alexkroman1/aai-core"` |
| `_server-common.ts:7,9` | `from "@alexkroman1/aai/utils"` → `parseEnvFile` | `from "@alexkroman1/aai-core"` |
| `_dev-server.ts:14` | `from "@alexkroman1/aai/isolate"` → `Manifest` | `from "@alexkroman1/aai-core/manifest"` |
| `_dev-server.ts:15` | `from "@alexkroman1/aai/server"` → `AgentServer` | `from "@alexkroman1/aai-core/runtime"` |
| `_dev-server.ts:16` | `from "@alexkroman1/aai/utils"` → `parseEnvFile` | `from "@alexkroman1/aai-core"` |
| `cli.ts:6` | `from "@alexkroman1/aai/utils"` → `errorMessage` | `from "@alexkroman1/aai-core"` |
| `init.ts:7` | `from "@alexkroman1/aai/utils"` → `errorMessage` | `from "@alexkroman1/aai-core"` |

Also update the dynamic imports in `_server-common.ts` and `_dev-server.ts`:
- `await import("@alexkroman1/aai/server")` → `await import("@alexkroman1/aai-core/runtime")`

- [ ] **Step 3: Run pnpm install**

```bash
pnpm install
```

- [ ] **Step 4: Verify aai-cli typechecks**

```bash
pnpm --filter @alexkroman1/aai-cli typecheck
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: update aai-cli imports to @alexkroman1/aai-core

Rewrite all imports from @alexkroman1/aai/* to the new aai-core
subpaths: root for types/utils, ./manifest for manifest parsing,
./runtime for createRuntime/createServer/AgentServer."
```

---

### Task 6: Update aai-ui imports

**Files:**
- Modify: `packages/aai-ui/package.json` — rename dependency
- Modify: `packages/aai-ui/session-core.ts`
- Modify: `packages/aai-ui/types.ts`

- [ ] **Step 1: Update package.json dependency**

In `packages/aai-ui/package.json`, change `"@alexkroman1/aai": "workspace:*"` to `"@alexkroman1/aai-core": "workspace:*"`.

- [ ] **Step 2: Update session-core.ts imports**

In `packages/aai-ui/session-core.ts`:
- Line 18-19: `from "@alexkroman1/aai/protocol"` → `from "@alexkroman1/aai-core/protocol"`
- Line 20: `from "@alexkroman1/aai/utils"` → `from "@alexkroman1/aai-core"`

- [ ] **Step 3: Update types.ts imports**

In `packages/aai-ui/types.ts`:
- Line 3: `from "@alexkroman1/aai/protocol"` → `from "@alexkroman1/aai-core/protocol"`
- Line 49 (re-export): `from "@alexkroman1/aai/protocol"` → `from "@alexkroman1/aai-core/protocol"`

- [ ] **Step 4: Run pnpm install and verify**

```bash
pnpm install
pnpm --filter @alexkroman1/aai-ui typecheck
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: update aai-ui imports to @alexkroman1/aai-core

Rewrite imports: protocol from aai-core/protocol, utils from aai-core root."
```

---

### Task 7: Move testing utilities to aai-cli

**Files:**
- Move: `packages/aai-core/host/testing.ts` → `packages/aai-cli/testing.ts`
- Move: `packages/aai-core/host/matchers.ts` → `packages/aai-cli/matchers.ts`
- Move: `packages/aai-core/host/_mock-ws.ts` → `packages/aai-cli/_mock-ws.ts`
- Modify: `packages/aai-cli/package.json` — add exports, add vitest peer dep
- Create: `packages/aai-cli/types.ts` — re-export user-facing types

- [ ] **Step 1: Copy testing files to aai-cli**

```bash
cp packages/aai-core/host/testing.ts packages/aai-cli/testing.ts
cp packages/aai-core/host/matchers.ts packages/aai-cli/matchers.ts
cp packages/aai-core/host/_mock-ws.ts packages/aai-cli/_mock-ws.ts
cp packages/aai-core/host/matchers.test.ts packages/aai-cli/matchers.test.ts
cp packages/aai-core/host/testing-exports.test.ts packages/aai-cli/testing-exports.test.ts
cp packages/aai-core/host/matchers.d.ts packages/aai-cli/matchers.d.ts 2>/dev/null || true
```

- [ ] **Step 2: Update imports in copied testing.ts**

In `packages/aai-cli/testing.ts`, update relative imports to use the workspace package:

```ts
// Old relative imports:
// import type { Kv } from "../isolate/kv.ts";
// import type { Message } from "../isolate/types.ts";
// import { createUnstorageKv } from "./unstorage-kv.ts";

// New package imports:
import type { Kv, Message } from "@alexkroman1/aai-core";
import { createUnstorageKv } from "@alexkroman1/aai-core/runtime";
```

Remove the re-exports of `flush` and `makeStubSession` from `_test-utils.ts` (those stay in aai-core). Instead re-export them from aai-core/runtime:

```ts
export { flush, makeStubSession } from "@alexkroman1/aai-core/runtime";
```

Remove the `installMockWebSocket` / `MockWebSocket` re-export line and replace with:

```ts
export { installMockWebSocket, MockWebSocket } from "./_mock-ws.ts";
```

Update all JSDoc `@example` import paths from `@alexkroman1/aai/testing` to `@alexkroman1/aai-cli/testing`.

- [ ] **Step 3: Update imports in copied matchers.ts**

In `packages/aai-cli/matchers.ts`:

```ts
// Old:
// import { toHaveCalledTool } from "./testing.ts";
// New (same — relative import within aai-cli):
import { toHaveCalledTool } from "./testing.ts";
```

Update JSDoc import paths from `@alexkroman1/aai/testing/matchers` to `@alexkroman1/aai-cli/testing/matchers`.

- [ ] **Step 3b: Update imports in copied test files**

In `packages/aai-cli/matchers.test.ts`: the `/// <reference path="./matchers.d.ts" />` stays the same (relative). The import `from "./testing.ts"` stays the same (relative within aai-cli).

In `packages/aai-cli/testing-exports.test.ts`: the import `from "./testing.ts"` stays the same (relative within aai-cli).

- [ ] **Step 4: Create types.ts for user-facing type re-exports**

Create `packages/aai-cli/types.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * User-facing type re-exports from aai-core.
 *
 * Agent projects depend on @alexkroman1/aai-cli (devDependency) and can
 * import shared types from this entry point.
 */

export type {
  AgentDef,
  AgentOptions,
  BuiltinTool,
  HookContext,
  Message,
  ToolChoice,
  ToolContext,
  ToolDef,
  ToolResultMap,
} from "@alexkroman1/aai-core";

export type { Kv } from "@alexkroman1/aai-core";
```

- [ ] **Step 5: Add new exports to aai-cli package.json**

In `packages/aai-cli/package.json`, add to the `"exports"` field (create it if it doesn't exist):

```json
"exports": {
  "./testing": {
    "@dev/source": "./testing.ts",
    "types": "./dist/testing.d.ts",
    "import": "./dist/testing.js"
  },
  "./testing/matchers": {
    "@dev/source": "./matchers.ts",
    "types": "./dist/matchers.d.ts",
    "import": "./dist/matchers.js"
  },
  "./types": {
    "@dev/source": "./types.ts",
    "types": "./dist/types.d.ts",
    "import": "./dist/types.js"
  }
}
```

Add vitest as an optional peer dependency (for matchers.ts):

```json
"peerDependencies": {
  "vitest": "^4.1.3"
},
"peerDependenciesMeta": {
  "vitest": {
    "optional": true
  }
}
```

Also add `unstorage` to dependencies (used by testing.ts for createUnstorageKv's createStorage):

```json
"unstorage": "^1.17.5"
```

Wait — actually, `testing.ts` imports `createUnstorageKv` from `@alexkroman1/aai-core/runtime`, which is a workspace dep. And `createStorage` from `unstorage` is used directly in testing.ts. So yes, add `unstorage` to aai-cli dependencies.

- [ ] **Step 6: Delete the original testing files from aai-core**

```bash
rm packages/aai-core/host/testing.ts
rm packages/aai-core/host/matchers.ts
rm packages/aai-core/host/_mock-ws.ts
rm packages/aai-core/host/matchers.test.ts
rm packages/aai-core/host/testing-exports.test.ts
rm packages/aai-core/host/matchers.d.ts 2>/dev/null || true
```

Update `packages/aai-core/host/runtime-barrel.ts` to remove the line:
```
export { flush, makeStubSession } from "./_test-utils.ts";
```

Wait — `makeStubSession` and `flush` are still needed by aai-server. They live in `_test-utils.ts` which stays in aai-core. The runtime barrel should keep exporting them. Leave the export line in runtime-barrel.ts.

- [ ] **Step 7: Verify aai-cli typechecks**

```bash
pnpm install
pnpm --filter @alexkroman1/aai-cli typecheck
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: move testing utilities to aai-cli

Move createTestHarness, TurnResult, TestHarness, MockWebSocket,
toHaveCalledTool to aai-cli. Add ./testing, ./testing/matchers,
and ./types export subpaths to aai-cli package.json."
```

---

### Task 8: Update aai-templates imports

**Files:**
- Modify: `packages/aai-templates/package.json` — rename dependency
- Modify: `packages/aai-templates/scaffold/package.json` — remove aai dep
- Modify: all 17 template `agent.test.ts` files
- Modify: `packages/aai-templates/templates/solo-rpg/shared.ts`

- [ ] **Step 1: Update templates package.json**

In `packages/aai-templates/package.json`, change `"@alexkroman1/aai": "workspace:*"` to `"@alexkroman1/aai-core": "workspace:*"` in devDependencies. Also add `"@alexkroman1/aai-cli": "workspace:*"` to devDependencies (needed for the testing import).

- [ ] **Step 2: Update scaffold package.json**

In `packages/aai-templates/scaffold/package.json`:
- Remove `"@alexkroman1/aai": "^0.12.3"` from `dependencies`
- Keep `"@alexkroman1/aai-ui": "^0.12.3"` in `dependencies`
- Keep `"@alexkroman1/aai-cli": "^0.12.3"` in `devDependencies`

- [ ] **Step 3: Update all template agent.test.ts files**

In every `packages/aai-templates/templates/*/agent.test.ts` (17 files), change:

```ts
// Old:
import { createTestHarness } from "@alexkroman1/aai/testing";
// New:
import { createTestHarness } from "@alexkroman1/aai-cli/testing";
```

Files: `code-interpreter`, `smart-research`, `pizza-ordering`, `night-owl`, `health-assistant`, `test-patterns`, `math-buddy`, `infocom-adventure`, `simple`, `travel-concierge`, `support`, `memory-agent`, `dispatch-center`, `embedded-assets`, `web-researcher`, `solo-rpg`, `personal-finance`.

For `test-patterns/agent.test.ts` (which imports at line 10, not line 3), apply the same change.

- [ ] **Step 4: Update solo-rpg/shared.ts**

In `packages/aai-templates/templates/solo-rpg/shared.ts`:

```ts
// Old:
import type { ToolResultMap } from "@alexkroman1/aai";
// New:
import type { ToolResultMap } from "@alexkroman1/aai-cli/types";
```

- [ ] **Step 5: Verify templates test**

```bash
pnpm vitest run --project templates 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: update template imports to aai-cli/testing

All agent.test.ts files now import createTestHarness from
@alexkroman1/aai-cli/testing. solo-rpg/shared.ts imports
ToolResultMap from @alexkroman1/aai-cli/types."
```

---

### Task 9: Update config files

**Files:**
- Modify: `vitest.config.ts`
- Modify: `.changeset/config.json`
- Modify: `package.json` (root)
- Modify: `biome.json`
- Modify: `scripts/sync-scaffold-versions.mjs`
- Modify: `scripts/s2s-load-test.ts`

- [ ] **Step 1: Update vitest.config.ts**

In the root `vitest.config.ts`:

1. Rename the `aai` project (line 41): `name: "aai"` → `name: "aai-core"`, `root: "packages/aai"` → `root: "packages/aai-core"`. Remove the `setupFiles: ["./host/matchers.ts"]` line — the matchers.ts file moved to aai-cli, and the only aai-core tests that used `toHaveCalledTool` (`matchers.test.ts`, `testing-exports.test.ts`) also moved to aai-cli.

2. Delete the `aai-types` project entirely (lines 55-62) — type-level tests were deleted.

3. Update the coverage exclude: `"packages/aai/_session-otel.ts"` → `"packages/aai-core/_session-otel.ts"`.

- [ ] **Step 2: Update .changeset/config.json**

Change the `fixed` array from:
```json
"fixed": [["@alexkroman1/aai", "@alexkroman1/aai-ui", "@alexkroman1/aai-cli"]]
```
to:
```json
"fixed": [["@alexkroman1/aai-ui", "@alexkroman1/aai-cli"]]
```

- [ ] **Step 3: Update root package.json scripts**

Change `"test:aai": "pnpm --filter @alexkroman1/aai test"` to `"test:aai-core": "pnpm --filter @alexkroman1/aai-core test"`.

- [ ] **Step 4: Update biome.json**

Change the override `includes` from:
```json
"includes": ["packages/aai/**/*.ts", "packages/aai/**/*.tsx"]
```
to:
```json
"includes": ["packages/aai-core/**/*.ts", "packages/aai-core/**/*.tsx"]
```

- [ ] **Step 5: Update scripts/sync-scaffold-versions.mjs**

Change `"@alexkroman1/aai": "packages/aai/package.json"` to `"@alexkroman1/aai-core": "packages/aai-core/package.json"`. Wait — this script syncs scaffold versions. Since aai-core is private and no longer in scaffold deps, remove this entry entirely. The script should only sync packages that appear in scaffold/package.json.

- [ ] **Step 6: Update scripts/s2s-load-test.ts**

Change `from "../packages/aai/host/s2s.ts"` to `from "../packages/aai-core/host/s2s.ts"`.

- [ ] **Step 7: Run pnpm install**

```bash
pnpm install
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: update config files for aai-core rename

Update vitest projects, changeset config, root scripts, biome overrides,
and build scripts to reference aai-core instead of aai."
```

---

### Task 10: Update scaffold CLAUDE.md

**Files:**
- Modify: `packages/aai-templates/scaffold/CLAUDE.md`

- [ ] **Step 1: Remove self-hosted section**

Remove the entire "Self-hosting with `createServer()`" section (starts around line 1138), including all code examples that reference `defineAgent`, `createRuntime`, `createServer` from `@alexkroman1/aai`.

- [ ] **Step 2: Update testing section imports**

In the "Testing agents" section, change all occurrences of:
```ts
import { createTestHarness } from "@alexkroman1/aai/testing";
```
to:
```ts
import { createTestHarness } from "@alexkroman1/aai-cli/testing";
```

- [ ] **Step 3: Update any remaining references**

Search for any remaining `@alexkroman1/aai` references (not `aai-ui` or `aai-cli`) and update or remove them. The solo-rpg shared type pattern should reference `@alexkroman1/aai-cli/types` instead of `@alexkroman1/aai`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: update scaffold CLAUDE.md for aai-core rename

Remove self-hosted section, update testing imports to aai-cli/testing,
update type imports to aai-cli/types."
```

---

### Task 11: Update agent/CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (project root CLAUDE.md at `agent/CLAUDE.md`)

- [ ] **Step 1: Update architecture table**

Change:
```
| `packages/aai/` | `@alexkroman1/aai` | Agent SDK: manifest, `createServer`, types, protocol, S2S, session, KV |
```
to:
```
| `packages/aai-core/` | `@alexkroman1/aai-core` | Shared core (private): types, protocol, runtime, manifest, KV |
```

- [ ] **Step 2: Update dependency flow**

Change:
```
**Dependency flow:** `aai-cli`, `aai-ui`, and `aai-server` depend on `aai`
```
to:
```
**Dependency flow:** `aai-cli`, `aai-ui`, and `aai-server` depend on `aai-core`
```

- [ ] **Step 3: Update package exports section**

Replace the `@alexkroman1/aai (SDK)` exports section with the new 4-subpath structure:

```markdown
#### `@alexkroman1/aai-core` (shared core, private)

- `.` — types, KV interface, hooks, utils, constants (no Node.js deps)
- `./protocol` — wire-format types, Zod schemas
- `./runtime` — `createRuntime`, `createServer`, session, S2S, WebSocket handler, tool executor, built-in tools
- `./manifest` — `parseManifest`, `Manifest`, `agentToolsToSchemas`, system prompt template
```

Update the `@alexkroman1/aai-cli` section to include the new exports:
```markdown
#### `@alexkroman1/aai-cli` (CLI)

Binary: `aai` — subcommands: init, dev, test, build, deploy, delete, secret

- `./testing` — `createTestHarness`, `TestHarness`, `TurnResult`, `MockWebSocket`
- `./testing/matchers` — Vitest custom matchers (`toHaveCalledTool`)
- `./types` — re-exports user-facing types from aai-core
```

- [ ] **Step 4: Update SDK structure section**

Rename "SDK structure" to "Core package structure" and update directory references from `packages/aai/` to `packages/aai-core/`. Remove references to "SDK" throughout.

- [ ] **Step 5: Update key files section**

Update `packages/aai/` paths to `packages/aai-core/` in the key files listing.

- [ ] **Step 6: Update test commands**

Change `pnpm test:aai` to `pnpm test:aai-core` and update `vitest run --project aai` to `vitest run --project aai-core`. Update the `pnpm --filter @alexkroman1/aai test` example.

- [ ] **Step 7: Update changeset examples**

Update changeset examples from `@alexkroman1/aai` to `@alexkroman1/aai-cli` (since aai-core is private, changesets don't apply to it). Update the fixed packages description.

- [ ] **Step 8: Update security sections**

Change `aai/builtin-tools.ts` to `aai-core/builtin-tools.ts`, `aai/server.ts` to `aai-core/server.ts` in the security architecture section.

- [ ] **Step 9: Remove self-hosted overview bullet**

In the Overview section, remove:
```
- **Self-hosted**: `defineAgent()` → `createRuntime()` → `createServer()`
  → runs on Node/Docker
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "docs: update CLAUDE.md for aai-core rename

Update architecture table, package exports, dependency flow, test
commands, key files, changeset examples, and security sections.
Remove self-hosted path from overview."
```

---

### Task 12: Update JSDoc comments in aai-core source files

**Files:**
- Modify: `packages/aai-core/host/server.ts`
- Modify: `packages/aai-core/host/unstorage-kv.ts`
- Modify: `packages/aai-core/host/_runtime-conformance.ts`
- Modify: `packages/aai-core/isolate/types.ts`

- [ ] **Step 1: Update JSDoc import paths**

Search for any remaining `@alexkroman1/aai` references in JSDoc comments within `packages/aai-core/` and update them:

- `@alexkroman1/aai/testing` → `@alexkroman1/aai-cli/testing`
- `@alexkroman1/aai/server` → `@alexkroman1/aai-core/runtime`
- `@alexkroman1/aai` → `@alexkroman1/aai-core`

Files with known JSDoc references:
- `host/server.ts` lines 95-96
- `host/unstorage-kv.ts` line 31
- `host/_runtime-conformance.ts` line 23
- `isolate/types.ts` line 238

- [ ] **Step 2: Update module-level JSDoc**

In `packages/aai-core/index.ts`, the JSDoc should say "aai-core" not "AAI SDK".

In `packages/aai-core/host/server.ts`, update "Self-hostable agent server" to "Agent HTTP+WebSocket server" (remove "self-hostable" framing).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: update JSDoc references to aai-core"
```

---

### Task 13: Verify everything works

**Files:** none (verification only)

- [ ] **Step 1: Run pnpm install**

```bash
pnpm install
```

- [ ] **Step 2: Run typecheck across all packages**

```bash
pnpm typecheck
```

Fix any type errors.

- [ ] **Step 3: Run lint**

```bash
pnpm lint
```

Fix any lint errors (especially import ordering from Biome).

- [ ] **Step 4: Run all unit tests**

```bash
pnpm test
```

Fix any test failures.

- [ ] **Step 5: Run check:local (full pre-commit gate)**

```bash
pnpm check:local
```

This runs build → typecheck + lint + publint + syncpack → test. Fix any failures.

- [ ] **Step 6: Verify no remaining references to old package name**

```bash
grep -r "@alexkroman1/aai\"" packages/ --include="*.ts" --include="*.tsx" --include="*.json" | grep -v aai-core | grep -v aai-cli | grep -v aai-ui | grep -v aai-server | grep -v aai-templates | grep -v node_modules | grep -v dist | grep -v pnpm-lock
```

This should return zero results. Any remaining `@alexkroman1/aai"` (with trailing quote, not followed by `-`) is a missed reference.

Also check:
```bash
grep -r "packages/aai/" . --include="*.ts" --include="*.json" --include="*.sh" --include="*.mjs" | grep -v aai-core | grep -v aai-cli | grep -v aai-ui | grep -v aai-server | grep -v aai-templates | grep -v node_modules | grep -v dist | grep -v .git
```

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve remaining issues from aai-core rename"
```
