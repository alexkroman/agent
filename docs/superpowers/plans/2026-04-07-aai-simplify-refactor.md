# AAI Package Simplify & Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the two largest files in `packages/aai/host/` by responsibility, rename files to match their actual purpose, and remove redundant re-exports.

**Architecture:** Extract `tool-executor.ts` from `direct-executor.ts`, extract `session-ctx.ts` from `session.ts`, rename `runtime.ts` → `runtime-config.ts` and `direct-executor.ts` → `runtime.ts`. Remove transitive re-exports from `session.ts`. Update barrel and all consumers.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo, tsdown build

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `host/tool-executor.ts` | **Create** | Tool execution engine: `executeToolCall`, `buildToolContext`, types |
| `host/session-ctx.ts` | **Create** | Session context builder: `buildCtx`, `S2sSessionCtx`, `ReplyState`, `SessionDeps` |
| `host/runtime-config.ts` | **Rename** from `host/runtime.ts` | Logger, S2SConfig types + defaults |
| `host/runtime.ts` | **Rename** from `host/direct-executor.ts` | Runtime factory: `createRuntime` |
| `host/session.ts` | **Modify** | Remove context builder + re-exports, import from new modules |
| `host/server.ts` | **Modify** | Update import paths |
| `host/s2s.ts` | **Modify** | Update import path for runtime-config |
| `host/ws-handler.ts` | **Modify** | Update import path for runtime-config |
| `host/index.ts` | **Modify** | Update barrel exports |
| `host/testing.ts` | **Modify** | Update import path |
| `host/_test-utils.ts` | **Modify** | Update import paths |
| `host/_runtime-conformance.ts` | **Modify** | Update import path |
| `host/*.test.ts` | **Modify** | Update import paths (7 test files) |

### Test files requiring import path updates

| Test file | Current import | New import |
|-----------|---------------|------------|
| `host/tool-execution.test.ts` | `executeToolCall` from `./direct-executor.ts` | from `./tool-executor.ts` |
| `host/direct-executor.test.ts` | `createRuntime, executeToolCall` from `./direct-executor.ts` | `createRuntime` from `./runtime.ts`, `executeToolCall` from `./tool-executor.ts` |
| `host/session-prompt.test.ts` | `buildSystemPrompt` from `./session.ts` | from `../isolate/system-prompt.ts` |
| `host/server.test.ts` | `createRuntime` from `./direct-executor.ts` | from `./runtime.ts` |
| `host/server-shutdown.test.ts` | `Runtime` from `./direct-executor.ts` | from `./runtime.ts` |
| `host/integration.test.ts` | `createRuntime` from `./direct-executor.ts` | from `./runtime.ts` |
| `host/runtime.test.ts` | `jsonLogger` from `./runtime.ts` | from `./runtime-config.ts` |

---

### Task 1: Create `host/tool-executor.ts` — extract from `direct-executor.ts`

**Files:**
- Create: `packages/aai/host/tool-executor.ts`
- Modify: `packages/aai/host/direct-executor.ts` (remove extracted code, add import)

- [ ] **Step 1: Create `host/tool-executor.ts`**

