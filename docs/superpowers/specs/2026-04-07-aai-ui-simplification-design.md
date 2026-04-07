# aai-ui Simplification Design

Refactor the `@alexkroman1/aai-ui` package to reduce abstraction layers, inline micro-components, and shrink the public API surface while preserving all user-facing functionality.

**Approach:** Bottom-up consolidation. Start at the session layer, work up through components, then trim exports.

## 1. Session Layer Consolidation

### 1.1 Inline ClientHandler into session.ts

Delete `client-handler.ts`. Move its logic into `session.ts` as private functions within the `createVoiceSession` closure:

- `event()` switch statement becomes a local `handleEvent()` function
- `playAudioChunk()` and `playAudioDone()` become local functions
- `handleMessage()` (binary/text dispatch + Zod parse) becomes a local function
- The `#generation` counter and `#deltaAccum` become closure variables

The handler's 8 private fields (`#state`, `#messages`, etc.) are already the same reactive signals owned by the session — the class indirection is pure overhead.

### 1.2 Merge createSessionControls into createVoiceSession

Delete the `createSessionControls` function from `signals.ts`. The `VoiceSession` type returned by `createVoiceSession` gains:

- `started: Signal<boolean>` — whether user has initiated the session
- `running: Signal<boolean>` — whether currently connected/connecting
- `start(): void` — set started + running, call connect()
- `toggle(): void` — toggle between connected and disconnected

`reset()` already exists on `VoiceSession` — the current `createSessionControls.reset()` is a pass-through. No change needed.

The error-tracking effect (`if state === "error" then running = false`) moves into the session factory as an internal `effect()` call within `createVoiceSession`, disposed on `disconnect()`.

### 1.3 Remove Reactive<T> / reactiveFactory / batch injection

`createVoiceSession` imports `signal` and `batch` from `@preact/signals` directly. Remove from `VoiceSessionOptions`:

- `reactiveFactory`
- `batch`

Remove the `Reactive<T>` type entirely. All reactive state uses `Signal<T>` from `@preact/signals`.

### 1.4 Remove ./session subpath export

No non-Preact consumers exist. Remove the `./session` entry from `package.json` exports. Remove the `check:attw` entrypoint for `./session`.

### 1.5 Extract context and hooks to small files

From `signals.ts`, extract:

**`context.ts` (~40 LOC):**
- `SessionProvider` — Preact context provider (wraps `VoiceSession`)
- `useSession()` — hook to access `VoiceSession` from context
- `ClientConfigProvider` — from current `client-context.ts`
- `useClientConfig()` — from current `client-context.ts`

Delete `client-context.ts` (absorbed into `context.ts`).

**`hooks.ts` (~100 LOC):**
- `useToolResult` — fire callback per completed tool call (both overloads)
- `useToolCallStart` — fire callback when tool starts
- `useAutoScroll` — auto-scroll sentinel ref
- Private `useToolCallEffect` helper
- Private `isNewCompletedCall`, `tryParseJSON` helpers

Delete `signals.ts` (all contents moved to `context.ts`, `hooks.ts`, or `session.ts`).

### 1.6 Resulting core file structure

```
session.ts    (~400 LOC) — WebSocket lifecycle, audio init, message dispatch, reactive state
context.ts    (~40 LOC)  — SessionProvider, useSession, ClientConfigProvider, useClientConfig
hooks.ts      (~100 LOC) — useToolResult, useToolCallStart, useAutoScroll
types.ts      (unchanged) — public types (minus Reactive<T>)
audio.ts      (simplified) — VoiceIO factory
define-client.tsx (simplified) — mount helper, uses createVoiceSession directly
```

### 1.7 useSession() shape change

Before:
```ts
const { session, started, running, start, toggle, reset } = useSession();
session.state.value; // access reactive state
```

After:
```ts
const session = useSession();
session.state.value;    // reactive state
session.started.value;  // Signal<boolean>
session.start();        // action
```

The context now holds `VoiceSession` directly — no `SessionSignals` wrapper.

## 2. Component Consolidation

### 2.1 Components to inline

