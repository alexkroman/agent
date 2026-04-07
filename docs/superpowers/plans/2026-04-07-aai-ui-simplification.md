# aai-ui Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the `@alexkroman1/aai-ui` package by reducing abstraction layers, inlining micro-components, and shrinking the public API surface.

**Architecture:** Bottom-up consolidation. Hardcode Preact signals (remove `Reactive<T>` abstraction), inline `ClientHandler` class into session, merge `createSessionControls` into `createVoiceSession`, consolidate micro-components into parents, and trim exports. The `./session` subpath export is removed.

**Tech Stack:** Preact, @preact/signals, Vitest, Tailwind CSS v4, clsx

**Spec:** `docs/superpowers/specs/2026-04-07-aai-ui-simplification-design.md`

**Worktree:** `.worktrees/ui-simplify` (branch: `feature/ui-simplify`)

---

## Task 1: Remove Reactive<T> and factory injection from session.ts

**Files:**
- Modify: `packages/aai-ui/session.ts`
- Modify: `packages/aai-ui/types.ts`

- [ ] **Step 1: Update types.ts — remove Reactive<T>, reactiveFactory, batch from VoiceSessionOptions**

In `packages/aai-ui/types.ts`:

Remove the `Reactive<T>` type (lines 67-68):
```ts
// DELETE:
export type Reactive<T> = { value: T };
```

Remove `reactiveFactory` and `batch` from `VoiceSessionOptions` (lines 79-89):
```ts
// DELETE these two fields from VoiceSessionOptions:
  reactiveFactory?: <T>(initial: T) => Reactive<T>;
  batch?: (fn: () => void) => void;
```

- [ ] **Step 2: Update session.ts — import signal/batch from @preact/signals, use directly**

In `packages/aai-ui/session.ts`, add import and replace usages:

Add to imports:
```ts
import { batch, type Signal, signal } from "@preact/signals";
```

In `createVoiceSession`, remove the lines that read `reactiveFactory` and `batch` from options (lines 204-208):
```ts
// DELETE:
  const WS: WebSocketConstructor =
    options.WebSocket ?? (WebSocket as unknown as WebSocketConstructor);
  const reactive =
    options.reactiveFactory ?? (<T>(initial: T): Reactive<T> => ({ value: initial }));
  const batchFn = options.batch ?? ((fn: () => void) => fn());

// REPLACE WITH:
  const WS: WebSocketConstructor =
    options.WebSocket ?? (WebSocket as unknown as WebSocketConstructor);
```

Replace all `reactive<X>(...)` calls with `signal<X>(...)`:
```ts
  const state = signal<AgentState>("disconnected");
  const messages = signal<ChatMessage[]>([]);
  const toolCalls = signal<ToolCallInfo[]>([]);
  const userUtterance = signal<string | null>(null);
  const agentUtterance = signal<string | null>(null);
  const error = signal<SessionError | null>(null);
  const disconnected = signal<{ intentional: boolean } | null>(null);
```

Replace all `batchFn(...)` calls with `batch(...)` (in `resetState`, `audioDeps`, and the `connect` function).

Update the `audioDeps` object:
```ts
  const audioDeps = { send, sendBinary, state, error, batch };
```

Update the `ClientHandler` construction in `connect()` to pass `batch` instead of `batchFn`:
```ts
    const handler = new ClientHandler({
      state,
      messages,
      toolCalls,
      userUtterance,
      agentUtterance,
      error,
      voiceIO: () => conn.voiceIO,
      batch,
    });
```

Update the `VoiceSession` type to use `Signal<T>` instead of `Reactive<T>`:
```ts
export type VoiceSession = {
  readonly state: Signal<AgentState>;
  readonly messages: Signal<ChatMessage[]>;
  readonly toolCalls: Signal<ToolCallInfo[]>;
  readonly userUtterance: Signal<string | null>;
  readonly agentUtterance: Signal<string | null>;
  readonly error: Signal<SessionError | null>;
  readonly disconnected: Signal<{ intentional: boolean } | null>;
  // ... methods unchanged
};
```

Remove the re-export of `Reactive` from session.ts:
```ts
// DELETE from the re-exports block:
  Reactive,
```

Also update the `initAudioCapture` deps parameter type to use `Signal` instead of `Reactive`:
```ts
  deps: {
    send: (msg: ClientMessage) => void;
    sendBinary: (data: ArrayBuffer) => void;
    state: Signal<AgentState>;
    error: Signal<SessionError | null>;
    batch: (fn: () => void) => void;
  },
```

- [ ] **Step 3: Update client-handler.ts — use Signal instead of Reactive**

In `packages/aai-ui/client-handler.ts`:

Replace the import:
```ts
// DELETE:
import type { AgentState, ChatMessage, Reactive, SessionError, ToolCallInfo } from "./types.ts";
// REPLACE WITH:
import type { Signal } from "@preact/signals";
import type { AgentState, ChatMessage, SessionError, ToolCallInfo } from "./types.ts";
```

Update all `Reactive<X>` types in the constructor parameter to `Signal<X>`:
```ts
  constructor(opts: {
    state: Signal<AgentState>;
    messages: Signal<ChatMessage[]>;
    toolCalls: Signal<ToolCallInfo[]>;
    userUtterance: Signal<string | null>;
    agentUtterance: Signal<string | null>;
    error: Signal<SessionError | null>;
    voiceIO: () => VoiceIO | null;
    batch: (fn: () => void) => void;
  })
```

Update private field types:
```ts
  #state: Signal<AgentState>;
  #messages: Signal<ChatMessage[]>;
  #toolCalls: Signal<ToolCallInfo[]>;
  #userUtterance: Signal<string | null>;
  #agentUtterance: Signal<string | null>;
  #error: Signal<SessionError | null>;
```