Create the file with the tool execution logic extracted from `direct-executor.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Tool execution engine — validates arguments, runs the tool's `execute`
 * function, and returns a JSON string result.
 */

import pTimeout from "p-timeout";
import type { z } from "zod";
import { EMPTY_PARAMS, type ExecuteTool } from "../isolate/_internal-types.ts";
import { errorDetail, errorMessage, toolError } from "../isolate/_utils.ts";
import { TOOL_EXECUTION_TIMEOUT_MS } from "../isolate/constants.ts";
import type { Kv } from "../isolate/kv.ts";
import type { Message, ToolContext, ToolDef } from "../isolate/types.ts";
import type { Logger } from "./runtime-config.ts";

export type { ExecuteTool } from "../isolate/_internal-types.ts";

const yieldTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export type ExecuteToolCallOptions = {
  tool: ToolDef;
  env: Readonly<Record<string, string>>;
  state?: Record<string, unknown>;
  sessionId?: string | undefined;
  kv?: Kv | undefined;
  messages?: readonly Message[] | undefined;
  logger?: Logger | undefined;
};

function buildToolContext(opts: ExecuteToolCallOptions): ToolContext {
  const { env, state, kv, messages, sessionId } = opts;
  return {
    env: { ...env },
    state: state ?? {},
    get kv(): Kv {
      if (!kv) throw new Error("KV not available");
      return kv;
    },
    messages: messages ?? [],
    sessionId: sessionId ?? "",
  };
}

export async function executeToolCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
  options: ExecuteToolCallOptions,
): Promise<string> {
  const { tool } = options;
  const schema = tool.parameters ?? EMPTY_PARAMS;
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issues = (parsed.error?.issues ?? [])
      .map((i: z.ZodIssue) => `${i.path.map(String).join(".")}: ${i.message}`)
      .join(", ");
    return toolError(`Invalid arguments for tool "${name}": ${issues}`);
  }

  try {
    const ctx = buildToolContext(options);
    await yieldTick();
    const result = await pTimeout(Promise.resolve(tool.execute(parsed.data, ctx)), {
      milliseconds: TOOL_EXECUTION_TIMEOUT_MS,
      message: `Tool "${name}" timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`,
    });
    await yieldTick();
    if (result == null) return "null";
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (err: unknown) {
    const log = options.logger;
    if (log) {
      log.warn("Tool execution failed", { tool: name, error: errorDetail(err) });
    } else {
      console.warn(`[tool-executor] Tool execution failed: ${name}`, err);
    }
    return toolError(errorMessage(err));
  }
}
```

Note: this imports `Logger` from `./runtime-config.ts` — this import path will be valid after the rename in Task 3. During Task 1 execution, use `./runtime.ts` temporarily (it will be renamed in Task 3).

- [ ] **Step 2: Remove extracted code from `direct-executor.ts` and add import**

In `packages/aai/host/direct-executor.ts`, remove lines 39–103 (everything from `export type { ExecuteTool }` through the `executeToolCall` function). Replace with:

```ts
export { executeToolCall, type ExecuteToolCallOptions, type ExecuteTool } from "./tool-executor.ts";
```

This re-exports so existing consumers of `direct-executor.ts` still work during the transition.

Also remove the now-unused imports from the top of the file:
- Remove `pTimeout` import (only used by `executeToolCall`)
- Remove `import type { z } from "zod"` (only used by `executeToolCall`)
- Remove `TOOL_EXECUTION_TIMEOUT_MS` from the constants import (only used by `executeToolCall`)
- Remove `type Kv` import from `../isolate/kv.ts` if no longer used in this file
- Remove `type ToolContext` from the types import if no longer used
- Keep `type ToolDef` — still used by `allTools` typing in `createRuntime`

After cleanup, the remaining imports in `direct-executor.ts` should be:

```ts
import { createStorage } from "unstorage";
import {
  agentToolsToSchemas,
  EMPTY_PARAMS,
  type ExecuteTool,
  type ToolSchema,
  toAgentConfig,
} from "../isolate/_internal-types.ts";
import { toolError } from "../isolate/_utils.ts";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from "../isolate/constants.ts";
import { type AgentHooks, createAgentHooks } from "../isolate/hooks.ts";
import type { Kv } from "../isolate/kv.ts";
import type { ClientSink } from "../isolate/protocol.ts";
import { buildReadyConfig, type ReadyConfig } from "../isolate/protocol.ts";
import type { AgentDef, HookContext, Message, ToolDef } from "../isolate/types.ts";
import {
  getBuiltinToolDefs,
  getBuiltinToolGuidance,
  getBuiltinToolSchemas,
} from "./builtin-tools.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import { createS2sSession, type Session } from "./session.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";
import { type SessionWebSocket, wireSessionSocket } from "./ws-handler.ts";
import { executeToolCall } from "./tool-executor.ts";
```