| Component | Inlined into | Rationale |
|---|---|---|
| `thinking-indicator.tsx` | `message-list.tsx` | Only used in message-list and transcript. 3 animated dots, ~10 lines JSX. |
| `transcript.tsx` | `message-list.tsx` | Only used in message-list. Conditional render, ~8 lines. |
| `error-banner.tsx` | `chat-view.tsx` | Only used in chat-view. Conditional div, ~8 lines. |
| `state-indicator.tsx` | `chat-view.tsx` | Only used in chat-view. Dot + label, ~12 lines. |
| `message-bubble.tsx` | `message-list.tsx` | Only used in message-list. Two-branch conditional, ~20 lines. |

### 2.2 Components kept as separate files

| Component | Reason |
|---|---|
| `app.tsx` | Default top-level, exported |
| `chat-view.tsx` | Key composable, absorbs error-banner + state-indicator. Gains `icon` prop. |
| `message-list.tsx` | Absorbs message-bubble + transcript + thinking-indicator. Non-trivial interleaving. |
| `controls.tsx` | Exported composable |
| `button.tsx` | Reusable primitive, exported |
| `tool-call-block.tsx` | Non-trivial (collapsible, config lookup), exported |
| `start-screen.tsx` | Exported composable |
| `sidebar-layout.tsx` | Exported composable |
| `tool-icons.tsx` | SVG icons, keeps tool-call-block clean |

### 2.3 ChatView gains icon prop

```tsx
export function ChatView({ icon, className }: { icon?: ComponentChildren; className?: string })
```

