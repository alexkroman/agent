# Session Persistence

**Status**: in-progress
**Issue**: F1 — Session state is ephemeral with no cross-session persistence

## Problem

Session state created by `state: () => ({})` lives only in memory and is lost
when the WebSocket disconnects or the server restarts. The KV store exists but
there is no built-in pattern for hydrating session state from KV on reconnect.
Every developer must build their own session recovery logic.

## Solution

Add opt-in `persistence` option to `defineAgent()` that automatically
saves/restores session state, conversation messages, and the AssemblyAI S2S
session ID across WebSocket reconnects.

### API

```ts
export default defineAgent({
  name: "my-agent",
  state: () => ({ items: [] }),
  persistence: true, // or { ttl: 7200000 } for custom TTL
  // ...
});
```

### Flow

**Disconnect (save):**
1. Session `stop()` fires
2. Before cleanup, serialize `{ state, messages, s2sSessionId }` to KV
3. KV key: `__persist:<sessionId>`, with configurable TTL (default 1h)
4. Then proceed with normal cleanup (onDisconnect hook, state deletion)

**Reconnect (restore):**
1. Client connects with `?sessionId=<old-session-id>` URL param
2. Server generates a new internal session ID
3. During `session.start()`, loads persisted data from KV using old session ID
4. Hydrates agent state and conversation messages
5. Sends `session.resume` to AssemblyAI S2S API with the stored S2S session ID
6. If S2S resume fails (session expired), falls back to `session.update` (fresh
   S2S session, but local state is still restored)
7. Config message to client includes new `sessionId` for future reconnects

### Changes

| File | Change |
|------|--------|
| `types.ts` | Add `persistence` to `AgentOptions`/`AgentDef` |
| `_utils.ts` | Add `set()` to `createSessionStateMap` |
| `protocol.ts` | Add `sessionId` to config message schema |
| `_session-otel.ts` | Add `onSessionExpired` option to `setupListeners` |
| `session.ts` | Persistence save/restore + S2S resume logic |
| `direct-executor.ts` | Wire persistence config to session creation |
| `ws-handler.ts` | Support `resumeFrom`, include `sessionId` in config |
| `server.ts` | Read `?sessionId=` from URL for resume |