Note: `errorDetail` and `errorMessage` imports from `_utils.ts` can be removed — they were only used by `executeToolCall`. Keep `toolError` — still used in the `executeTool` closure.

- [ ] **Step 3: Run tests to verify nothing broke**

Run: `pnpm vitest run --project aai`
Expected: All tests pass — the re-export from `direct-executor.ts` maintains backwards compat.

- [ ] **Step 4: Update `tool-execution.test.ts` to import from new module**

In `packages/aai/host/tool-execution.test.ts` line 6, change:
```ts
// Before:
import { executeToolCall } from "./direct-executor.ts";
// After:
import { executeToolCall } from "./tool-executor.ts";
```

- [ ] **Step 5: Run tests again**

Run: `pnpm vitest run --project aai`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add packages/aai/host/tool-executor.ts packages/aai/host/direct-executor.ts packages/aai/host/tool-execution.test.ts
git commit -m "refactor(aai): extract tool-executor.ts from direct-executor.ts"
```

---

### Task 2: Create `host/session-ctx.ts` — extract from `session.ts`

**Files:**
- Create: `packages/aai/host/session-ctx.ts`
- Modify: `packages/aai/host/session.ts` (remove extracted code, add import)

- [ ] **Step 1: Create `host/session-ctx.ts`**

```ts
// Copyright 2025 the AAI authors. MIT license.
/** Per-session mutable context threaded through S2S event handlers. */

import type { AgentConfig } from "../isolate/_internal-types.ts";
import { errorMessage, toolError } from "../isolate/_utils.ts";
import { DEFAULT_MAX_HISTORY, HOOK_TIMEOUT_MS } from "../isolate/constants.ts";
import type { AgentHookMap, AgentHooks } from "../isolate/hooks.ts";
import { callResolveTurnConfig } from "../isolate/hooks.ts";
import type { Message } from "../isolate/types.ts";
import type { Logger } from "./runtime-config.ts";
import type { S2sHandle } from "./s2s.ts";

type PendingTool = { callId: string; result: string };

/** Per-reply mutable state — reset on beginReply/cancelReply. */
export type ReplyState = {
  pendingTools: PendingTool[];
  toolCallCount: number;
  currentReplyId: string | null;
};

/** Immutable dependencies injected at session creation. */
export type SessionDeps = {
  readonly id: string;
  readonly agent: string;
  readonly client: import("../isolate/protocol.ts").ClientSink;
  readonly agentConfig: AgentConfig;
  readonly executeTool: import("../isolate/_internal-types.ts").ExecuteTool;
  readonly hooks: AgentHooks | undefined;
  readonly log: Logger;
  readonly maxHistory: number;
};

/**
 * Session context threaded through event handlers.
 *
 * Split into three layers:
 * - {@link SessionDeps} — immutable dependencies (set once)
 * - {@link ReplyState} via `reply` — per-reply mutable state (reset on beginReply/cancelReply)
 * - Remaining fields — connection, conversation, and lifecycle methods
 */
export type S2sSessionCtx = SessionDeps & {
  s2s: S2sHandle | null;
  reply: ReplyState;
  turnPromise: Promise<void> | null;
  conversationMessages: Message[];

  resolveTurnConfig(): Promise<{ maxSteps?: number } | null>;
  consumeToolCallStep(
    turnConfig: { maxSteps?: number } | null,
    name: string,
    replyId: string | null,
  ): string | null;
  fireHook(name: keyof AgentHookMap, ...args: unknown[]): void;
  drainHooks(): Promise<void>;
  pushMessages(...msgs: Message[]): void;
  beginReply(replyId: string): void;
  cancelReply(): void;
  chainTurn(p: Promise<void>): void;
};