When `icon` is provided, it renders in the header before the title. This lets templates customize the header without rebuilding ChatView from scratch (e.g., night-owl's owl emoji).

### 2.4 File count change

Components directory: 13 files -> 8 files (delete thinking-indicator, transcript, error-banner, state-indicator, message-bubble).

## 3. Audio Simplification

### 3.1 Remove double-buffer mic capture

Replace the `capBufA`/`capBufB` swap pattern in `audio.ts` (lines 98-121) with a single accumulating buffer:

```ts
let capBuf = new Uint8Array(chunkSizeBytes);
let capOffset = 0;

capNode.port.onmessage = (e) => {
  if (e.data.event !== "chunk") return;
  const chunk = new Uint8Array(e.data.buffer);
  capBuf.set(chunk, capOffset);
  capOffset += chunk.byteLength;
  if (capOffset >= chunkSizeBytes) {
    onMicData(capBuf.buffer.slice(0, capOffset));
    capBuf = new Uint8Array(chunkSizeBytes);
    capOffset = 0;
  }
};
```

At 10 sends/sec of ~3KB, GC overhead from allocating a new buffer per send is negligible. Removes ~15 lines of buffer-swap complexity.

### 3.2 Clean up worklet source files

The worklet code stays as TypeScript files exporting template literal strings (the inlining is required for portability across deployment targets). Clean up:

- Add clear section comments delineating the worklet boundary
- Improve formatting of the code inside template literals for readability
- No change to the loading mechanism (`import() -> data URI -> addModule()`)

## 4. Public API Surface

### 4.1 Exports kept

```ts
// Mounting
defineClient, ClientHandle, ClientOptions

// Session
createVoiceSession, VoiceSession, VoiceSessionOptions

// Hooks
useSession, useToolResult, useToolCallStart, useAutoScroll, useClientConfig

// Composable components
App, ChatView, StartScreen, SidebarLayout, Controls, Button, ToolCallBlock, MessageList

// Context
SessionProvider, ClientConfigProvider

// Types
AgentState, ChatMessage, SessionError, SessionErrorCode, ToolCallInfo, ClientTheme, ClientConfig
```

### 4.2 Exports removed

| Export | Reason |
|---|---|
| `createSessionControls` | Merged into `createVoiceSession` |
| `SessionSignals` | Gone — `VoiceSession` has signals directly |
| `Reactive<T>` | Removed — using `Signal<T>` from `@preact/signals` |
| `ButtonVariant`, `ButtonSize` | Inferrable from `Button` props via `ComponentProps` |
| `MessageBubble` | Inlined into `MessageList` |
| `ErrorBanner` | Inlined into `ChatView` |
| `StateIndicator` | Inlined into `ChatView` |
| `ThinkingIndicator` | Inlined into `MessageList` |
| `Transcript` | Inlined into `MessageList` |
| `WebSocketConstructor` | Internal testing concern |
| `ClientHandler` (re-export from session.ts) | Was `@internal`, now inlined |

### 4.3 Subpath exports

| Path | Status |
|---|---|
| `.` | Kept |
| `./styles.css` | Kept |
| `./session` | Removed |

## 5. Template & Documentation Updates

### 5.1 Template fixes

**night-owl/client.tsx:**
- Remove imports: `StateIndicator`, `ErrorBanner`, `ThinkingIndicator`
- Replace custom `ChatPanel` with `<ChatView icon={<span class="text-lg">{"\u{1F989}"}</span>} />`
- Inline 3-dot loading animation in sidebar (replace `ThinkingIndicator` usage)
- Update `useSession()` destructuring to flat access pattern

**pizza-ordering/client.tsx:**
- Update `useSession()`: `running`, `toggle`, `reset` come from session directly
- `session.cancel()`, `session.resetState()` unchanged (already on VoiceSession)

**infocom-adventure/client.tsx:**
- Update `useSession()` return shape

**dispatch-center/client.tsx:**
- Update `useSession()` return shape

**All other templates** (`simple`, `web-researcher`, `health-assistant`, `support`, `smart-research`, `embedded-assets`, `code-interpreter`, `math-buddy`, `memory-agent`, `test-patterns`, `travel-concierge`, `solo-rpg`):
- No changes needed (import only `App`, `defineClient`, `ChatView`, `StartScreen`, `SidebarLayout`, `useToolResult`, `Button` — all kept)

### 5.2 scaffold/CLAUDE.md updates

- Remove `createVoiceSession` from `@alexkroman1/aai-ui/session` examples — use main `.` export
- Remove `StateIndicator` standalone examples — show `ChatView` with `icon` prop
- Update `useSession()` return shape in all code examples
- Remove `Reactive<T>` from type documentation
- Remove `./session` from documented subpath exports

### 5.3 Test updates

- `client-handler.test.ts` — move/adapt tests to test the inlined handler logic via session integration tests or extract handler functions for direct testing
- `signals.test.tsx` — adapt to test hooks from `hooks.ts` and context from `context.ts`
- `cleanup.test.ts` — update for new session shape
- `fixture-replay.test.tsx` — update session construction (no more `reactiveFactory`/`batch` params)
- Component tests (`controls.test.tsx`, `tool-call-block.test.tsx`) — update `useSession` mocking
- `published-exports.test.ts` — update to match new export surface
- Type-level tests (`.test-d.ts`) — update for removed types and new VoiceSession shape

## 6. Breaking Changes

This is a **breaking change** requiring a major version bump or breaking changeset:

- `createSessionControls` removed
- `SessionSignals` type removed
- `Reactive<T>` type removed
- `useSession()` return shape changed
- `VoiceSessionOptions` lost `reactiveFactory` and `batch` fields
- `./session` subpath removed
- 5 components removed from exports
- `ButtonVariant`, `ButtonSize` types removed from exports

## 7. Implementation Order

1. Hardcode Preact signals into `session.ts`, remove `Reactive<T>`/factory/batch
2. Inline `ClientHandler` into `session.ts`
3. Merge `createSessionControls` into `createVoiceSession`
4. Extract `context.ts` and `hooks.ts` from `signals.ts`, delete `signals.ts` and `client-context.ts`
5. Simplify `define-client.tsx` to use new session directly
6. Simplify audio (remove double-buffer)
7. Clean up worklet source formatting
8. Inline micro-components (thinking-indicator, transcript, error-banner, state-indicator, message-bubble)
9. Add `icon` prop to `ChatView`
10. Update `index.ts` exports
11. Update all templates
12. Update `scaffold/CLAUDE.md`
13. Update all tests
14. Run `pnpm check:local` and fix any remaining issues