- [ ] **Step 4: Run tests to verify nothing breaks**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:aai-ui`
Expected: All 171 tests pass. Tests use `signal()` and `batch()` from `@preact/signals` already in `_test-utils.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/aai-ui/session.ts packages/aai-ui/types.ts packages/aai-ui/client-handler.ts
git commit -m "refactor(aai-ui): remove Reactive<T> abstraction, hardcode Preact signals"
```

---

## Task 2: Inline ClientHandler into session.ts

**Files:**
- Modify: `packages/aai-ui/session.ts`
- Delete: `packages/aai-ui/client-handler.ts`

- [ ] **Step 1: Move handler logic into session.ts**

In `packages/aai-ui/session.ts`, add the imports that `client-handler.ts` uses (merge with existing):
```ts
import type { ClientMessage, ReadyConfig, ServerMessage } from "@alexkroman1/aai/protocol";
import { lenientParse, ReadyConfigSchema, ServerMessageSchema } from "@alexkroman1/aai/protocol";
import { errorMessage } from "@alexkroman1/aai/utils";
```

Inside the `createVoiceSession` function body, after the signal declarations, add the handler logic as closure functions. Replace the `ClientHandler` class instantiation with these local functions:

```ts
  // ─── Message handler (inlined from ClientHandler) ─────────────────────
  let generation = 0;
  let deltaAccum = "";

  function handleEvent(e: import("@alexkroman1/aai/protocol").ClientEvent): void {
    switch (e.type) {
      case "speech_started":
        userUtterance.value = "";
        break;
      case "speech_stopped":
        break;
      case "user_transcript_delta":
        userUtterance.value = e.text;
        break;
      case "user_transcript":
        generation++;
        deltaAccum = "";
        batch(() => {
          userUtterance.value = null;
          messages.value = [...messages.value, { role: "user", content: e.text }];
          state.value = "thinking";
        });
        break;
      case "agent_transcript_delta":
        deltaAccum += (deltaAccum ? " " : "") + e.text;
        agentUtterance.value = deltaAccum;
        break;
      case "agent_transcript":
        deltaAccum = "";
        batch(() => {
          agentUtterance.value = null;
          messages.value = [...messages.value, { role: "assistant", content: e.text }];
        });
        break;
      case "tool_call":
        toolCalls.value = [
          ...toolCalls.value,
          {
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            args: e.args,
            status: "pending",
            afterMessageIndex: messages.value.length - 1,
          },
        ];
        break;
      case "tool_call_done": {
        const tcs = toolCalls.value;
        const idx = tcs.findIndex((tc) => tc.toolCallId === e.toolCallId);
        if (idx !== -1) {
          const updated = [...tcs];
          const existing = updated[idx];
          if (existing) updated[idx] = { ...existing, status: "done", result: e.result };
          toolCalls.value = updated;
        }
        break;
      }
      case "reply_done":
        state.value = "listening";
        break;
      case "cancelled":
        generation++;
        conn.voiceIO?.flush();
        batch(() => {
          userUtterance.value = null;
          agentUtterance.value = null;
          state.value = "listening";
        });
        break;
      case "reset": {
        generation++;
        conn.voiceIO?.flush();
        batch(() => {
          messages.value = [];
          toolCalls.value = [];
          userUtterance.value = null;
          agentUtterance.value = null;
          error.value = null;
          state.value = "listening";
        });
        break;
      }
      case "error":
        console.error("Agent error:", e.message);
        batch(() => {
          error.value = { code: e.code, message: e.message };
          state.value = "error";
        });
        break;
      default:
        break;
    }
  }

  function playAudioChunk(chunk: Uint8Array): void {
    if (state.value === "error") return;
    if (state.value !== "speaking") {
      state.value = "speaking";
    }
    if (chunk.buffer instanceof ArrayBuffer) {
      conn.voiceIO?.enqueue(chunk.buffer);
    }
  }

  function playAudioDone(): void {
    const gen = generation;
    const io = conn.voiceIO;
    if (io) {
      void io
        .done()
        .then(() => {
          if (generation !== gen) return;
          state.value = "listening";
        })
        .catch((err: unknown) => {
          console.warn("Audio playback done failed:", err);
        });
    } else {
      state.value = "listening";
    }
  }

  function handleMessage(data: string | ArrayBuffer): (ReadyConfig & { sessionId?: string }) | null {
    if (data instanceof ArrayBuffer) {
      playAudioChunk(new Uint8Array(data));
      return null;
    }
    let msg: ServerMessage;
    try {
      const result = lenientParse(ServerMessageSchema, JSON.parse(data));
      if (!result.ok) {
        if (result.malformed) console.warn("Ignoring invalid server message:", result.error);
        return null;
      }
      msg = result.data;
    } catch {
      return null;
    }
    if (msg.type === "config") {
      const { type: _, sessionId, ...config } = msg;
      const parsed = ReadyConfigSchema.safeParse(config);
      if (!parsed.success) {
        console.warn("Unsupported server config:", parsed.error.message);
        return null;
      }
      return sessionId ? { ...parsed.data, sessionId } : parsed.data;
    }
    if (msg.type === "audio_done") {
      playAudioDone();
      return null;
    }
    handleEvent(msg);
    return null;
  }
```

In the `connect()` function, replace the `ClientHandler` instantiation and the message event listener with:

```ts
    socket.addEventListener(
      "message",
      (event: MessageEvent) => {
        const config = handleMessage(event.data);
        if (config) {
          // ... rest of config handling unchanged
        }
      },
      { signal: sig },
    );
```

Remove the `ClientHandler` import and the `export { ClientHandler }` re-export from session.ts.

- [ ] **Step 2: Delete client-handler.ts**

```bash
rm packages/aai-ui/client-handler.ts
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:aai-ui`
Expected: `client-handler.test.ts` will fail because it imports the deleted file. The `session.test.ts` and `fixture-replay.test.tsx` tests should still pass since they test through the session API.

- [ ] **Step 4: Migrate client-handler.test.ts to test via session API**

The `client-handler.test.ts` tests need to work through the session's `handleMessage` function instead of directly instantiating `ClientHandler`. Most of these scenarios are already covered by `session.test.ts` and `fixture-replay.test.tsx`.

Rename `packages/aai-ui/client-handler.test.ts` to `packages/aai-ui/message-handling.test.ts` and rewrite it to use `setupSignalsEnv()`:

```ts
// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, it, vi } from "vitest";
import { flush, setupSignalsEnv } from "./_test-utils.ts";

