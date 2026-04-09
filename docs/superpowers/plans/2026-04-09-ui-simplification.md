# UI Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify aai-ui so Claude Code can reliably generate correct custom agent UIs using standard React + Tailwind + three headless hooks.

**Architecture:** Replace Preact + Signals with React 19. Split session.ts into a framework-agnostic core + thin React hook adapter. Two-tier defineClient: config-only for simple agents, component mode for custom UIs. Tailwind for layout, typed useTheme() for colors.

**Tech Stack:** React 19, react-dom, @vitejs/plugin-react, Tailwind CSS v4, Vitest, @testing-library/react

**Spec:** `docs/superpowers/specs/2026-04-09-ui-simplification-design.md`

---

## File Structure

### New files
- `packages/aai-ui/session-core.ts` -- framework-agnostic session: WebSocket, audio, state machine, subscription pattern
- `packages/aai-ui/session-core.test.ts` -- tests for session-core

### Heavily modified files
- `packages/aai-ui/package.json` -- swap preact for react deps
- `packages/aai-ui/types.ts` -- ToolCallInfo field renames (callId, name), remove "error" from AgentState
- `packages/aai-ui/context.ts` -- React contexts: SessionProvider, ThemeProvider, useSession, useTheme
- `packages/aai-ui/hooks.ts` -- React hooks: useToolResult, useToolCallStart (drop useAutoScroll)
- `packages/aai-ui/define-client.tsx` -- two-tier config API with discriminated union
- `packages/aai-ui/styles.css` -- remove @theme block, keep @import + keyframes only
- `packages/aai-ui/index.ts` -- updated export surface
- `packages/aai-ui/components/start-screen.tsx` -- React rewrite
- `packages/aai-ui/components/chat-view.tsx` -- React rewrite, renders Controls internally
- `packages/aai-ui/components/message-list.tsx` -- React rewrite, renders ToolCallBlock internally
- `packages/aai-ui/components/sidebar-layout.tsx` -- React rewrite
- `packages/aai-ui/components/button.tsx` -- React rewrite
- `packages/aai-ui/components/controls.tsx` -- React rewrite (internal, not exported)
- `packages/aai-ui/components/tool-call-block.tsx` -- React rewrite (internal, not exported)
- `packages/aai/host/testing.ts` -- re-export matchers
- `packages/aai/package.json` -- verify ./testing exports
- `packages/aai-templates/scaffold/package.json` -- react deps
- `packages/aai-templates/scaffold/vite.config.ts` -- react plugin
- `packages/aai-templates/scaffold/CLAUDE.md` -- document new API
- All 21 template `client.tsx` files

### Deleted files
- `packages/aai-ui/session.ts` -- replaced by session-core.ts
- `packages/aai-ui/components/app.tsx` -- replaced by defineClient config tier
- `packages/aai-ui/components/tool-icons.tsx` -- tool config moves to defineClient

### Deleted test files (replaced by new tests)
- `packages/aai-ui/session.test.ts`
- `packages/aai-ui/hooks.test.ts`
- `packages/aai-ui/define-client.test.ts`
- `packages/aai-ui/context.test.ts`
- `packages/aai-ui/components/*.test.ts` (all component tests)

---

## Task 1: Update aai-ui package dependencies

**Files:**
- Modify: `packages/aai-ui/package.json`

- [ ] **Step 1: Update package.json dependencies**

Replace preact with react in `packages/aai-ui/package.json`:

```json
{
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tailwindcss": "^4.2.1"
  },
  "devDependencies": {
    "@testing-library/react": "^16.3.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "jsdom": "^29.0.2",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tsdown": "^0.21.7",
    "vitest": "^4.1.3"
  }
}
```

Remove these entries:
- `@preact/signals` from both peerDependencies and devDependencies
- `preact` from both peerDependencies and devDependencies
- `@testing-library/preact` from devDependencies

Keep: `@alexkroman1/aai: "workspace:*"` in dependencies, `clsx` in dependencies, `tailwindcss` in peerDependencies.

- [ ] **Step 2: Install dependencies**

Run: `pnpm install`

Expected: Clean install with react 19 resolved. No peer dependency warnings for preact.

- [ ] **Step 3: Commit**

```bash
git add packages/aai-ui/package.json pnpm-lock.yaml
git commit -m "chore(aai-ui): swap preact for react 19 in dependencies"
```

---

## Task 2: Update types.ts -- S2S field alignment

**Files:**
- Modify: `packages/aai-ui/types.ts`
- Modify: `packages/aai-ui/types.test.ts` (if exists, or create)

- [ ] **Step 1: Write the type tests**

Create or update `packages/aai-ui/types.test.ts`:

```typescript
import { describe, expectTypeOf, it } from "vitest";
import type { AgentState, ChatMessage, ClientTheme, ToolCallInfo } from "./types.ts";

describe("ToolCallInfo", () => {
  it("uses S2S-aligned field names", () => {
    expectTypeOf<ToolCallInfo>().toHaveProperty("callId");
    expectTypeOf<ToolCallInfo>().toHaveProperty("name");
    expectTypeOf<ToolCallInfo>().toHaveProperty("args");
    expectTypeOf<ToolCallInfo>().toHaveProperty("status");
    expectTypeOf<ToolCallInfo>().toHaveProperty("result");
    expectTypeOf<ToolCallInfo>().toHaveProperty("afterMessageIndex");
  });

  it("does not have old field names", () => {
    // @ts-expect-error -- toolCallId was renamed to callId
    expectTypeOf<ToolCallInfo>().toHaveProperty("toolCallId");
    // @ts-expect-error -- toolName was renamed to name
    expectTypeOf<ToolCallInfo>().toHaveProperty("toolName");
  });
});

describe("AgentState", () => {
  it("does not include error as a state", () => {
    const states: AgentState[] = [
      "disconnected", "connecting", "ready", "listening", "thinking", "speaking",
    ];
    expect(states).toHaveLength(6);
  });
});

describe("ClientTheme", () => {
  it("has the expected color fields", () => {
    expectTypeOf<ClientTheme>().toHaveProperty("bg");
    expectTypeOf<ClientTheme>().toHaveProperty("primary");
    expectTypeOf<ClientTheme>().toHaveProperty("text");
    expectTypeOf<ClientTheme>().toHaveProperty("surface");
    expectTypeOf<ClientTheme>().toHaveProperty("border");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-ui/types.test.ts`