export function buildCtx(opts: {
  id: string;
  agent: string;
  client: import("../isolate/protocol.ts").ClientSink;
  agentConfig: AgentConfig;
  executeTool: import("../isolate/_internal-types.ts").ExecuteTool;
  hooks: AgentHooks | undefined;
  log: Logger;
  maxHistory?: number | undefined;
}): S2sSessionCtx {
  const { id, agentConfig, hooks, log } = opts;
  const maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  /** Track in-flight hook promises so they can be awaited during shutdown. */
  const pendingHooks = new Set<Promise<void>>();
  const ctx: S2sSessionCtx = {
    ...opts,
    s2s: null,
    reply: { pendingTools: [], toolCallCount: 0, currentReplyId: null },
    turnPromise: null,
    conversationMessages: [],
    maxHistory,
    resolveTurnConfig() {
      return callResolveTurnConfig(hooks, id, HOOK_TIMEOUT_MS);
    },
    consumeToolCallStep(turnConfig, _name, replyId) {
      if (replyId === null || replyId !== ctx.reply.currentReplyId) {
        return toolError("Reply was interrupted. Discarding stale tool call.");
      }
      const maxSteps = turnConfig?.maxSteps ?? agentConfig.maxSteps;
      ctx.reply.toolCallCount++;
      if (maxSteps !== undefined && ctx.reply.toolCallCount > maxSteps) {
        log.info("maxSteps exceeded, refusing tool call", {
          toolCallCount: ctx.reply.toolCallCount,
          maxSteps,
        });
        return toolError("Maximum tool steps reached. Please respond to the user now.");
      }
      return null;
    },
    fireHook(name, ...args) {
      if (!hooks) return;
      const notifyOnError = (err: unknown) => {
        log.warn(`${name} hook failed`, { err: errorMessage(err) });
      };
      try {
        // biome-ignore lint/suspicious/noExplicitAny: hookable callHook is generic over hook args
        const result = (hooks.callHook as any)(name, ...args);
        // hookable returns undefined when no hooks are registered for the given name
        if (result == null) return;
        const p = result.catch(notifyOnError).finally(() => pendingHooks.delete(p));
        pendingHooks.add(p);
      } catch (err: unknown) {
        notifyOnError(err);
      }
    },
    async drainHooks() {
      if (pendingHooks.size > 0) await Promise.all([...pendingHooks]);
    },
    pushMessages(...msgs: Message[]) {
      ctx.conversationMessages.push(...msgs);
      if (maxHistory > 0 && ctx.conversationMessages.length > maxHistory) {
        ctx.conversationMessages = ctx.conversationMessages.slice(-maxHistory);
      }
    },
    beginReply(replyId: string) {
      ctx.reply = { pendingTools: [], toolCallCount: 0, currentReplyId: replyId };
      ctx.turnPromise = null;
    },
    cancelReply() {
      ctx.reply = { pendingTools: [], toolCallCount: 0, currentReplyId: null };
    },
    chainTurn(p: Promise<void>) {
      ctx.turnPromise = (ctx.turnPromise ?? Promise.resolve()).then(() => p);
    },
  };
  return ctx;
}

```

Note: Like Task 1, this imports `Logger` from `./runtime-config.ts`. During implementation, use `./runtime.ts` temporarily until the rename in Task 3.

- [ ] **Step 2: Update `session.ts` — remove extracted code, add import, remove re-exports**

In `packages/aai/host/session.ts`:

1. Remove lines 30–157 (everything from the `// ─── Session context` comment through the `buildCtx` function closing brace).

2. Remove lines 159–163 (the re-export block):
```ts
// DELETE:
export type { AgentHookMap, AgentHooks } from "../isolate/hooks.ts";
export { callResolveTurnConfig, createAgentHooks } from "../isolate/hooks.ts";
export { buildSystemPrompt } from "../isolate/system-prompt.ts";
```