describe("session message handling", () => {
  describe("handleMessage dispatch", () => {
    it("binary ArrayBuffer dispatches audio chunk", async () => {
      const env = setupSignalsEnv();
      try {
        await env.connect();
        env.send({ type: "config", sampleRate: 16000, ttsSampleRate: 22050 });
        await flush();
        // Send binary data through the mock WebSocket
        const pcm = new ArrayBuffer(320);
        env.mock.lastWs?.simulateMessage(pcm);
        await flush();
        // Binary data triggers speaking state (if not in error)
        expect(env.session.state.value).toBe("speaking");
      } finally {
        env.restore();
      }
    });

    it("malformed JSON returns null silently", async () => {
      const env = setupSignalsEnv();
      try {
        await env.connect();
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        env.mock.lastWs?.simulateMessage("not json{{{");
        await flush();
        // State should remain unchanged (ready from connection)
        expect(env.session.state.value).toBe("ready");
        spy.mockRestore();
      } finally {
        env.restore();
      }
    });

    it("unknown but well-formed message type is silently ignored", async () => {
      const env = setupSignalsEnv();
      try {
        await env.connect();
        env.send({ type: "future_event_type", data: "whatever" });
        await flush();
        expect(env.session.state.value).toBe("ready");
      } finally {
        env.restore();
      }
    });
  });

  describe("event edge cases", () => {
    it("agent_transcript_delta appends to existing agentUtterance", async () => {
      const env = setupSignalsEnv();
      try {
        await env.connect();
        env.send({ type: "agent_transcript_delta", text: "Hello" });
        await flush();
        expect(env.session.agentUtterance.value).toBe("Hello");
        env.send({ type: "agent_transcript_delta", text: "world" });
        await flush();
        expect(env.session.agentUtterance.value).toBe("Hello world");
      } finally {
        env.restore();
      }
    });

    it("agent_transcript clears agentUtterance and adds message", async () => {
      const env = setupSignalsEnv();
      try {
        await env.connect();
        env.send({ type: "agent_transcript_delta", text: "Hello" });
        await flush();
        env.send({ type: "agent_transcript", text: "Hello world" });
        await flush();
        expect(env.session.agentUtterance.value).toBeNull();
        expect(env.session.messages.value).toEqual([
          { role: "assistant", content: "Hello world" },
        ]);
      } finally {
        env.restore();
      }
    });

    it("tool_call adds pending tool call", async () => {
      const env = setupSignalsEnv();
      try {
        await env.connect();
        env.send({
          type: "tool_call",
          toolCallId: "tc1",
          toolName: "web_search",
          args: { query: "test" },
        });
        await flush();
        expect(env.session.toolCalls.value).toHaveLength(1);
        expect(env.session.toolCalls.value[0]).toMatchObject({
          toolCallId: "tc1",
          toolName: "web_search",
          status: "pending",
        });
      } finally {
        env.restore();
      }
    });

    it("tool_call_done updates matching tool call status", async () => {
      const env = setupSignalsEnv();
      try {
        await env.connect();
        env.send({
          type: "tool_call",
          toolCallId: "tc1",
          toolName: "web_search",
          args: { query: "test" },
        });
        await flush();
        env.send({ type: "tool_call_done", toolCallId: "tc1", result: '{"data":"ok"}' });
        await flush();
        expect(env.session.toolCalls.value[0]).toMatchObject({
          status: "done",
          result: '{"data":"ok"}',
        });
      } finally {
        env.restore();
      }
    });

    it("tool_call_done with unknown id is a no-op", async () => {
      const env = setupSignalsEnv();
      try {
        await env.connect();
        env.send({ type: "tool_call_done", toolCallId: "nonexistent", result: "x" });
        await flush();
        expect(env.session.toolCalls.value).toHaveLength(0);
      } finally {
        env.restore();
      }
    });

    it("cancelled clears agentUtterance too", async () => {
      const env = setupSignalsEnv();
      try {
        await env.connect();
        env.send({ type: "agent_transcript_delta", text: "partial" });
        await flush();
        expect(env.session.agentUtterance.value).toBe("partial");
        env.send({ type: "cancelled" });
        await flush();
        expect(env.session.agentUtterance.value).toBeNull();
        expect(env.session.state.value).toBe("listening");
      } finally {
        env.restore();
      }
    });

    it("reset clears toolCalls", async () => {
      const env = setupSignalsEnv();
      try {
        await env.connect();
        env.send({
          type: "tool_call",
          toolCallId: "tc1",
          toolName: "test",
          args: {},
        });
        await flush();
        expect(env.session.toolCalls.value).toHaveLength(1);
        env.send({ type: "reset" });
        await flush();
        expect(env.session.toolCalls.value).toHaveLength(0);
      } finally {
        env.restore();
      }
    });
  });
});
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:aai-ui`
Expected: All tests pass. Some test count may change (old handler tests replaced with new session-level tests).

- [ ] **Step 6: Commit**

```bash
git add -A packages/aai-ui/
git commit -m "refactor(aai-ui): inline ClientHandler into session.ts"
```

---

## Task 3: Merge createSessionControls into createVoiceSession

**Files:**
- Modify: `packages/aai-ui/session.ts`
- Modify: `packages/aai-ui/_test-utils.ts`

- [ ] **Step 1: Add started/running/start/toggle to VoiceSession type and factory**

In `packages/aai-ui/session.ts`, update the `VoiceSession` type to add new fields:

```ts
export type VoiceSession = {
  readonly state: Signal<AgentState>;
  readonly messages: Signal<ChatMessage[]>;
  readonly toolCalls: Signal<ToolCallInfo[]>;
  readonly userUtterance: Signal<string | null>;
  readonly agentUtterance: Signal<string | null>;
  readonly error: Signal<SessionError | null>;
  readonly disconnected: Signal<{ intentional: boolean } | null>;
  /** Whether the session has been started by the user. */
  readonly started: Signal<boolean>;
  /** Whether the session is currently running (connected or connecting). */
  readonly running: Signal<boolean>;
  connect(options?: { signal?: AbortSignal }): void;
  cancel(): void;
  resetState(): void;
  reset(): void;
  disconnect(): void;
  /** Start the session for the first time (sets started and running). */
  start(): void;
  /** Toggle between connected and disconnected states. */
  toggle(): void;
  [Symbol.dispose](): void;
};
```

In `createVoiceSession`, add the new signals and methods. Add import for `effect`:

```ts
import { batch, effect, type Signal, signal } from "@preact/signals";
```

After the existing signal declarations, add:

```ts
  const started = signal(false);
  const running = signal(true);

  // Track error state to auto-clear running
  const disposeEffect = effect(() => {
    if (state.value === "error") running.value = false;
  });
```

Update the `disconnect()` function to also dispose the effect:

```ts
  function disconnect(): void {
    connectionController?.abort();
    connectionController = null;
    cleanupAudio();
    conn.ws?.close();
    conn.ws = null;
    state.value = "disconnected";
    disconnected.value = { intentional: true };
  }
```

Add `start()` and `toggle()` functions:

```ts
  function start(): void {
    batch(() => {
      started.value = true;
      running.value = true;
    });
    connect();
  }

  function toggle(): void {
    if (running.value) {
      cancel();
      disconnect();
    } else {
      connect();
    }
    running.value = !running.value;
  }
```

Add the new fields to the return object:

```ts
  return {
    state,
    messages,
    toolCalls,
    userUtterance,
    agentUtterance,
    error,
    disconnected,
    started,
    running,
    connect,
    cancel,
    resetState,
    reset,
    disconnect,
    start,
    toggle,
    [Symbol.dispose]() {
      disposeEffect();
      disconnect();
    },
  };
```

- [ ] **Step 2: Update _test-utils.ts**

In `packages/aai-ui/_test-utils.ts`:

Remove the `createSessionControls` import and `SessionSignals` import:
```ts
// DELETE:
import { createSessionControls, type SessionSignals } from "./signals.ts";
```

Update `setupSignalsEnv` to no longer create separate signals:
```ts
export function setupSignalsEnv() {
  const mock = installMockWebSocket();
  const loc = installMockLocation();
  const session = createVoiceSession({
    platformUrl: "http://localhost:3000",
    WebSocket: globalThis.WebSocket,
  });

  return {
    mock,
    session,
    async connect() {
      session.connect();
      await flush();
    },
    send(msg: Record<string, unknown>) {
      mock.lastWs?.simulateMessage(JSON.stringify(msg));
    },
    restore() {
      mock.restore();
      loc.restore();
    },
  };
}
```

Update `createMockSignals` to return a mock `VoiceSession` directly (no `SessionSignals` wrapper):
```ts
export function createMockSession(
  overrides?: Partial<{
    state: AgentState;
    messages: ChatMessage[];
    userUtterance: string | null;
    error: SessionError | null;
    started: boolean;
    running: boolean;
  }>,
): VoiceSession {
  const session = {
    state: signal<AgentState>(overrides?.state ?? "disconnected"),
    messages: signal<ChatMessage[]>(overrides?.messages ?? []),
    toolCalls: signal<ToolCallInfo[]>([]),
    userUtterance: signal<string | null>(overrides?.userUtterance ?? null),
    agentUtterance: signal<string | null>(null),
    error: signal<SessionError | null>(overrides?.error ?? null),
    disconnected: signal<{ intentional: boolean } | null>(null),
    started: signal<boolean>(overrides?.started ?? false),
    running: signal<boolean>(overrides?.running ?? true),
    connect() { /* noop */ },
    cancel() { /* noop */ },
    resetState() { /* noop */ },
    reset() { /* noop */ },
    disconnect() { /* noop */ },
    start() {
      session.started.value = true;
      session.running.value = true;
    },
    toggle() {
      session.running.value = !session.running.value;
    },
    [Symbol.dispose]() { /* noop */ },
  } satisfies VoiceSession;

  return session;
}
```

Remove the old `createMockSignals` function entirely.

- [ ] **Step 3: Run tests to see what breaks**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:aai-ui`
Expected: Tests that import `createSessionControls` or `SessionSignals` from `signals.ts` will fail. Tests using `createMockSignals` will fail. Fix these in the next steps.

- [ ] **Step 4: Update signals.test.tsx**