Expected: FAIL -- `ToolCallInfo` still has `toolCallId`/`toolName`, `ClientTheme` doesn't exist in types.ts yet.

- [ ] **Step 3: Update types.ts**

In `packages/aai-ui/types.ts`, make these changes:

Rename ToolCallInfo fields:
```typescript
export type ToolCallInfo = {
  callId: string;          // was: toolCallId
  name: string;            // was: toolName
  args: Record<string, unknown>;
  status: "pending" | "done";
  result?: string | undefined;
  afterMessageIndex: number;
};
```

Remove `"error"` from AgentState:
```typescript
export type AgentState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking";
```

Add ClientTheme type (move from context.ts):
```typescript
export type ClientTheme = {
  bg?: string;
  primary?: string;
  text?: string;
  surface?: string;
  border?: string;
};
```

- [ ] **Step 4: Fix all references to old field names**

Search the entire aai-ui package for `toolCallId` and `toolName` references and update them:

Run: `grep -rn "toolCallId\|toolName" packages/aai-ui/`

Update every occurrence:
- `toolCallId` to `callId`
- `toolName` to `name`

This includes: `session.ts`, `hooks.ts`, `components/tool-call-block.tsx`, `components/message-list.tsx`, and their test files.

Also search for `"error"` as an AgentState value and remove/update those references.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/aai-ui/types.test.ts`

Expected: PASS

- [ ] **Step 6: Run full package tests to check for breakage**

Run: `pnpm vitest run --project aai-ui`

Fix any tests that break due to the field renames. Update test assertions from `toolCallId`/`toolName` to `callId`/`name`.

- [ ] **Step 7: Commit**

```bash
git add packages/aai-ui/
git commit -m "refactor(aai-ui): rename ToolCallInfo fields to match S2S protocol

callId (was toolCallId), name (was toolName). Remove 'error' from
AgentState -- errors are tracked via session.error instead. Add
ClientTheme type."
```

---

## Task 3: Extract session-core.ts from session.ts

This is the hardest task. The goal: extract a framework-agnostic session module that uses a subscription pattern instead of Preact signals.

**Files:**
- Create: `packages/aai-ui/session-core.ts`
- Create: `packages/aai-ui/session-core.test.ts`
- Delete: `packages/aai-ui/session.ts` (after extraction)

- [ ] **Step 1: Write session-core tests**

Create `packages/aai-ui/session-core.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCore, type SessionCore, type SessionSnapshot } from "./session-core.ts";