3. Add import at the top (after existing imports):
```ts
import { buildCtx, type S2sSessionCtx } from "./session-ctx.ts";
```

4. Keep the `export type { S2sHandle }` re-export — it's used by consumers.

5. Clean up imports that are no longer needed in session.ts because they moved to session-ctx.ts:
   - Remove `import type { AgentConfig, ExecuteTool }` from `_internal-types.ts` — only used in `buildCtx`
   - Remove `DEFAULT_MAX_HISTORY` from the constants import — only used in `buildCtx`
   - Remove `import type { AgentHookMap, AgentHooks }` from `hooks.ts` — only used in re-exports and `buildCtx`
   - Remove `import { callResolveTurnConfig }` from `hooks.ts` — only used in `buildCtx`
   - Keep `import { buildSystemPrompt }` — still used in `createS2sSession`
   - Keep `import { errorDetail, errorMessage, toolError }` — still used in event handlers
   - Keep `HOOK_TIMEOUT_MS`, `MAX_TOOL_RESULT_CHARS` from constants — still used in handlers
   - Keep `import type { ClientSink }` — still used in `createIdleTimer` and `S2sSessionOptions`
   - Keep `import type { Message }` — still used in `onHistory`
   - Keep `import type { Logger, S2SConfig }` from runtime — still used in types

The cleaned-up import block for `session.ts` should be:

```ts
import { errorDetail, errorMessage, toolError } from "../isolate/_utils.ts";
import { HOOK_TIMEOUT_MS, MAX_TOOL_RESULT_CHARS } from "../isolate/constants.ts";
import type { ClientSink } from "../isolate/protocol.ts";
import { buildSystemPrompt } from "../isolate/system-prompt.ts";
import type { Message } from "../isolate/types.ts";
import type { Logger, S2SConfig } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import {
  type CreateS2sWebSocket,
  connectS2s,
  defaultCreateS2sWebSocket,
  type S2sHandle,
  type S2sToolCall,
  type S2sToolSchema,
} from "./s2s.ts";
import { buildCtx, type S2sSessionCtx } from "./session-ctx.ts";
```

Also add the re-export for types that consumers need:
```ts
export type { ReplyState, SessionDeps, S2sSessionCtx } from "./session-ctx.ts";
export { buildCtx } from "./session-ctx.ts";
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run --project aai`
Expected: All pass.

- [ ] **Step 4: Update `session-prompt.test.ts` import**

In `packages/aai/host/session-prompt.test.ts` line 4, change:
```ts
// Before:
import { buildSystemPrompt } from "./session.ts";
// After:
import { buildSystemPrompt } from "../isolate/system-prompt.ts";
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run --project aai`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add packages/aai/host/session-ctx.ts packages/aai/host/session.ts packages/aai/host/session-prompt.test.ts
git commit -m "refactor(aai): extract session-ctx.ts from session.ts, remove re-exports"
```

---

### Task 3: Rename `runtime.ts` → `runtime-config.ts`

**Files:**
- Rename: `packages/aai/host/runtime.ts` → `packages/aai/host/runtime-config.ts`
- Modify: all importers (8 source files + 1 test file)

- [ ] **Step 1: Rename the file**

```bash
cd /Users/alexkroman/Code/aai/agent
git mv packages/aai/host/runtime.ts packages/aai/host/runtime-config.ts
```

- [ ] **Step 2: Update all importers**

Each of these files has `from "./runtime.ts"` that must become `from "./runtime-config.ts"`:

**`packages/aai/host/direct-executor.ts`** (lines 32–33):
```ts
// Before:
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
// After:
import type { Logger, S2SConfig } from "./runtime-config.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime-config.ts";
```

**`packages/aai/host/session.ts`** (lines 17–18 — already updated in Task 2 if done in order, but verify):
```ts
import type { Logger, S2SConfig } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
```

**`packages/aai/host/session-ctx.ts`** (created in Task 2 — update if it was temporarily using `./runtime.ts`):
```ts
import type { Logger } from "./runtime-config.ts";
```

**`packages/aai/host/s2s.ts`** (lines 10–11):
```ts
// Before:
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";
// After:
import type { Logger, S2SConfig } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
```

**`packages/aai/host/ws-handler.ts`** (lines 13–14):
```ts
// Before:
import type { Logger } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";
// After:
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
```

**`packages/aai/host/server.ts`** (lines 16–17):
```ts
// Before:
import type { Logger } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";
// After:
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
```

**`packages/aai/host/tool-executor.ts`** (created in Task 1 — update if it was temporarily using `./runtime.ts`):
```ts
import type { Logger } from "./runtime-config.ts";
```

**`packages/aai/host/index.ts`** (line 22):
```ts
// Before:
export * from "./runtime.ts";
// After:
export * from "./runtime-config.ts";
```

**`packages/aai/host/runtime.test.ts`** (line 4):
```ts
// Before:
import { jsonLogger } from "./runtime.ts";
// After:
import { jsonLogger } from "./runtime-config.ts";
```

- [ ] **Step 3: Rename the test file too**

```bash
git mv packages/aai/host/runtime.test.ts packages/aai/host/runtime-config.test.ts
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run --project aai`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add -A packages/aai/host/
git commit -m "refactor(aai): rename runtime.ts to runtime-config.ts"
```