In `packages/aai-ui/signals.test.tsx`, update the `createSessionControls` tests to test the new integrated session:

Replace imports:
```ts
import { flush, installMockWebSocket, setupSignalsEnv } from "./_test-utils.ts";
```

Replace the `createSessionControls` describe block to test the integrated session:
```ts
describe("VoiceSession controls", () => {
  it("has correct defaults", () => {
    const env = setupSignalsEnv();
    try {
      expect(env.session.started.value).toBe(false);
      expect(env.session.running.value).toBe(true);
    } finally {
      env.restore();
    }
  });

  it("sets running to false on error state", async () => {
    const env = setupSignalsEnv();
    try {
      await env.connect();
      env.send({ type: "error", code: "agent", message: "fail" });
      await flush();
      expect(env.session.running.value).toBe(false);
    } finally {
      env.restore();
    }
  });

  it("start() sets started/running and connects", async () => {
    const env = setupSignalsEnv();
    try {
      env.session.start();
      await flush();
      expect(env.session.started.value).toBe(true);
      expect(env.session.running.value).toBe(true);
    } finally {
      env.restore();
    }
  });

  it("toggle() disconnects then reconnects", async () => {
    const env = setupSignalsEnv();
    try {
      await env.connect();
      env.session.toggle();
      await flush();
      expect(env.session.running.value).toBe(false);
      env.session.toggle();
      await flush();
      expect(env.session.running.value).toBe(true);
    } finally {
      env.restore();
    }
  });

  it("reset() sends reset message", async () => {
    const env = setupSignalsEnv();
    try {
      await env.connect();
      env.session.reset();
      await flush();
      // reset on open socket sends a "reset" message
      const sent = env.mock.lastWs?.sent ?? [];
      const last = sent.at(-1);
      expect(typeof last === "string" ? JSON.parse(last) : null).toMatchObject({
        type: "reset",
      });
    } finally {
      env.restore();
    }
  });
});
```

- [ ] **Step 5: Update all test files that use createMockSignals**

Search all test files for `createMockSignals` and replace with `createMockSession`. The key difference: tests that destructured `signals.session.X` now access `session.X` directly, and `signals.started`/`signals.running` become `session.started`/`session.running`.

Update imports across test files:
```ts
// OLD:
import { createMockSignals } from "./_test-utils.ts";
// NEW:
import { createMockSession } from "./_test-utils.ts";
```

In component tests, update SessionProvider usage:
```ts
// OLD:
const signals = createMockSignals({ started: true, running: true });
<SessionProvider value={signals}>
// NEW:
const session = createMockSession({ started: true, running: true });
<SessionProvider value={session}>
```

- [ ] **Step 6: Run tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:aai-ui`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A packages/aai-ui/
git commit -m "refactor(aai-ui): merge createSessionControls into createVoiceSession"
```

---

## Task 4: Extract context.ts and hooks.ts, delete signals.ts and client-context.ts

**Files:**
- Create: `packages/aai-ui/context.ts`
- Create: `packages/aai-ui/hooks.ts`
- Delete: `packages/aai-ui/signals.ts`
- Delete: `packages/aai-ui/client-context.ts`
- Modify: `packages/aai-ui/_test-utils.ts` (if needed)

- [ ] **Step 1: Create context.ts**

Create `packages/aai-ui/context.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.

import type { ComponentChildren, JSX } from "preact";
import { createContext, h } from "preact";
import { useContext } from "preact/hooks";
import type { VoiceSession } from "./session.ts";

// ─── Session context ─────────────────────────────────────────────────────────

const SessionCtx = createContext<VoiceSession | null>(null);

/**
 * Preact context provider that makes a VoiceSession available to descendant
 * components via {@link useSession}.
 *
 * @public
 */
export function SessionProvider({
  value,
  children,
}: {
  value: VoiceSession;
  children?: ComponentChildren;
}): JSX.Element {
  return h(SessionCtx.Provider, { value }, children);
}

/**
 * Hook to access the VoiceSession from the nearest SessionProvider.
 *
 * @returns The VoiceSession from the nearest provider.
 * @throws If called outside of a SessionProvider.
 *
 * @public
 */
export function useSession(): VoiceSession {
  const ctx = useContext(SessionCtx);
  if (!ctx) throw new Error("Hook useSession() requires a SessionProvider");
  return ctx;
}

// ─── Client config context ───────────────────────────────────────────────────

/**
 * Theme overrides for the default UI. Applied as CSS custom properties.
 * @public
 */
export type ClientTheme = {
  bg?: string;
  primary?: string;
  text?: string;
  surface?: string;
  border?: string;
};

/**
 * Resolved client-level configuration available to default UI components.
 * @public
 */
export type ClientConfig = {
  title?: string | undefined;
  theme?: ClientTheme | undefined;
};

const ConfigCtx = createContext<ClientConfig>({});

export const ClientConfigProvider = ConfigCtx.Provider;

/**
 * Read client config (title, theme) from the nearest provider.
 * @public
 */
export function useClientConfig(): ClientConfig {
  return useContext(ConfigCtx);
}
```

- [ ] **Step 2: Create hooks.ts**

Create `packages/aai-ui/hooks.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.

import { effect, useSignalEffect } from "@preact/signals";
import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSession } from "./context.ts";
import type { ToolCallInfo } from "./types.ts";

function tryParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function isNewCompletedCall(
  tc: ToolCallInfo,
  seen: Set<string>,
  filterName: string | undefined,
): tc is ToolCallInfo & { result: string } {
  if (tc.status !== "done" || !tc.result) return false;
  if (seen.has(tc.toolCallId)) return false;
  if (filterName && tc.toolName !== filterName) return false;
  return true;
}

function useToolCallEffect(
  session: import("./session.ts").VoiceSession,
  shouldProcess: (tc: ToolCallInfo, seen: Set<string>) => boolean,
  onNew: (tc: ToolCallInfo) => void,
): void {
  const seenRef = useRef(new Set<string>());
  const cbRef = useRef(onNew);
  cbRef.current = onNew;
  const predicateRef = useRef(shouldProcess);
  predicateRef.current = shouldProcess;

  useEffect(
    () =>
      effect(() => {
        const toolCalls = session.toolCalls.value;
        if (toolCalls.length === 0) {
          seenRef.current.clear();
          return;
        }
        for (const tc of toolCalls) {
          if (!predicateRef.current(tc, seenRef.current)) continue;
          if (seenRef.current.has(tc.toolCallId)) continue;
          seenRef.current.add(tc.toolCallId);
          cbRef.current(tc);
        }
      }),
    [session],
  );
}

/**
 * Hook that fires a callback exactly once for each newly completed tool call.
 * @public
 */
export function useToolResult<R = unknown>(
  toolName: string,
  callback: (result: R, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult(
  callback: (toolName: string, result: unknown, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult<R = unknown>(
  toolNameOrCallback:
    | string
    | ((toolName: string, result: unknown, toolCall: ToolCallInfo) => void),
  maybeCallback?: (result: R, toolCall: ToolCallInfo) => void,
): void {
  const filterName = typeof toolNameOrCallback === "string" ? toolNameOrCallback : undefined;
  const callback =
    typeof toolNameOrCallback === "function"
      ? toolNameOrCallback
      : (_name: string, result: unknown, tc: ToolCallInfo) => maybeCallback?.(result as R, tc);

  const session = useSession();

  useToolCallEffect(
    session,
    (tc, seen) => isNewCompletedCall(tc, seen, filterName),
    (tc) =>
      callback(tc.toolName, tryParseJSON((tc as ToolCallInfo & { result: string }).result), tc),
  );
}

/**
 * Hook that fires a callback when a new tool call starts (status: "pending").
 * @public
 */
export function useToolCallStart(
  callback: (toolName: string, args: Record<string, unknown>, toolCall: ToolCallInfo) => void,
): void {
  const session = useSession();

  useToolCallEffect(
    session,
    () => true,
    (tc) => callback(tc.toolName, tc.args, tc),
  );
}

/**
 * Auto-scroll a container to the bottom when messages, tool calls,
 * or utterances change.
 * @public
 */
export function useAutoScroll(): RefObject<HTMLDivElement> {
  const session = useSession();
  const ref = useRef<HTMLDivElement>(null);

  useSignalEffect(() => {
    // biome-ignore lint/suspicious/noUnusedExpressions: signal subscription
    session.messages.value;
    // biome-ignore lint/suspicious/noUnusedExpressions: signal subscription
    session.toolCalls.value;
    // biome-ignore lint/suspicious/noUnusedExpressions: signal subscription
    session.userUtterance.value;
    // biome-ignore lint/suspicious/noUnusedExpressions: signal subscription
    session.agentUtterance.value;
    ref.current?.scrollIntoView({ behavior: "smooth" });
  });

  return ref;
}
```