// Minimal mock WebSocket
class MockWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
}

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("createSessionCore", () => {
  let core: SessionCore;

  beforeEach(() => {
    core = createSessionCore({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocket as any,
    });
  });

  afterEach(() => {
    core.disconnect();
  });

  it("starts in disconnected state", () => {
    const snap = core.getSnapshot();
    expect(snap.state).toBe("disconnected");
    expect(snap.messages).toEqual([]);
    expect(snap.toolCalls).toEqual([]);
    expect(snap.started).toBe(false);
    expect(snap.running).toBe(false);
  });

  it("notifies subscribers on state change", async () => {
    const cb = vi.fn();
    core.subscribe(cb);
    core.start();
    await flush();
    expect(cb).toHaveBeenCalled();
    expect(core.getSnapshot().started).toBe(true);
  });

  it("subscribe returns unsubscribe function", () => {
    const cb = vi.fn();
    const unsub = core.subscribe(cb);
    unsub();
    core.start();
    expect(cb).not.toHaveBeenCalled();
  });

  it("getSnapshot returns immutable reference", () => {
    const snap1 = core.getSnapshot();
    core.start();
    const snap2 = core.getSnapshot();
    expect(snap1).not.toBe(snap2);
    expect(snap1.started).toBe(false);
    expect(snap2.started).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-ui/session-core.test.ts`

Expected: FAIL -- module `./session-core.ts` does not exist.

- [ ] **Step 3: Create session-core.ts**

Create `packages/aai-ui/session-core.ts`. This file adapts the logic from the existing `session.ts` (607 lines) with these structural changes:

**Public interface:**

```typescript
export type SessionSnapshot = {
  readonly state: AgentState;
  readonly messages: ChatMessage[];
  readonly toolCalls: ToolCallInfo[];
  readonly userTranscript: string | null;
  readonly agentTranscript: string | null;
  readonly error: SessionError | null;
  readonly started: boolean;
  readonly running: boolean;
};

export type SessionCore = {
  /** Current snapshot -- stable reference until next state change. */
  getSnapshot(): SessionSnapshot;
  /** Subscribe to state changes. Returns unsubscribe function.
   *  Compatible with React useSyncExternalStore. */
  subscribe(callback: () => void): () => void;

  // Methods (same as current VoiceSession)
  connect(options?: { signal?: AbortSignal }): void;
  cancel(): void;
  resetState(): void;
  reset(): void;
  disconnect(): void;
  start(): void;
  toggle(): void;
  [Symbol.dispose](): void;
};

export type SessionCoreOptions = VoiceSessionOptions;

export function createSessionCore(options: SessionCoreOptions): SessionCore;
```

**Internal state pattern -- replaces signals:**

```typescript
// Instead of: const state = signal<AgentState>("disconnected");
// Use:
let currentSnapshot: SessionSnapshot = {
  state: "disconnected",
  messages: [],
  toolCalls: [],
  userTranscript: null,
  agentTranscript: null,
  error: null,
  started: false,
  running: false,
};

const subscribers = new Set<() => void>();

function notify() {
  for (const sub of subscribers) sub();
}

/** Create a new snapshot with partial updates. Replaces batch(). */
function updateState(partial: Partial<SessionSnapshot>) {
  currentSnapshot = { ...currentSnapshot, ...partial };
  notify();
}
```

**Migration rules for adapting session.ts logic:**

| Old pattern (session.ts) | New pattern (session-core.ts) |
|--------------------------|-------------------------------|
| `signal<T>(init)` | plain variable in closure |
| `sig.value` (read) | `currentSnapshot.field` |
| `sig.value = x` (write) | `updateState({ field: x })` |
| `batch(() => { a.value = x; b.value = y; })` | `updateState({ a: x, b: y })` |
| `effect(() => { ... })` | remove -- effects live in React hooks |
| `import { signal, batch, effect } from "@preact/signals"` | remove entirely |

**Audio handling:** Keep the existing `initAudioCapture` logic, `ConnState` type, and generation counter pattern unchanged. These are framework-agnostic. The only change is replacing signal reads/writes with `currentSnapshot` reads and `updateState()` calls.

**handleEvent mapping:** Keep the existing event dispatcher (`handleEvent` function) but replace all `batch(() => { ... })` calls with `updateState({ ... })`.

**AgentState "error" removal:** Where session.ts sets `state.value = "error"`, instead set `updateState({ state: "disconnected", error: { code, message } })`. The "error" state no longer exists -- errors are tracked via the `error` field while `state` remains a valid non-error state (typically "disconnected").

**`running` computation:** Currently likely a computed signal. Replace with explicit updates -- set `running: true` in `connect()`, `running: false` in `disconnect()`. Or compute it in `updateState` as `state !== "disconnected"`.

**`disconnected` signal:** Currently holds a reason object. Fold this into the `error` field. When disconnecting with a reason, set `updateState({ state: "disconnected", error: { code: "connection", message: reason } })`.

Copy all WebSocket logic, audio lifecycle, message handling, and tool call tracking from session.ts. The business logic is identical -- only the reactivity mechanism changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/aai-ui/session-core.test.ts`

Expected: PASS

- [ ] **Step 5: Delete old session.ts and its test**

```bash
rm packages/aai-ui/session.ts
rm packages/aai-ui/session.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/aai-ui/session-core.ts packages/aai-ui/session-core.test.ts
git add -u packages/aai-ui/session.ts packages/aai-ui/session.test.ts
git commit -m "refactor(aai-ui): extract session-core with subscription pattern

Replace Preact signals with framework-agnostic getSnapshot/subscribe
pattern compatible with React useSyncExternalStore. All WebSocket,
audio, and state machine logic preserved."
```

---

## Task 4: Rewrite context.ts -- SessionProvider, ThemeProvider, useSession, useTheme

**Files:**
- Modify: `packages/aai-ui/context.ts` -- full rewrite
- Modify: `packages/aai-ui/context.test.ts` -- full rewrite

- [ ] **Step 1: Write tests**

Rewrite `packages/aai-ui/context.test.ts`:

```typescript
import { renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { SessionCore } from "./session-core.ts";
import { SessionProvider, ThemeProvider, useSession, useTheme } from "./context.ts";
import type { ClientTheme } from "./types.ts";

// Minimal mock session core
function mockSessionCore(overrides = {}): SessionCore {
  const snapshot = {
    state: "ready" as const,
    messages: [],
    toolCalls: [],
    userTranscript: null,
    agentTranscript: null,
    error: null,
    started: true,
    running: true,
    ...overrides,
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    connect: () => {},
    cancel: () => {},
    resetState: () => {},
    reset: () => {},
    disconnect: () => {},
    start: () => {},
    toggle: () => {},
    [Symbol.dispose]: () => {},
  };
}

describe("useSession", () => {
  it("returns session snapshot from context", () => {
    const core = mockSessionCore({ state: "listening" });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionProvider value={core}>{children}</SessionProvider>
    );
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(result.current.state).toBe("listening");
    expect(result.current.started).toBe(true);
  });

  it("throws when used outside SessionProvider", () => {
    expect(() => {
      renderHook(() => useSession());
    }).toThrow();
  });

  it("exposes session methods", () => {
    const core = mockSessionCore();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionProvider value={core}>{children}</SessionProvider>
    );
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(typeof result.current.start).toBe("function");
    expect(typeof result.current.cancel).toBe("function");
    expect(typeof result.current.reset).toBe("function");
    expect(typeof result.current.disconnect).toBe("function");
    expect(typeof result.current.toggle).toBe("function");
  });
});

describe("useTheme", () => {
  it("returns default theme when no provider", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.bg).toBe("#101010");
    expect(result.current.primary).toBe("#fab283");
  });

  it("returns custom theme from provider", () => {
    const theme: Required<ClientTheme> = {
      bg: "#000",
      primary: "#f00",
      text: "#fff",
      surface: "#111",
      border: "#222",
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ThemeProvider value={theme}>{children}</ThemeProvider>
    );
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.bg).toBe("#000");
    expect(result.current.primary).toBe("#f00");
  });

  it("fills missing theme fields with defaults", () => {
    const partial: ClientTheme = { primary: "#f00" };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ThemeProvider value={partial}>{children}</ThemeProvider>
    );
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.primary).toBe("#f00");
    expect(result.current.bg).toBe("#101010"); // default
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-ui/context.test.ts`

Expected: FAIL -- imports don't match new API.

- [ ] **Step 3: Rewrite context.ts**

Replace `packages/aai-ui/context.ts` entirely:

```typescript
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { SessionCore, SessionSnapshot } from "./session-core.ts";
import type { ClientTheme } from "./types.ts";

// --- Default theme ---

const DEFAULT_THEME: Required<ClientTheme> = {
  bg: "#101010",
  primary: "#fab283",
  text: "rgba(255, 255, 255, 0.94)",
  surface: "#151515",
  border: "#282828",
};

// --- Session context ---

const SessionCtx = createContext<SessionCore | null>(null);

export function SessionProvider({
  value,
  children,
}: {
  value: SessionCore;
  children?: ReactNode;
}) {
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export type Session = SessionSnapshot & {
  start(): void;
  cancel(): void;
  resetState(): void;
  reset(): void;
  disconnect(): void;
  toggle(): void;
};

export function useSession(): Session {
  const core = useContext(SessionCtx);
  if (!core) throw new Error("useSession must be used within <SessionProvider>");
  const snapshot = useSyncExternalStore(core.subscribe, core.getSnapshot);
  return {
    ...snapshot,
    start: core.start,
    cancel: core.cancel,
    resetState: core.resetState,
    reset: core.reset,
    disconnect: core.disconnect,
    toggle: core.toggle,
  };
}

// --- Theme context ---

const ThemeCtx = createContext<Required<ClientTheme>>(DEFAULT_THEME);

export function ThemeProvider({
  value,
  children,
}: {
  value?: ClientTheme;
  children?: ReactNode;
}) {
  const merged = value ? { ...DEFAULT_THEME, ...value } : DEFAULT_THEME;
  return <ThemeCtx.Provider value={merged}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Required<ClientTheme> {
  return useContext(ThemeCtx);
}

export { DEFAULT_THEME };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/aai-ui/context.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/aai-ui/context.ts packages/aai-ui/context.test.ts
git commit -m "refactor(aai-ui): rewrite context with React providers

SessionProvider wraps session-core; useSession returns snapshot + methods
via useSyncExternalStore. ThemeProvider + useTheme return typed theme
with defaults."
```

---

## Task 5: Rewrite hooks.ts -- useToolResult, useToolCallStart

**Files:**
- Modify: `packages/aai-ui/hooks.ts` -- full rewrite
- Modify: `packages/aai-ui/hooks.test.ts` -- full rewrite

- [ ] **Step 1: Write tests**

Rewrite `packages/aai-ui/hooks.test.ts`:

```typescript
import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "./context.ts";
import { useToolCallStart, useToolResult } from "./hooks.ts";
import type { SessionCore } from "./session-core.ts";
import type { ToolCallInfo } from "./types.ts";

function createMockCore(toolCalls: ToolCallInfo[] = []): SessionCore & {
  setToolCalls: (tc: ToolCallInfo[]) => void;
} {
  let snapshot = {
    state: "ready" as const,
    messages: [],
    toolCalls,
    userTranscript: null,
    agentTranscript: null,
    error: null,
    started: true,
    running: true,
  };
  const subs = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    setToolCalls: (tc) => {
      snapshot = { ...snapshot, toolCalls: tc };
      for (const cb of subs) cb();
    },
    connect: () => {},
    cancel: () => {},
    resetState: () => {},
    reset: () => {},
    disconnect: () => {},
    start: () => {},
    toggle: () => {},
    [Symbol.dispose]: () => {},
  };
}

function makeToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    callId: "tc-1",
    name: "test_tool",
    args: {},
    status: "done",
    result: JSON.stringify({ ok: true }),
    afterMessageIndex: 0,
    ...overrides,
  };
}

describe("useToolResult", () => {
  it("fires callback for completed tool call matching name", () => {
    const core = createMockCore([makeToolCall({ name: "add_pizza" })]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionProvider value={core}>{children}</SessionProvider>
    );
    renderHook(() => useToolResult("add_pizza", cb), { wrapper });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0][0]).toEqual({ ok: true });
  });

  it("does not fire for non-matching tool name", () => {
    const core = createMockCore([makeToolCall({ name: "other_tool" })]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionProvider value={core}>{children}</SessionProvider>
    );
    renderHook(() => useToolResult("add_pizza", cb), { wrapper });
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires only once per callId (deduplication)", () => {
    const tc = makeToolCall({ callId: "tc-1" });
    const core = createMockCore([tc]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionProvider value={core}>{children}</SessionProvider>
    );
    renderHook(() => useToolResult("test_tool", cb), { wrapper });
    expect(cb).toHaveBeenCalledOnce();
    // Simulate re-render with same tool call
    act(() => core.setToolCalls([tc]));
    expect(cb).toHaveBeenCalledOnce(); // still once
  });

  it("fires for all tools when no name filter", () => {
    const core = createMockCore([
      makeToolCall({ callId: "tc-1", name: "tool_a" }),
      makeToolCall({ callId: "tc-2", name: "tool_b" }),
    ]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionProvider value={core}>{children}</SessionProvider>
    );
    renderHook(() => useToolResult(cb), { wrapper });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("does not fire for pending tool calls", () => {
    const core = createMockCore([makeToolCall({ status: "pending", result: undefined })]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionProvider value={core}>{children}</SessionProvider>
    );
    renderHook(() => useToolResult("test_tool", cb), { wrapper });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("useToolCallStart", () => {
  it("fires callback for pending tool call matching name", () => {
    const core = createMockCore([
      makeToolCall({ callId: "tc-1", name: "search", status: "pending", result: undefined }),
    ]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionProvider value={core}>{children}</SessionProvider>
    );
    renderHook(() => useToolCallStart("search", cb), { wrapper });
    expect(cb).toHaveBeenCalledOnce();
  });

  it("fires for all tools when no name filter", () => {
    const core = createMockCore([
      makeToolCall({ callId: "tc-1", name: "a", status: "pending", result: undefined }),
      makeToolCall({ callId: "tc-2", name: "b", status: "pending", result: undefined }),
    ]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionProvider value={core}>{children}</SessionProvider>
    );
    renderHook(() => useToolCallStart(cb), { wrapper });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-ui/hooks.test.ts`

Expected: FAIL -- hooks.ts still uses Preact imports.

- [ ] **Step 3: Rewrite hooks.ts**

Replace `packages/aai-ui/hooks.ts` entirely:

```typescript
import { useEffect, useRef } from "react";
import { useSession } from "./context.ts";
import type { ToolCallInfo } from "./types.ts";

// --- Helpers ---

function tryParseJSON(str: string | undefined): unknown {
  if (!str) return str;
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

// --- useToolResult ---

export function useToolResult<R = unknown>(
  toolName: string,
  callback: (result: R, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult(
  callback: (name: string, result: unknown, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult(...args: unknown[]): void {
  const filterName = typeof args[0] === "string" ? (args[0] as string) : null;
  const callback = (typeof args[0] === "string" ? args[1] : args[0]) as Function;

  const session = useSession();
  const seenRef = useRef(new Set<string>());
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    // Reset seen set when toolCalls is cleared (session reset)
    if (session.toolCalls.length === 0) {
      seenRef.current.clear();
      return;
    }

    for (const tc of session.toolCalls) {
      if (tc.status !== "done") continue;
      if (seenRef.current.has(tc.callId)) continue;
      if (filterName && tc.name !== filterName) continue;

      seenRef.current.add(tc.callId);
      const parsed = tryParseJSON(tc.result);

      if (filterName) {
        (callbackRef.current as (r: unknown, tc: ToolCallInfo) => void)(parsed, tc);
      } else {
        (callbackRef.current as (n: string, r: unknown, tc: ToolCallInfo) => void)(
          tc.name, parsed, tc,
        );
      }
    }
  }, [session.toolCalls, filterName]);
}

// --- useToolCallStart ---

export function useToolCallStart(
  toolName: string,
  callback: (toolCall: ToolCallInfo) => void,
): void;
export function useToolCallStart(
  callback: (toolCall: ToolCallInfo) => void,
): void;
export function useToolCallStart(...args: unknown[]): void {
  const filterName = typeof args[0] === "string" ? (args[0] as string) : null;
  const callback = (typeof args[0] === "string" ? args[1] : args[0]) as Function;

  const session = useSession();
  const seenRef = useRef(new Set<string>());
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (session.toolCalls.length === 0) {
      seenRef.current.clear();
      return;
    }

    for (const tc of session.toolCalls) {
      if (tc.status !== "pending") continue;
      if (seenRef.current.has(tc.callId)) continue;
      if (filterName && tc.name !== filterName) continue;

      seenRef.current.add(tc.callId);
      (callbackRef.current as (tc: ToolCallInfo) => void)(tc);
    }
  }, [session.toolCalls, filterName]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/aai-ui/hooks.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/aai-ui/hooks.ts packages/aai-ui/hooks.test.ts
git commit -m "refactor(aai-ui): rewrite hooks with React refs/effects

useToolResult and useToolCallStart now use React useEffect + useRef
for deduplication instead of Preact useSignalEffect."
```

---

## Task 6: Rewrite components to React

**Files:**
- Modify: `packages/aai-ui/components/start-screen.tsx`
- Modify: `packages/aai-ui/components/chat-view.tsx`
- Modify: `packages/aai-ui/components/message-list.tsx`
- Modify: `packages/aai-ui/components/sidebar-layout.tsx`
- Modify: `packages/aai-ui/components/button.tsx`
- Modify: `packages/aai-ui/components/controls.tsx`
- Modify: `packages/aai-ui/components/tool-call-block.tsx`
- Delete: `packages/aai-ui/components/app.tsx`
- Delete: `packages/aai-ui/components/tool-icons.tsx`

- [ ] **Step 1: Rewrite each component from Preact to React**

For every component file, apply these mechanical transformations:

| Preact | React |
|--------|-------|
| `import { h } from "preact"` | remove (JSX transform handles it) |
| `import { ... } from "preact/hooks"` | `import { ... } from "react"` |
| `import type { ComponentChildren } from "preact"` | `import type { ReactNode } from "react"` |
| `ComponentChildren` | `ReactNode` |
| `class=` | `className=` |
| `signal.value` | direct prop/state value |
| `useSignalEffect(...)` | `useEffect(...)` |

**button.tsx** -- Straightforward: change Preact hooks import to React, `class` to `className`, `ComponentChildren` to `ReactNode`. Keep variants (default, secondary, ghost) and sizes (default, lg).

**start-screen.tsx** -- Change Preact to React. Use `useSession()` from new context (returns plain state, not signals). Replace `session.started.value` with `session.started`, `session.start` stays the same.

**controls.tsx** -- Change Preact to React. Replace `session.running.value` with `session.running`, `session.state.value` with `session.state`.

**message-list.tsx** -- Change Preact to React. Replace `session.messages.value` with `session.messages`, `session.toolCalls.value` with `session.toolCalls`, etc. The auto-scroll logic should be inlined using a `useEffect` + `useRef` pattern (since useAutoScroll is removed from the public API). Read tool display config from `ToolConfigContext` (provided by defineClient).

**tool-call-block.tsx** -- Change Preact to React. Read tool display config from `ToolConfigContext` instead of hardcoded `TOOL_CONFIG`. If no config found for a tool name, show a default icon/label.

**chat-view.tsx** -- Change Preact to React. Render `Controls` internally (not exported separately). Accept `title` and `className` props.

**sidebar-layout.tsx** -- Change Preact to React. Accept `sidebar` (ReactNode), `sidebarWidth` (string), `sidebarPosition` ("left" | "right") props.

All components should use `useTheme()` for any color values instead of referencing `aai-*` CSS custom properties. For example:

```tsx
// Before
<div class="bg-aai-surface border-aai-border">

// After
const theme = useTheme();
<div className="border" style={{ background: theme.surface, borderColor: theme.border }}>
```

- [ ] **Step 2: Delete app.tsx and tool-icons.tsx**

```bash
rm packages/aai-ui/components/app.tsx
rm packages/aai-ui/components/app.test.ts  # if exists
rm packages/aai-ui/components/tool-icons.tsx
```

`App` is replaced by defineClient config tier. `tool-icons.tsx` is replaced by emoji-based tool config in defineClient.

- [ ] **Step 3: Update component test files**

Update all test files in `packages/aai-ui/components/` to use `@testing-library/react` instead of `@testing-library/preact`. Replace signal-based mock sessions with the `mockSessionCore` pattern from Task 4. Each test should wrap components in `<SessionProvider>` and `<ThemeProvider>`.

- [ ] **Step 4: Run component tests**

Run: `pnpm vitest run --project aai-ui`

Fix any failures. Common issues:
- `class` vs `className` mismatches
- Signal `.value` access not fully removed
- Missing context providers in tests

- [ ] **Step 5: Commit**

```bash
git add packages/aai-ui/components/
git commit -m "refactor(aai-ui): rewrite all components to React

Remove App and tool-icons. Components use useSession/useTheme from
context instead of direct signal access."
```

---

## Task 7: Rewrite defineClient with two-tier config API

**Files:**
- Modify: `packages/aai-ui/define-client.tsx` -- full rewrite
- Modify: `packages/aai-ui/define-client.test.ts` -- full rewrite

- [ ] **Step 1: Write tests**

Rewrite `packages/aai-ui/define-client.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineClient } from "./define-client.tsx";

// Mock createSessionCore to avoid real WebSocket
vi.mock("./session-core.ts", () => ({
  createSessionCore: vi.fn(() => ({
    getSnapshot: () => ({
      state: "disconnected",
      messages: [],
      toolCalls: [],
      userTranscript: null,
      agentTranscript: null,
      error: null,
      started: false,
      running: false,
    }),
    subscribe: () => () => {},
    connect: vi.fn(),
    cancel: vi.fn(),
    resetState: vi.fn(),
    reset: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    toggle: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  })),
}));

describe("defineClient", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    container.id = "app";
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.textContent = "";
  });

  it("renders with config-only (tier 1)", () => {
    const handle = defineClient({ title: "Test Agent", target: "#app" });
    expect(handle.session).toBeDefined();
    expect(typeof handle.dispose).toBe("function");
    expect(container.childNodes.length).toBeGreaterThan(0);
  });

  it("renders with custom component (tier 2)", () => {
    function MyApp() {
      return <div data-testid="custom">Custom</div>;
    }
    const handle = defineClient({ component: MyApp, target: "#app" });
    expect(container.querySelector("[data-testid='custom']")).not.toBeNull();
    handle.dispose();
  });

  it("dispose unmounts and disconnects", () => {
    const handle = defineClient({ title: "Test", target: "#app" });
    handle.dispose();
    expect(container.childNodes.length).toBe(0);
  });

  it("applies theme to context", () => {
    const handle = defineClient({
      title: "Themed",
      theme: { primary: "#f00" },
      target: "#app",
    });
    expect(handle.session).toBeDefined();
    handle.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-ui/define-client.test.ts`

Expected: FAIL -- defineClient still expects `(Component, options)` signature.

- [ ] **Step 3: Rewrite define-client.tsx**

Replace `packages/aai-ui/define-client.tsx` entirely:

```tsx
import React, { createContext, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createSessionCore, type SessionCore } from "./session-core.ts";
import { SessionProvider, ThemeProvider } from "./context.ts";
import { StartScreen } from "./components/start-screen.tsx";
import { ChatView } from "./components/chat-view.tsx";
import { SidebarLayout } from "./components/sidebar-layout.tsx";
import type { ClientTheme, WebSocketConstructor } from "./types.ts";

// --- Tool display config ---

export type ToolDisplayEntry = {
  icon?: string;
  label?: string;
};

export type ToolDisplayConfig = Record<string, ToolDisplayEntry>;

export const ToolConfigContext = createContext<ToolDisplayConfig>({});

// --- Config types ---

type BaseOptions = {
  theme?: ClientTheme;
  target?: string | HTMLElement;
  platformUrl?: string;
  onSessionId?: (sessionId: string) => void;
  resumeSessionId?: string;
  WebSocket?: WebSocketConstructor;
};

type ConfigTier = BaseOptions & {
  title?: string;
  sidebar?: ComponentType;
  sidebarWidth?: string;
  tools?: ToolDisplayConfig;
};

type ComponentTier = BaseOptions & {
  component: ComponentType;
};

export type ClientConfig = ConfigTier | ComponentTier;

export type ClientHandle = {
  session: SessionCore;
  dispose(): void;
  [Symbol.dispose](): void;
};

// --- Default shell ---

function DefaultShell({
  title,
  Sidebar,
  sidebarWidth,
}: {
  title?: string;
  Sidebar?: ComponentType;
  sidebarWidth?: string;
}) {
  if (Sidebar) {
    return (
      <StartScreen title={title}>
        <SidebarLayout sidebar={<Sidebar />} sidebarWidth={sidebarWidth}>
          <ChatView title={title} />
        </SidebarLayout>
      </StartScreen>
    );
  }
  return (
    <StartScreen title={title}>
      <ChatView title={title} />
    </StartScreen>
  );
}

// --- defineClient ---

function resolveContainer(target: string | HTMLElement = "#app"): HTMLElement {
  if (typeof target === "string") {
    const el = document.querySelector<HTMLElement>(target);
    if (!el) throw new Error(`defineClient: target "${target}" not found`);
    return el;
  }
  return target;
}

export function defineClient(config: ClientConfig): ClientHandle {
  const container = resolveContainer(config.target);

  const session = createSessionCore({
    platformUrl: config.platformUrl ?? location.origin + location.pathname,
    onSessionId: config.onSessionId,
    resumeSessionId: config.resumeSessionId,
    WebSocket: config.WebSocket,
  });

  const toolConfig = "tools" in config ? (config.tools ?? {}) : {};

  const root = createRoot(container);

  const Component = "component" in config
    ? config.component
    : () => (
        <DefaultShell
          title={"title" in config ? config.title : undefined}
          Sidebar={"sidebar" in config ? config.sidebar : undefined}
          sidebarWidth={"sidebarWidth" in config ? config.sidebarWidth : undefined}
        />
      );

  root.render(
    <SessionProvider value={session}>
      <ThemeProvider value={config.theme}>
        <ToolConfigContext value={toolConfig}>
          <Component />
        </ToolConfigContext>
      </ThemeProvider>
    </SessionProvider>,
  );

  function dispose() {
    root.unmount();
    session.disconnect();
  }

  return {
    session,
    dispose,
    [Symbol.dispose]: dispose,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/aai-ui/define-client.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/aai-ui/define-client.tsx packages/aai-ui/define-client.test.ts
git commit -m "refactor(aai-ui): two-tier defineClient API

Config tier: title, theme, sidebar, tools. Component tier: full custom
component. Both rendered via React createRoot with SessionProvider +
ThemeProvider + ToolConfigContext."
```

---

## Task 8: Update styles.css and index.ts

**Files:**
- Modify: `packages/aai-ui/styles.css`
- Modify: `packages/aai-ui/index.ts`

- [ ] **Step 1: Shrink styles.css**

Replace `packages/aai-ui/styles.css` with:

```css
@import "tailwindcss";

@source "./";
@source "../dist/ui/";

@layer base {
  html, body {
    margin: 0;
    padding: 0;
  }
}

@keyframes aai-bounce {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

@keyframes aai-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.tool-shimmer {
  background: linear-gradient(90deg, currentColor 25%, transparent 50%, currentColor 75%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: aai-shimmer 2s infinite;
}
```

Removed: entire `@theme { }` block with all `--color-aai-*`, `--radius-aai`, `--font-aai-*` tokens. Colors now come from `useTheme()`.

- [ ] **Step 2: Update index.ts**

Replace `packages/aai-ui/index.ts` with:

```typescript
// Components
export { Button } from "./components/button.tsx";
export { ChatView } from "./components/chat-view.tsx";
export { MessageList } from "./components/message-list.tsx";
export { SidebarLayout } from "./components/sidebar-layout.tsx";
export { StartScreen } from "./components/start-screen.tsx";

// Context & hooks
export { SessionProvider, ThemeProvider, useSession, useTheme } from "./context.ts";
export type { Session } from "./context.ts";
export { useToolCallStart, useToolResult } from "./hooks.ts";

// Entry
export { defineClient } from "./define-client.tsx";
export type {
  ClientConfig,
  ClientHandle,
  ToolDisplayConfig,
  ToolDisplayEntry,
} from "./define-client.tsx";

// Session core (for advanced use)
export { createSessionCore } from "./session-core.ts";
export type {
  SessionCore,
  SessionCoreOptions,
  SessionSnapshot,
} from "./session-core.ts";

// Types
export type {
  AgentState,
  ChatMessage,
  ClientTheme,
  SessionError,
  SessionErrorCode,
  ToolCallInfo,
  VoiceSessionOptions,
  WebSocketConstructor,
} from "./types.ts";
```

Removed exports: `App`, `Controls`, `ToolCallBlock`, `useAutoScroll`, `ClientConfigProvider`, `useClientConfig`, `VoiceSession` (replaced by `Session`), `createVoiceSession` (replaced by `createSessionCore`).

- [ ] **Step 3: Run type check**

Run: `pnpm --filter @alexkroman1/aai-ui typecheck`

Expected: PASS. Fix any type errors from stale imports.

- [ ] **Step 4: Run all aai-ui tests**

Run: `pnpm vitest run --project aai-ui`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/aai-ui/styles.css packages/aai-ui/index.ts
git commit -m "refactor(aai-ui): shrink styles.css and update exports

Remove all custom Tailwind tokens -- colors come from useTheme().
Update index.ts to new public API surface: 5 components, 4 hooks,
defineClient, createSessionCore, 5 type exports."
```

---

## Task 9: Flatten test harness imports

**Files:**
- Modify: `packages/aai/host/testing.ts`
- Create: `packages/aai/host/testing-exports.test.ts`

- [ ] **Step 1: Write test for flattened imports**

Create `packages/aai/host/testing-exports.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createTestHarness, toHaveCalledTool } from "./testing.ts";

describe("testing exports", () => {
  it("exports createTestHarness", () => {
    expect(typeof createTestHarness).toBe("function");
  });

  it("exports toHaveCalledTool from single entry point", () => {
    expect(typeof toHaveCalledTool).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify current state**

Run: `pnpm vitest run packages/aai/host/testing-exports.test.ts`

Expected: FAIL if `toHaveCalledTool` is not yet exported from `testing.ts`.

- [ ] **Step 3: Re-export matchers from testing.ts**

In `packages/aai/host/testing.ts`, add at the end:

```typescript
// Re-export matchers for single-import convenience
export * from "./matchers.ts";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/aai/host/testing-exports.test.ts`

Expected: PASS

- [ ] **Step 5: Verify existing ./testing/matchers subpath still works**

Run: `grep -rn "from.*testing/matchers" packages/`

Confirm existing imports still resolve. The subpath stays for backwards compatibility.

- [ ] **Step 6: Commit**

```bash
git add packages/aai/host/testing.ts packages/aai/host/testing-exports.test.ts
git commit -m "feat(aai): re-export matchers from ./testing entry point

Single import: import { createTestHarness, toHaveCalledTool } from
'@alexkroman1/aai/testing'. The ./testing/matchers subpath still works
for backwards compatibility."
```

---

## Task 10: Update scaffold

**Files:**
- Modify: `packages/aai-templates/scaffold/package.json`
- Modify: `packages/aai-templates/scaffold/vite.config.ts`
- Modify: `packages/aai-templates/scaffold/CLAUDE.md`

- [ ] **Step 1: Update scaffold package.json**

In `packages/aai-templates/scaffold/package.json`:

Replace dependencies:
```json
{
  "dependencies": {
    "@alexkroman1/aai": "^0.12.3",
    "@alexkroman1/aai-ui": "^0.12.3",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tailwindcss": "^4.2.1",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.9",
    "@vitejs/plugin-react": "^4.5.0",
    "@tailwindcss/vite": "^4.2.1",
    "typescript": "^6.0.2",
    "vite": "^8.0.3",
    "vitest": "^4.1.1"
  }
}
```

Remove: `preact`, `@preact/signals`, `@preact/preset-vite`.

- [ ] **Step 2: Update scaffold vite.config.ts**

Replace `packages/aai-templates/scaffold/vite.config.ts`:

```typescript
import { aai } from "@alexkroman1/aai/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [aai(), react(), tailwindcss()],
  build: {
    target: "es2022",
    minify: true,
  },
  ssr: {
    noExternal: true,
  },
});
```

Removed: `preact()` plugin, `resolve.dedupe` for preact.

- [ ] **Step 3: Update scaffold CLAUDE.md**

In `packages/aai-templates/scaffold/CLAUDE.md`, update the UI section to document the new API. Key changes to make:

- Replace all Preact references with React
- Document `defineClient` config tier (simple) and component tier (custom)
- Document `useSession()`, `useTheme()`, `useToolResult()` hooks
- Document the styling rule: Tailwind for layout, `useTheme()` for colors
- Remove references to `App` component, signals, `.value` access
- Show the three usage patterns: config-only, config+sidebar, full custom component

Read the existing CLAUDE.md first and update the relevant sections in place.

- [ ] **Step 4: Verify scaffold typecheck**

Run: `pnpm --filter @alexkroman1/aai-templates typecheck`

Expected: PASS (or known failures from templates not yet updated).

- [ ] **Step 5: Commit**

```bash
git add packages/aai-templates/scaffold/
git commit -m "chore(templates): update scaffold for React + new aai-ui API

Swap preact for react in deps, update vite config, rewrite CLAUDE.md
to document defineClient, useSession, useTheme, useToolResult."
```

---

## Task 11: Rewrite simple templates

**Files:**
- Modify: all 13 simple template `client.tsx` files

Templates: `simple`, `code-interpreter`, `memory-agent`, `math-buddy`, `health-assistant`, `personal-finance`, `travel-concierge`, `web-researcher`, `smart-research`, `embedded-assets`, `support`, `test-patterns`.

Also includes any other templates that use the default `App` component with no custom UI.

- [ ] **Step 1: Update each simple template client.tsx**

Replace every simple template's `client.tsx` with a single `defineClient` call:

```typescript
import { defineClient } from "@alexkroman1/aai-ui";

defineClient({ title: "TEMPLATE_TITLE" });
```

Where `TEMPLATE_TITLE` matches the template name (e.g., "Simple Agent", "Code Interpreter", "Memory Agent", etc.). Check each template's current `defineClient` call or agent title for the correct name.

- [ ] **Step 2: Run template tests**

Run: `pnpm test:templates`

Expected: PASS. Template tests validate agent behavior, not UI rendering.

- [ ] **Step 3: Commit**

```bash
git add packages/aai-templates/templates/
git commit -m "refactor(templates): simplify all default-UI templates to one-line defineClient"
```

---

## Task 12: Rewrite custom templates

**Files:**
- Modify: `packages/aai-templates/templates/night-owl/client.tsx`
- Modify: `packages/aai-templates/templates/pizza-ordering/client.tsx`
- Modify: `packages/aai-templates/templates/pizza-ordering/shared.ts`
- Modify: `packages/aai-templates/templates/infocom-adventure/client.tsx`
- Modify: `packages/aai-templates/templates/dispatch-center/client.tsx`
- Modify: `packages/aai-templates/templates/solo-rpg/client.tsx`
- Modify: `packages/aai-templates/templates/solo-rpg/shared.ts`

- [ ] **Step 1: Rewrite night-owl**

Read `packages/aai-templates/templates/night-owl/agent.ts` to confirm tool names and result shapes.

Rewrite `client.tsx` using config tier with a sidebar component. The sidebar component uses `useToolResult()` + `useTheme()` + `useState()` from React. Target ~80 lines.

Example structure:

```tsx
import { useState } from "react";
import { defineClient, useTheme, useToolResult } from "@alexkroman1/aai-ui";

type Recommendation = { title: string; type: string; description: string };

function RecommendationPanel() {
  const theme = useTheme();
  const [recs, setRecs] = useState<Recommendation[]>([]);

  useToolResult("get_recommendations", (result: { items: Recommendation[] }) => {
    setRecs(result.items);
  });

  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-y-auto">
      <h2 className="text-lg font-semibold" style={{ color: theme.primary }}>
        Recommendations
      </h2>
      {recs.length === 0 ? (
        <p className="text-sm" style={{ color: theme.text + "80" }}>
          Ask me for movie, music, or book recommendations!
        </p>
      ) : (
        recs.map((r, i) => (
          <div
            key={i}
            className="rounded-lg p-3 border"
            style={{ background: theme.surface, borderColor: theme.border }}
          >
            <div className="font-medium" style={{ color: theme.text }}>{r.title}</div>
            <div className="text-xs mt-1" style={{ color: theme.text + "80" }}>{r.type}</div>
            <div className="text-sm mt-2" style={{ color: theme.text + "cc" }}>{r.description}</div>
          </div>
        ))
      )}
    </div>
  );
}

defineClient({
  title: "Night Owl",
  theme: {
    bg: "#0c0e1a",
    primary: "#a78bfa",
    text: "#e2e0f0",
    surface: "#131627",
    border: "#1e2340",
  },
  sidebar: RecommendationPanel,
  tools: {
    get_recommendations: { icon: "filmstrip", label: "Finding picks" },
  },
});
```

Adapt the tool name and result shape to match the actual agent.ts definitions.

- [ ] **Step 2: Rewrite pizza-ordering**

Update `shared.ts` -- rename any `ToolCallInfo` field references (`toolCallId` to `callId`, `toolName` to `name`).

Rewrite `client.tsx` using config tier with sidebar:
- Replace `import { ... } from "preact/hooks"` with `import { useState } from "react"`
- Use `useTheme()` for all colors instead of CSS custom properties
- Use `defineClient({ sidebar: OrderPanel, tools: { ... } })` config tier
- Remove `useAutoScroll()` -- handled internally by the default shell
- Keep `useToolResult` hooks for order state management
- Target ~100 lines

- [ ] **Step 3: Rewrite infocom-adventure**

This template has a fully custom CRT terminal aesthetic. Use component tier:

```typescript
defineClient({
  component: IncomAdventureApp,
  theme: { bg: "#0a0a0a", primary: "#33ff33", text: "#33ff33", surface: "#111", border: "#222" },
});
```

Inside `IncomAdventureApp`, use `useSession()` + `useTheme()` + standard React. Replace all Preact hooks with React equivalents. Use inline styles for the CRT animation effects. Target ~120 lines.

- [ ] **Step 4: Rewrite dispatch-center**

Use config tier with sidebar for incident tracking.

Key change: replace the regex-based incident extraction from messages with clean `useToolResult` handlers:

```tsx
useToolResult("create_incident", (result) => {
  setIncidents(prev => [...prev, result.incident]);
});
useToolResult("update_incident", (result) => {
  setIncidents(prev => prev.map(i => i.id === result.incident.id ? result.incident : i));
});
```

Read the agent.ts to confirm exact tool names and result shapes. Target ~200 lines.

- [ ] **Step 5: Rewrite solo-rpg**

The most complex template. Use component tier.

Update `shared.ts` -- rename `ToolCallInfo` field references.

Rewrite `client.tsx`:
- Replace Preact with React
- Replace all signal access with `useSession()` state
- Use `useTheme()` for all colors
- Keep `useToolResult` hooks for game state (character, clocks, NPCs)
- Simplify layout using standard React + Tailwind
- Target ~450 lines

- [ ] **Step 6: Run template tests**

Run: `pnpm test:templates`

Expected: PASS

- [ ] **Step 7: Run type check across all packages**

Run: `pnpm typecheck`

Fix any type errors in templates.

- [ ] **Step 8: Commit**

```bash
git add packages/aai-templates/templates/
git commit -m "refactor(templates): rewrite all custom UIs with React + new hooks

night-owl, pizza-ordering use config tier with sidebar. infocom-adventure,
dispatch-center, solo-rpg use component tier. All use useSession +
useToolResult + useTheme. No Preact signals, no custom CSS tokens."
```

---

## Task 13: Full verification

**Files:** None (verification only)

- [ ] **Step 1: Run pnpm check:local**

Run: `pnpm check:local`

Expected: PASS. This runs build, then typecheck + lint + publint + syncpack in parallel, then tests.

Fix any issues that come up. Common problems:
- Stale imports of deleted exports (`App`, `useAutoScroll`, `Controls`, `ToolCallBlock`)
- Syncpack version drift if react versions don't match across packages
- Publint errors if package.json exports don't match built files
- Lint issues from React JSX patterns that differ from Preact

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`

Expected: PASS across all packages.

- [ ] **Step 3: Create changeset**

Run: `pnpm changeset:create --pkg @alexkroman1/aai --pkg @alexkroman1/aai-ui --bump major --summary "Migrate aai-ui from Preact to React 19 with simplified API: useSession, useTheme, useToolResult hooks + two-tier defineClient"`

This is a **major** bump because:
- Breaking: Preact to React (different peer dependency)
- Breaking: ToolCallInfo field renames (callId, name)
- Breaking: Removed exports (App, Controls, ToolCallBlock, useAutoScroll, createVoiceSession)
- Breaking: defineClient signature changed from `(Component, options)` to `(config)`

- [ ] **Step 4: Commit changeset**

```bash
git add .changeset/
git commit -m "chore: add changeset for aai-ui React migration"
```