---

### Task 4: Rename `direct-executor.ts` → `runtime.ts`

**Files:**
- Rename: `packages/aai/host/direct-executor.ts` → `packages/aai/host/runtime.ts`
- Modify: all importers (4 source files + 5 test files)

- [ ] **Step 1: Rename the file**

```bash
cd /Users/alexkroman/Code/aai/agent
git mv packages/aai/host/direct-executor.ts packages/aai/host/runtime.ts
```

- [ ] **Step 2: Update all importers**

**`packages/aai/host/server.ts`** (lines 15, 20):
```ts
// Before:
import type { Runtime } from "./direct-executor.ts";
export { createRuntime, type Runtime, type RuntimeOptions } from "./direct-executor.ts";
// After:
import type { Runtime } from "./runtime.ts";
export { createRuntime, type Runtime, type RuntimeOptions } from "./runtime.ts";
```

**`packages/aai/host/testing.ts`** (line 43):
```ts
// Before:
import { createRuntime, type Runtime } from "./direct-executor.ts";
// After:
import { createRuntime, type Runtime } from "./runtime.ts";
```

**`packages/aai/host/_test-utils.ts`** (line 11):
```ts
// Before:
import { createRuntime } from "./direct-executor.ts";
// After:
import { createRuntime } from "./runtime.ts";
```

**`packages/aai/host/index.ts`** (line 21):
```ts
// Before:
export * from "./direct-executor.ts";
// After:
export * from "./runtime.ts";
```

**`packages/aai/host/direct-executor.test.ts`** — rename to `runtime.test.ts`:
```bash
git mv packages/aai/host/direct-executor.test.ts packages/aai/host/runtime.test.ts
```

Then update imports in the renamed file (lines 11–12):
```ts
// Before:
import { createRuntime, executeToolCall } from "./direct-executor.ts";
import { _internals } from "./session.ts";
// After:
import { createRuntime } from "./runtime.ts";
import { executeToolCall } from "./tool-executor.ts";
import { _internals } from "./session.ts";
```

Wait — there's a naming conflict. We already renamed `runtime.test.ts` to `runtime-config.test.ts` in Task 3. So `runtime.test.ts` is now available for the renamed `direct-executor.test.ts`. Good.

**`packages/aai/host/server.test.ts`** (line 4):
```ts
// Before:
import { createRuntime } from "./direct-executor.ts";
// After:
import { createRuntime } from "./runtime.ts";
```