- [ ] **Step 3: Delete signals.ts and client-context.ts**

```bash
rm packages/aai-ui/signals.ts packages/aai-ui/client-context.ts
```

- [ ] **Step 4: Update all imports across the package**

Every file that imported from `./signals.ts` or `./client-context.ts` needs updating:

For `./signals.ts` imports:
- `SessionProvider`, `useSession` → import from `./context.ts`
- `useToolResult`, `useToolCallStart`, `useAutoScroll` → import from `./hooks.ts`
- `createSessionControls`, `SessionSignals` → deleted, no longer needed

For `./client-context.ts` imports:
- `ClientConfigProvider`, `useClientConfig`, `ClientTheme`, `ClientConfig` → import from `./context.ts`

Files to update:
- `define-client.tsx` — imports from both signals.ts and client-context.ts
- `components/app.tsx` — imports `useClientConfig`
- `components/chat-view.tsx` — imports `useSession`, `useClientConfig`
- `components/controls.tsx` — imports `useSession`
- `components/message-list.tsx` — imports `useAutoScroll`, `useSession`
- `components/start-screen.tsx` — imports `useSession`
- `_test-utils.ts` — remove `signals.ts` imports
- All test files that import from `./signals.ts`

- [ ] **Step 5: Run tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:aai-ui`
Expected: All tests pass. Also check: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm typecheck --filter @alexkroman1/aai-ui`

- [ ] **Step 6: Commit**

```bash
git add -A packages/aai-ui/
git commit -m "refactor(aai-ui): extract context.ts and hooks.ts, delete signals.ts and client-context.ts"
```

---

## Task 5: Simplify define-client.tsx

**Files:**
- Modify: `packages/aai-ui/define-client.tsx`

- [ ] **Step 1: Update define-client.tsx to use createVoiceSession directly**

The file no longer needs to pass `reactiveFactory` or `batch`, and no longer wraps in `createSessionControls`:

```ts
// Copyright 2025 the AAI authors. MIT license.

import type { ComponentType } from "preact";
// biome-ignore lint/suspicious/noDeprecatedImports: preact v10 render API is current
import { render } from "preact";
import { ClientConfigProvider, type ClientTheme } from "./context.ts";
import { createVoiceSession, type VoiceSession, type WebSocketConstructor } from "./session.ts";
import { SessionProvider } from "./context.ts";

/**
 * Options for {@link defineClient}.
 * @public
 */
export type ClientOptions = {
  target?: string | HTMLElement;
  platformUrl?: string;
  title?: string;
  theme?: ClientTheme;
  onSessionId?: ((sessionId: string) => void) | undefined;
  resumeSessionId?: string | undefined;
  WebSocket?: WebSocketConstructor | undefined;
};

/**
 * Handle returned by {@link defineClient} for cleanup.
 * @public
 */
export type ClientHandle = {
  session: VoiceSession;
  dispose(): void;
  [Symbol.dispose](): void;
};

function resolveContainer(target: string | HTMLElement = "#app"): HTMLElement {
  if (typeof target !== "string") return target;
  const el = document.querySelector<HTMLElement>(target);
  if (!el) throw new Error(`Element not found: ${target}`);
  return el;
}

/**
 * Define and mount a client UI for a voice agent.
 * @public
 */
// biome-ignore lint/suspicious/noExplicitAny: defineClient accepts any component
export function defineClient(Component: ComponentType<any>, options?: ClientOptions): ClientHandle {
  const container = resolveContainer(options?.target);

  const platformUrl =
    options?.platformUrl ?? globalThis.location.origin + globalThis.location.pathname;
  const session = createVoiceSession({
    platformUrl,
    onSessionId: options?.onSessionId,
    resumeSessionId: options?.resumeSessionId,
    ...(options?.WebSocket ? { WebSocket: options.WebSocket } : {}),
  });

  const clientConfig = { title: options?.title, theme: options?.theme };

  if (options?.theme) {
    const t = options.theme;
    const el = container;
    if (t.bg) el.style.setProperty("--color-aai-bg", t.bg);
    if (t.primary) el.style.setProperty("--color-aai-primary", t.primary);
    if (t.text) el.style.setProperty("--color-aai-text", t.text);
    if (t.surface) el.style.setProperty("--color-aai-surface", t.surface);
    if (t.border) el.style.setProperty("--color-aai-border", t.border);
  }

  render(
    <ClientConfigProvider value={clientConfig}>
      <SessionProvider value={session}>
        <Component />
      </SessionProvider>
    </ClientConfigProvider>,
    container,
  );

  const handle: ClientHandle = {
    session,
    dispose() {
      render(null, container);
      session.disconnect();
    },
    [Symbol.dispose]() {
      handle.dispose();
    },
  };
  return handle;
}
```

Note: `ClientHandle` no longer has a `signals` field — it just has `session` directly.

- [ ] **Step 2: Run tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:aai-ui`
Expected: `define-client.test.tsx` may need updates if it references `handle.signals`.

- [ ] **Step 3: Update define-client.test.tsx if needed**

Replace any `handle.signals.X` references with `handle.session.X`.

- [ ] **Step 4: Commit**

```bash
git add packages/aai-ui/define-client.tsx packages/aai-ui/define-client.test.tsx
git commit -m "refactor(aai-ui): simplify define-client to use VoiceSession directly"
```

---

## Task 6: Simplify audio double-buffer

**Files:**
- Modify: `packages/aai-ui/audio.ts`

- [ ] **Step 1: Replace double-buffer with simple accumulator**

In `packages/aai-ui/audio.ts`, replace the double-buffer logic (lines ~98-121) with:

```ts
  const chunkSizeBytes = Math.floor(sttSampleRate * MIC_BUFFER_SECONDS) * 2;
  let capBuf = new Uint8Array(chunkSizeBytes * 2);
  let capOffset = 0;

  capNode.port.postMessage({ event: "start" });

  capNode.port.onmessage = (e: MessageEvent) => {
    if (e.data.event !== "chunk") return;
    const chunk = new Uint8Array(e.data.buffer as ArrayBufferLike);

    capBuf.set(chunk, capOffset);
    capOffset += chunk.byteLength;

    if (capOffset >= chunkSizeBytes) {
      onMicData(capBuf.buffer.slice(0, capOffset));
      capBuf = new Uint8Array(chunkSizeBytes * 2);
      capOffset = 0;
    }
  };
