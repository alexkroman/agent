# S2S Idle Timeout

**Status:** done
**Issue:** #10 — S2S idle timeout and connection pooling

## Problem

Each session creates a new S2S WebSocket with no keepalive or idle timeout.
If a client disconnects mid-session (or simply stops sending audio), the S2S
connection can remain open indefinitely, wasting server resources and
AssemblyAI API quota.

## Solution

Added a configurable idle timeout that closes the S2S connection after a
period of inactivity. Activity is defined as any audio, transcript, tool
call, or reply event in either direction.

### Configuration

```ts
defineAgent({
  name: "my-agent",
  idleTimeoutMs: 300_000, // 5 minutes (default)
});
```

- **Default:** 5 minutes (`300_000` ms)
- **Disable:** set to `0` or `Infinity`
- Configurable via `AgentOptions.idleTimeoutMs`

### Behaviour

1. Timer starts when the S2S connection is established.
2. Every inbound S2S event (speech, transcripts, audio, tool calls, replies)
   and outbound client audio resets the timer.
3. When the timer fires:
   - `idle_timeout` event is sent to the client
   - The S2S connection is closed
   - `aai.session.idle.timeout.count` metric is incremented
4. Timer is cleared on `stop()` and `onReset()`.

### Files changed

| File | Change |
|------|--------|
| `types.ts` | Added `idleTimeoutMs` to `AgentOptions`, `AgentDef`, `AgentOptionsSchema` |
| `_internal-types.ts` | Added `idleTimeoutMs` to `AgentConfigSchema`, `AgentConfigSource`, `toAgentConfig` |
| `session.ts` | Added idle timer fields to `S2sSessionCtx`, wired into lifecycle |
| `_session-otel.ts` | Added `setupIdleTimeout()` — registers idle callback, resets on S2S events |
| `protocol.ts` | Added `idle_timeout` event to `ClientEventSchema` |
| `telemetry.ts` | Added `idleTimeoutCounter` metric |
| `session.test.ts` | 6 new tests covering timeout fire, reset, disable, stop cleanup, default |
| `protocol-snapshot.test.ts` | Added `idle_timeout` to valid event list |
| `api/aai.api.md` | Updated API report |