**`packages/aai/host/server-shutdown.test.ts`** (line 12):
```ts
// Before:
import type { Runtime } from "./direct-executor.ts";
// After:
import type { Runtime } from "./runtime.ts";
```

**`packages/aai/host/integration.test.ts`** (line 14):
```ts
// Before:
import { createRuntime } from "./direct-executor.ts";
// After:
import { createRuntime } from "./runtime.ts";
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run --project aai`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add -A packages/aai/host/
git commit -m "refactor(aai): rename direct-executor.ts to runtime.ts"
```

---

### Task 5: Update barrel `host/index.ts` — add new modules

**Files:**
- Modify: `packages/aai/host/index.ts`

- [ ] **Step 1: Update barrel to include new modules**

After Tasks 1–4, the barrel should look like:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Host barrel — re-exports all SDK internals for use by the platform
 * server (`aai-server`) and CLI. **Not a public API.**
 *
 * Includes the full isolate-safe kernel plus host-only modules that
 * depend on Node.js APIs (server, executor, S2S, etc.).
 *
 * Consumer packages should import from the top-level `@alexkroman1/aai`
 * entry, `./server`, `./types`, `./kv`, `./protocol`, or `./testing`.
 */

// biome-ignore-all lint/performance/noReExportAll: barrel file by design

// Isolate-safe kernel
export * from "../isolate/index.ts";

// Host-only modules
export * from "./_runtime-conformance.ts";
export * from "./builtin-tools.ts";
export * from "./runtime.ts";
export * from "./runtime-config.ts";
export * from "./s2s.ts";
export * from "./session-ctx.ts";
export * from "./session.ts";
export * from "./tool-executor.ts";
export * from "./unstorage-kv.ts";
export * from "./ws-handler.ts";
```

- [ ] **Step 2: Check for export name conflicts**

`runtime.ts` (formerly direct-executor.ts) re-exports `executeToolCall` and `ExecuteTool` from `tool-executor.ts` (added in Task 1, Step 2). Since the barrel now exports both `./runtime.ts` and `./tool-executor.ts`, this could cause duplicate export warnings.

Remove the re-exports from `runtime.ts` (formerly direct-executor.ts) that we added as a transitional bridge in Task 1 Step 2:

```ts
// DELETE from runtime.ts:
export { executeToolCall, type ExecuteToolCallOptions, type ExecuteTool } from "./tool-executor.ts";
```

These symbols are now exported directly via the barrel's `export * from "./tool-executor.ts"`.

- [ ] **Step 3: Run full check**

Run: `pnpm check:local`
Expected: Build, typecheck, lint, publint, syncpack, tests all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/aai/host/index.ts packages/aai/host/runtime.ts
git commit -m "refactor(aai): update barrel with new modules, remove transitional re-exports"
```

---

### Task 6: Final verification and cleanup

**Files:** None created — verification only.

- [ ] **Step 1: Run full CI check**

Run: `pnpm check:local`
Expected: All phases pass (build → typecheck + lint + publint + syncpack → test).

- [ ] **Step 2: Verify typecheck passes for both zones**

Run: `pnpm typecheck`
Expected: Both `tsc --noEmit` and `tsc -p isolate/tsconfig.json` pass.

- [ ] **Step 3: Run aai-server tests to check cross-package imports**

Run: `pnpm --filter @alexkroman1/aai-server test`
Expected: All pass — aai-server imports from `@alexkroman1/aai/host` barrel which is updated.

- [ ] **Step 4: Run lint**

Run: `pnpm lint`
Expected: No lint errors.

- [ ] **Step 5: Verify no duplicate exports**

Run: `pnpm vitest run --project aai -- published-exports`
Expected: The published-exports test passes, confirming all package.json export paths resolve.

- [ ] **Step 6: Commit any remaining fixes**

If any issues were found and fixed in Steps 1–5, commit them:

```bash
git add -A packages/aai/
git commit -m "fix(aai): address post-refactor cleanup"
```

If no fixes needed, skip this step.