```

This removes the `capBufA`/`capBufB` swap and the comment about double-buffering.

- [ ] **Step 2: Run tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:aai-ui`
Expected: All audio tests pass. The buffer tests in `audio.test.ts` test the callback behavior, not the internal buffer implementation.

- [ ] **Step 3: Commit**

```bash
git add packages/aai-ui/audio.ts
git commit -m "refactor(aai-ui): simplify mic capture buffer (remove double-buffer swap)"
```

---

## Task 7: Inline micro-components into parents

**Files:**
- Modify: `packages/aai-ui/components/chat-view.tsx`
- Modify: `packages/aai-ui/components/message-list.tsx`
- Delete: `packages/aai-ui/components/thinking-indicator.tsx`
- Delete: `packages/aai-ui/components/transcript.tsx`
- Delete: `packages/aai-ui/components/error-banner.tsx`
- Delete: `packages/aai-ui/components/state-indicator.tsx`
- Delete: `packages/aai-ui/components/message-bubble.tsx`
- Delete: `packages/aai-ui/components/thinking-indicator.test.tsx` (if exists)

- [ ] **Step 1: Inline error-banner and state-indicator into chat-view.tsx**

Add `icon` prop to `ChatView`. Replace `packages/aai-ui/components/chat-view.tsx`:

```tsx
// Copyright 2025 the AAI authors. MIT license.

import clsx from "clsx";
import type { ComponentChildren } from "preact";
import type * as preact from "preact";
import { useClientConfig } from "../context.ts";
import { useSession } from "../context.ts";
import { Controls } from "./controls.tsx";
import { MessageList } from "./message-list.tsx";

const DOT_STATE_CLASSES =
  "data-[state=disconnected]:bg-aai-state-disconnected data-[state=connecting]:bg-aai-state-connecting data-[state=ready]:bg-aai-state-ready data-[state=listening]:bg-aai-state-listening data-[state=thinking]:bg-aai-state-thinking data-[state=speaking]:bg-aai-state-speaking data-[state=error]:bg-aai-state-error";

/**
 * The main chat interface for a voice agent session.
 *
 * @param icon - Optional icon element rendered in the header before the title.
 * @param className - Additional CSS class names applied to the root element.
 *
 * @public
 */
export function ChatView({
  icon,
  className,
}: {
  icon?: ComponentChildren;
  className?: string;
}): preact.JSX.Element {
  const session = useSession();
  const { title } = useClientConfig();

  return (
    <div
      class={clsx(
        "flex flex-col h-screen max-w-130 mx-auto bg-aai-bg text-aai-text font-aai text-sm",
        className,
      )}
    >
      {/* Header */}
      <div class="flex items-center gap-3 px-4 py-3 border-b border-aai-border shrink-0">
        {icon}
        {title ? (
          <span class="text-sm font-semibold text-aai-primary">{title}</span>
        ) : (
          !icon && (
            <pre class="font-aai-mono text-[10px] leading-[1.1] font-bold text-aai-primary m-0">
              {/* biome-ignore lint/style/useConsistentCurlyBraces: string contains escape sequence */}
              {"▄▀█ ▄▀█ █\n█▀█ █▀█ █"}
            </pre>
          )
        )}
        <div class="ml-auto">
          {/* Inlined StateIndicator */}
          <div class="inline-flex items-center justify-center gap-1.5 text-[13px] font-medium leading-[130%] text-aai-text-muted capitalize">
            <div
              data-state={session.state.value}
              class={clsx("w-2 h-2 rounded-full", DOT_STATE_CLASSES)}
            />
            {session.state.value}
          </div>
        </div>
      </div>
      {/* Inlined ErrorBanner */}
      {session.error.value && (
        <div class="mx-4 mt-3 px-3 py-2 rounded-aai border border-aai-error/40 bg-aai-error/8 text-[13px] leading-[130%] text-aai-error">
          {session.error.value.message}
        </div>
      )}
      <MessageList />
      <Controls />
    </div>
  );
}
```

- [ ] **Step 2: Inline message-bubble, transcript, and thinking-indicator into message-list.tsx**

Replace `packages/aai-ui/components/message-list.tsx`:

```tsx
// Copyright 2025 the AAI authors. MIT license.

import { useComputed } from "@preact/signals";
import clsx from "clsx";
import type { VNode } from "preact";
import { useAutoScroll } from "../hooks.ts";
import { useSession } from "../context.ts";
import type { ChatMessage } from "../types.ts";

const BOUNCE_STYLES: Record<string, string>[] = [0, 0.16, 0.32].map((delay) => ({
  animation: "aai-bounce 1.4s infinite ease-in-out both",
  animationDelay: `${delay}s`,
}));

function ThinkingDots({ className }: { className?: string }) {
  return (
    <div
      class={clsx(
        "flex items-center gap-2 text-aai-text-dim text-sm font-medium min-h-5",
        className,
      )}
    >
      {BOUNCE_STYLES.map((style, i) => (
        <div key={i} class="w-1.5 h-1.5 rounded-full bg-aai-text-dim" style={style} />
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  if (isUser) {
    return (
      <div class="flex flex-col w-full items-end">
        <div class="max-w-[min(82%,64ch)] bg-aai-surface-faint border border-aai-border px-3 py-2 rounded-aai whitespace-pre-wrap wrap-break-word text-sm font-normal leading-[150%] text-aai-text">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div class="whitespace-pre-wrap wrap-break-word text-sm font-normal leading-[150%] text-aai-text">
      {message.content}
    </div>
  );
}

/**
 * Scrollable list of all chat messages, tool-call blocks, live transcript,
 * streaming agent utterance, and a thinking indicator.
 *
 * @public
 */
export function MessageList({ className }: { className?: string }) {
  const session = useSession();
  const scrollRef = useAutoScroll();

  const showThinking = useComputed(() => {
    if (session.state.value !== "thinking") return false;
    const last = session.toolCalls.value.at(-1);
    if (last?.status === "pending") return false;
    const lastMsg = session.messages.value.at(-1);
    return !lastMsg || lastMsg.role === "user" || Boolean(last);
  });

  const messages = session.messages.value;
  const toolCalls = session.toolCalls.value;

  const items: VNode[] = [];
  let tci = 0;
  for (const [i, msg] of messages.entries()) {
    items.push(<MessageBubble key={`msg-${i}`} message={msg} />);
    let tc = toolCalls[tci];
    while (tc && tc.afterMessageIndex <= i) {
      items.push(<ToolCallBlock key={tc.toolCallId} toolCall={tc} />);
      tci++;
      tc = toolCalls[tci];
    }
  }
  let tc = toolCalls[tci];
  while (tc) {
    items.push(<ToolCallBlock key={tc.toolCallId} toolCall={tc} />);
    tci++;
    tc = toolCalls[tci];
  }

  return (
    <div
      role="log"
      class={clsx("flex-1 overflow-y-auto [scrollbar-width:none] bg-aai-surface", className)}
    >
      <div class="flex flex-col gap-4.5 p-4">
        {items}
        {session.agentUtterance.value && (
          <MessageBubble message={{ role: "assistant", content: session.agentUtterance.value }} />
        )}
        {/* Inlined Transcript */}
        {session.userUtterance.value !== null && (
          <div class="flex flex-col items-end w-full">
            <div class="max-w-[min(82%,64ch)] whitespace-pre-wrap wrap-break-word text-sm leading-[150%] text-aai-text-muted bg-aai-surface-faint border border-aai-border px-3 py-2 rounded-aai ml-auto">
              {session.userUtterance.value || <ThinkingDots />}
            </div>
          </div>
        )}
        {showThinking.value && <ThinkingDots />}
        <div ref={scrollRef} />
      </div>
    </div>
  );
}
```

