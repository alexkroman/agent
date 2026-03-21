# Plan: Remove Audio Fast-Path from Capnweb Bridge

## Goal

Remove the binary audio fast-path optimization from the capnweb MessagePort
bridge. All S2S messages (including `reply.audio` and `input.audio`) will flow
as plain text frames through the bridge, matching how every other message type
already works. This eliminates the `k:1` binary frame type from the S2S bridge,
the `sendBinary` method, and the custom `"audio"` event — unifying the bridged
and direct code paths in `s2s.ts`.

**Note:** The `k:1` binary frame type is still used by `BridgedWebSocket` (for
client↔server audio). This plan only removes it from the **S2S bridge**
(`bridgeS2sWebSocketToPort` / `createBridgedS2sWebSocket`).

## Files Changed

1. `sdk/capnweb.ts`
2. `sdk/s2s.ts`
3. `sdk/capnweb_test.ts` (if it exists and tests fast-path behavior)

## Steps

### 1. `sdk/capnweb.ts` — Simplify `bridgeS2sWebSocketToPort`

**Remove** the reply.audio fast-path in the `ws.on("message")` handler
(lines 373–387). All messages just go through as text:

```ts
ws.on("message", (data: unknown) => {
  port.postMessage({ k: 0, d: String(data) });
});
```

**Remove** the `k: 1` case in the `port.onmessage` handler (lines 413–419).
The worker will send `input.audio` as a JSON string like direct mode does, so
only `k: 0` (text) and `k: 2` (close) remain:

```ts
port.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (!isBridgeMsg(msg)) return;
  switch (msg.k) {
    case 0:
      if (ws.readyState === 1) ws.send(msg.d);
      break;
    case 2:
      ws.close();
      break;
  }
};
```

**Update** the JSDoc on `bridgeS2sWebSocketToPort` to remove the audio
fast-path description (lines 357–364).

### 2. `sdk/capnweb.ts` — Simplify `createBridgedS2sWebSocket`

**Remove** the `k: 1` → `emit("audio")` case (lines 266–268). Binary frames
are no longer sent through this bridge.

**Remove** the `sendBinary` method from the returned object (lines 292–295).

The returned object becomes:

```ts
return {
  get readyState() { return readyState; },
  send(data: string): void {
    if (readyState !== 1) return;
    port.postMessage({ k: 0, d: data });
  },
  close(): void { ... },
  on(event: string, handler: (...args: unknown[]) => void): void { ... },
};
```

### 3. `sdk/s2s.ts` — Remove `sendBinary` from the type and usage

**Remove** `sendBinary` from the `S2sWebSocket` type (line 33):

```ts
export type S2sWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
};
```

**Simplify** `sendAudio` in the S2S handle (lines 263–275). Remove the
`sendBinary` branch — always use the JSON path:

```ts
sendAudio(audio: Uint8Array): void {
  if (ws.readyState !== WS_OPEN) return;
  ws.send(`{"type":"input.audio","audio":"${uint8ToBase64(audio)}"}`);
},
```

**Remove** the `ws.on("audio")` listener (lines 304–308). The bridged path
now delivers `reply.audio` as a regular `"message"` event, so the existing
`ws.on("message")` handler at line 328 will decode it (same as direct mode).

**Update** comments that reference "bridged mode" vs "direct mode" around
lines 266, 273, 304, 319 to remove the distinction since both paths now
behave identically.

### 4. Verify

- `pnpm test` — all tests pass
- `pnpm lint` — no lint errors
- Grep for any remaining references to `sendBinary` or the `"audio"` event
  on `S2sWebSocket` to confirm nothing was missed

## What's NOT Changing

- `BridgedWebSocket` (EventTarget-based, for client connections) — still uses
  `k:1` for binary audio frames between browser and server. Unrelated path.
- `bridgeWebSocketToPort` — unchanged, still handles client binary audio.
- The `"audio"` CustomEvent dispatched on the S2S `EventTarget` handle
  (`session.ts:303`) — this stays; it's the internal event from S2S to session,
  now always populated by the `reply.audio` JSON decode in `s2s.ts:328`.
- `ui/session.ts` `sendBinary` — this is the browser→server binary audio path
  over a real WebSocket, completely unrelated to the capnweb bridge.

## Net Effect

- ~40 lines removed across 2 files
- `sendBinary` removed from `S2sWebSocket` interface (simpler contract)
- Bridged and direct S2S paths unified (one code path for audio in `s2s.ts`)
- No new dependencies