Wait — the above has a bug. `message-list.tsx` imports `ToolCallBlock` as a component, which is still a separate file. Remove the fake `await_imports()` and keep the direct import:

```tsx
import { ToolCallBlock } from "./tool-call-block.tsx";
```

The `ToolCallBlock` import stays — it's a kept component.

- [ ] **Step 3: Delete inlined component files and their tests**

```bash
rm packages/aai-ui/components/thinking-indicator.tsx
rm packages/aai-ui/components/transcript.tsx
rm packages/aai-ui/components/error-banner.tsx
rm packages/aai-ui/components/state-indicator.tsx
rm packages/aai-ui/components/message-bubble.tsx
rm -f packages/aai-ui/components/thinking-indicator.test.tsx
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:aai-ui`
Expected: Some component tests may break if they import deleted components. Fix by removing those tests or updating them.

- [ ] **Step 5: Fix any broken test imports**

Remove or update test files that imported deleted components. Tests for the inlined behavior are now covered through `chat-view` and `message-list` integration tests in `fixture-replay.test.tsx`.

- [ ] **Step 6: Commit**

```bash
git add -A packages/aai-ui/
git commit -m "refactor(aai-ui): inline micro-components into parents, add icon prop to ChatView"
```

---

## Task 8: Update index.ts exports

**Files:**
- Modify: `packages/aai-ui/index.ts`
- Modify: `packages/aai-ui/package.json`

- [ ] **Step 1: Rewrite index.ts with the new export surface**

Replace `packages/aai-ui/index.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Browser client library for AAI voice agents.
 *
 * Provides WebSocket session management, audio capture/playback,
 * and Preact UI components.
 *
 * @example
 * ```tsx
 * import { App, defineClient } from "@alexkroman1/aai-ui";
 *
 * defineClient(App, { target: "#app" });
 * ```
 */

// Context
export type { ClientConfig, ClientTheme } from "./context.ts";
export { ClientConfigProvider, SessionProvider, useClientConfig, useSession } from "./context.ts";

// Components
export { App } from "./components/app.tsx";
export { Button } from "./components/button.tsx";
export { ChatView } from "./components/chat-view.tsx";
export { Controls } from "./components/controls.tsx";
export { MessageList } from "./components/message-list.tsx";
export { SidebarLayout } from "./components/sidebar-layout.tsx";
export { StartScreen } from "./components/start-screen.tsx";
export { ToolCallBlock } from "./components/tool-call-block.tsx";

// Hooks
export { useAutoScroll, useToolCallStart, useToolResult } from "./hooks.ts";

// Session
export type { ClientHandle, ClientOptions } from "./define-client.tsx";
export { defineClient } from "./define-client.tsx";
export type { VoiceSession, VoiceSessionOptions } from "./session.ts";
export { createVoiceSession } from "./session.ts";

// Types
export type {
  AgentState,
  ChatMessage,
  SessionError,
  SessionErrorCode,
  ToolCallInfo,
} from "./types.ts";
```

- [ ] **Step 2: Remove ./session subpath from package.json**

In `packages/aai-ui/package.json`, remove the `./session` export entry:

```json
  "exports": {
    ".": {
      "@dev/source": "./index.ts",
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./styles.css": "./styles.css"
  },
```

Also update the `check:attw` script to remove the `./session` entrypoint:
```json
    "check:attw": "attw --pack --profile esm-only --entrypoints ."
```

- [ ] **Step 3: Update published-exports.test.ts**

Update the expected public symbols in `packages/aai-ui/published-exports.test.ts`:

```ts
  it("main entry (.) exports expected public symbols", async () => {
    const mod = await import(resolve(PKG_DIR, "index.ts"));

    const expectedValues = [
      "App",
      "Button",
      "defineClient",
      "createVoiceSession",
      "SessionProvider",
      "useSession",
      "useToolResult",
      "useToolCallStart",
      "useAutoScroll",
      "useClientConfig",
      "ChatView",
      "Controls",
      "MessageList",
      "SidebarLayout",
      "StartScreen",
      "ToolCallBlock",
      "ClientConfigProvider",
    ];
    for (const name of expectedValues) {
      expect(mod, `Missing value export: ${name}`).toHaveProperty(name);
    }

    // Verify removed exports are gone
    const removedExports = [
      "createSessionControls",
      "ErrorBanner",
      "StateIndicator",
      "ThinkingIndicator",
      "Transcript",
      "MessageBubble",
    ];
    for (const name of removedExports) {
      expect(mod, `Should not export: ${name}`).not.toHaveProperty(name);
    }
  });
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:aai-ui`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/aai-ui/index.ts packages/aai-ui/package.json packages/aai-ui/published-exports.test.ts
git commit -m "refactor(aai-ui): update exports, remove ./session subpath"
```

---

## Task 9: Update type-level tests

**Files:**
- Modify: `packages/aai-ui/types.test-d.ts`

- [ ] **Step 1: Update type tests for new VoiceSession shape**

Replace `packages/aai-ui/types.test-d.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Type-level tests for the public API surface of @alexkroman1/aai-ui.
 */

// biome-ignore lint/correctness/noUndeclaredDependencies: vitest is a root workspace devDependency
import { describe, expectTypeOf, it } from "vitest";
import type { Signal } from "@preact/signals";
import type {
  AgentState,
  ChatMessage,
  SessionError,
  SessionErrorCode,
  ToolCallInfo,
  VoiceSession,
  VoiceSessionOptions,
} from "./index.ts";
import { createVoiceSession } from "./index.ts";

describe("createVoiceSession", () => {
  it("accepts VoiceSessionOptions and returns VoiceSession", () => {
    const session = createVoiceSession({ platformUrl: "ws://localhost:3000" });
    expectTypeOf(session).toMatchTypeOf<VoiceSession>();
  });

  it("requires platformUrl", () => {
    // @ts-expect-error — platformUrl is required
    createVoiceSession({});
  });

  it("accepts VoiceSessionOptions shape", () => {
    expectTypeOf<VoiceSessionOptions>().toHaveProperty("platformUrl");
    expectTypeOf<VoiceSessionOptions["platformUrl"]>().toEqualTypeOf<string>();
  });

  it("does not accept reactiveFactory or batch", () => {
    expectTypeOf<VoiceSessionOptions>().not.toHaveProperty("reactiveFactory");
    expectTypeOf<VoiceSessionOptions>().not.toHaveProperty("batch");
  });
});

describe("VoiceSession", () => {
  it("has Signal-typed state", () => {
    expectTypeOf<VoiceSession["state"]>().toEqualTypeOf<Signal<AgentState>>();
    expectTypeOf<VoiceSession["messages"]>().toEqualTypeOf<Signal<ChatMessage[]>>();
    expectTypeOf<VoiceSession["toolCalls"]>().toEqualTypeOf<Signal<ToolCallInfo[]>>();
    expectTypeOf<VoiceSession["error"]>().toEqualTypeOf<Signal<SessionError | null>>();
  });

  it("has started and running signals", () => {
    expectTypeOf<VoiceSession["started"]>().toEqualTypeOf<Signal<boolean>>();
    expectTypeOf<VoiceSession["running"]>().toEqualTypeOf<Signal<boolean>>();
  });

  it("has lifecycle methods", () => {
    expectTypeOf<VoiceSession["connect"]>().toMatchTypeOf<
      (options?: { signal?: AbortSignal }) => void
    >();
    expectTypeOf<VoiceSession["disconnect"]>().toEqualTypeOf<() => void>();
    expectTypeOf<VoiceSession["cancel"]>().toEqualTypeOf<() => void>();
    expectTypeOf<VoiceSession["reset"]>().toEqualTypeOf<() => void>();
    expectTypeOf<VoiceSession["start"]>().toEqualTypeOf<() => void>();
    expectTypeOf<VoiceSession["toggle"]>().toEqualTypeOf<() => void>();
  });
});

describe("exported types", () => {
  it("AgentState is a union of known states", () => {
    expectTypeOf<AgentState>().toEqualTypeOf<
      "disconnected" | "connecting" | "ready" | "listening" | "thinking" | "speaking" | "error"
    >();
  });

  it("ChatMessage has expected shape", () => {
    expectTypeOf<ChatMessage>().toEqualTypeOf<{
      role: "user" | "assistant";
      content: string;
    }>();
  });

  it("ToolCallInfo has expected shape", () => {
    expectTypeOf<ToolCallInfo>().toEqualTypeOf<{
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      status: "pending" | "done";
      result?: string | undefined;
      afterMessageIndex: number;
    }>();
  });

  it("SessionError has expected shape", () => {
    expectTypeOf<SessionError>().toEqualTypeOf<{
      readonly code: SessionErrorCode;
      readonly message: string;
    }>();
  });
});
```

- [ ] **Step 2: Run type tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm vitest run --project aai-ui-types`
Expected: All type-level tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/aai-ui/types.test-d.ts
git commit -m "refactor(aai-ui): update type-level tests for new VoiceSession shape"
```

---

## Task 10: Update templates

**Files:**
- Modify: `packages/aai-templates/templates/night-owl/client.tsx`
- Modify: `packages/aai-templates/templates/pizza-ordering/client.tsx`
- Modify: `packages/aai-templates/templates/infocom-adventure/client.tsx`
- Modify: `packages/aai-templates/templates/dispatch-center/client.tsx`

- [ ] **Step 1: Update night-owl template**

In `packages/aai-templates/templates/night-owl/client.tsx`:

Update imports — remove `ErrorBanner`, `StateIndicator`, `ThinkingIndicator`:
```ts
import {
  Button,
  ChatView,
  Controls,
  defineClient,
  MessageList,
  SidebarLayout,
  StartScreen,
  useClientConfig,
  useSession,
  useToolCallStart,
  useToolResult,
} from "@alexkroman1/aai-ui";
```

Replace the `ChatPanel` component with `ChatView` using the `icon` prop. In the `NightOwl` component, replace:
```tsx
<ChatPanel />
```
with:
```tsx
<ChatView icon={<span class="text-lg">{"\u{1F989}"}</span>} />
```

Delete the entire `ChatPanel` function.

For the `ThinkingIndicator` usage in `RecSidebar`, replace with inline dots:
```tsx
{loading && (
  <div class="flex justify-center py-4">
    <div class="flex items-center gap-2">
      {[0, 0.16, 0.32].map((delay, i) => (
        <div
          key={i}
          class="w-1.5 h-1.5 rounded-full bg-aai-text-dim"
          style={{
            animation: "aai-bounce 1.4s infinite ease-in-out both",
            animationDelay: `${delay}s`,
          }}
        />
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 2: Update pizza-ordering template**

In `packages/aai-templates/templates/pizza-ordering/client.tsx`:

The `useSession()` return shape changes. Update:
```ts
// OLD:
const { session, running, toggle, reset } = useSession();
// NEW:
const session = useSession();
```

Then update references:
- `running.value` → `session.running.value`
- `toggle` → `session.toggle`
- `reset()` → `session.reset()`
- `session.cancel()` stays the same
- `session.resetState()` stays the same

- [ ] **Step 3: Update infocom-adventure template**

In `packages/aai-templates/templates/infocom-adventure/client.tsx`:

Update `useSession()` usage:
```ts
// OLD:
const { session } = useSession();
// NEW (if destructured):
const session = useSession();
```

Remove the extra destructuring layer — access signals directly on session.

- [ ] **Step 4: Update dispatch-center template**

Same pattern as infocom-adventure — update `useSession()` return shape.

- [ ] **Step 5: Run template tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:templates`
Expected: All template tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/aai-templates/
git commit -m "refactor(aai-templates): update templates for new aai-ui API"
```

---

## Task 11: Update scaffold/CLAUDE.md

**Files:**
- Modify: `packages/aai-templates/scaffold/CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md documentation**

In `packages/aai-templates/scaffold/CLAUDE.md`, make these changes:

1. Replace `createVoiceSession` from `@alexkroman1/aai-ui/session` with import from `@alexkroman1/aai-ui`
2. Remove `StateIndicator` standalone examples — replace with `ChatView` using `icon` prop
3. Update all `useSession()` examples from `const { session, ... } = useSession()` to `const session = useSession()`
4. Remove `Reactive<T>` from type documentation
5. Remove `./session` from documented subpath exports
6. Remove `createSessionControls` and `SessionSignals` references

- [ ] **Step 2: Run markdownlint if configured**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm markdownlint packages/aai-templates/scaffold/CLAUDE.md 2>/dev/null || true`

- [ ] **Step 3: Commit**

```bash
git add packages/aai-templates/scaffold/CLAUDE.md
git commit -m "docs: update scaffold CLAUDE.md for new aai-ui API"
```

---

## Task 12: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run full aai-ui test suite**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:aai-ui`
Expected: All tests pass.

- [ ] **Step 2: Run template tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm test:templates`
Expected: All template tests pass.

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm typecheck`
Expected: No type errors.

- [ ] **Step 4: Run lint**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm lint`
Expected: No lint errors.

- [ ] **Step 5: Run check:local**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm check:local`
Expected: All checks pass (build, typecheck, lint, publint, syncpack, tests).

- [ ] **Step 6: Verify file count reduction**

```bash
find packages/aai-ui -name '*.ts' -o -name '*.tsx' | grep -v node_modules | grep -v test | grep -v _test | wc -l
```

Expected: Fewer source files than the original ~20. Target: ~14 (removed: client-handler.ts, signals.ts, client-context.ts, thinking-indicator.tsx, transcript.tsx, error-banner.tsx, state-indicator.tsx, message-bubble.tsx = -8 files, added: context.ts, hooks.ts = +2 files, net = -6).

- [ ] **Step 7: Create changeset**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/ui-simplify && pnpm changeset`

Select `@alexkroman1/aai-ui` as a **major** change. Summary:

```
Simplify aai-ui package: remove Reactive<T> abstraction, hardcode Preact signals, inline micro-components, merge createSessionControls into createVoiceSession, remove ./session subpath export. See docs/superpowers/specs/2026-04-07-aai-ui-simplification-design.md for full details.

BREAKING CHANGES:
- createSessionControls removed (merged into createVoiceSession)
- SessionSignals type removed
- Reactive<T> type removed
- useSession() return shape changed (returns VoiceSession directly)
- VoiceSessionOptions no longer accepts reactiveFactory or batch
- ./session subpath export removed
- Components removed from exports: ErrorBanner, StateIndicator, ThinkingIndicator, Transcript, MessageBubble
- ButtonVariant, ButtonSize types removed from exports
```
