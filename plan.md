# Plan: Simplify Capnweb Bridge

Two simplifications to `sdk/capnweb.ts` and its consumers:

1. **Remove the audio fast-path** — eliminate `sendBinary`, the `"audio"` event,
   and binary frame handling from the S2S bridge. All S2S messages flow as text.
2. **Unify the two WebSocket bridge implementations** — replace
   `createBridgedS2sWebSocket` + `bridgeS2sWebSocketToPort` (`.on()` style) with
   the existing `BridgedWebSocket` + `bridgeWebSocketToPort` (EventTarget style)
   by adding a thin adapter that wraps `.on()`-style `ws` instances as
   EventTarget.

Together these cut capnweb.ts roughly in half.

---

## Part 1: Remove Audio Fast-Path

### Files Changed

- `sdk/capnweb.ts`
- `sdk/s2s.ts`

### Steps

#### 1a. `sdk/capnweb.ts` — Simplify `bridgeS2sWebSocketToPort`

**Remove** the `reply.audio` detection + base64 decode in the `ws.on("message")`
handler (lines 373–387). All messages go through as text:

```ts
ws.on("message", (data: unknown) => {
  port.postMessage({ k: 0, d: String(data) });
});
```

**Remove** the `k: 1` case in the `port.onmessage` handler (lines 413–419).
Only `k: 0` (text) and `k: 2` (close) remain.

**Update** the JSDoc to remove the audio fast-path description (lines 357–364).

#### 1b. `sdk/capnweb.ts` — Simplify `createBridgedS2sWebSocket`

**Remove** the `k: 1` → `emit("audio")` case (lines 266–268).

**Remove** the `sendBinary` method from the returned object (lines 292–295).

#### 1c. `sdk/s2s.ts` — Remove `sendBinary` from type and usage

**Remove** `sendBinary` from the `S2sWebSocket` type (line 33).

**Simplify** `sendAudio` (lines 263–275) — remove the `sendBinary` branch,
always use the JSON path:

```ts
sendAudio(audio: Uint8Array): void {
  if (ws.readyState !== WS_OPEN) return;
  ws.send(`{"type":"input.audio","audio":"${uint8ToBase64(audio)}"}`);
},
```

**Remove** the `ws.on("audio")` listener (lines 304–308). The bridged path now
delivers `reply.audio` as a regular `"message"` event, decoded by the existing
handler at line 328 (same as direct mode).

**Remove/update** comments referencing "bridged mode" vs "direct mode" around
lines 266, 273, 304, 319.

---

## Part 2: Unify WebSocket Bridge Implementations

### Problem

The bridge code is doubled because `S2sWebSocket` uses `.on("event", cb)` while
browser WebSocket uses `addEventListener("event", cb)`:

| Concern | EventTarget version | `.on()` version |
|---|---|---|
| Worker-side wrapper | `BridgedWebSocket` (55 lines) | `createBridgedS2sWebSocket` (55 lines) |
| Host-side bridge | `bridgeWebSocketToPort` (40 lines) | `bridgeS2sWebSocketToPort` (60 lines) |

After Part 1 removes the audio fast-path, these two pairs become nearly
identical — the only difference is the event API style.

### Approach

Add a small adapter function (~15 lines) that wraps an `.on()`-style WebSocket
(from the `ws` npm package) as a standard `WebSocket`-shaped EventTarget. Then
reuse `BridgedWebSocket` and `bridgeWebSocketToPort` for both client and S2S
connections.

### Files Changed

- `sdk/capnweb.ts`
- `sdk/s2s.ts`
- `sdk/worker_shim.ts`
- `sdk/server.ts`
- `sdk/session.ts`
- `sdk/direct_executor.ts`
- `sdk/winterc_server.ts`
- `cli/_server_common.ts`

### Steps

#### 2a. `sdk/s2s.ts` — Replace `S2sWebSocket` type with standard WebSocket shape

Change `S2sWebSocket` from `.on()` style to EventTarget style. The type becomes
a subset of the standard `WebSocket` interface (matching `SessionWebSocket` from
`ws_handler.ts`):

```ts
export type S2sWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
};
```

Update `createS2sSession` to use `addEventListener` instead of `ws.on()`
(lines 298, 310, 345, 354).

Update `CreateS2sWebSocket` return type accordingly.

#### 2b. `sdk/capnweb.ts` — Add `wrapOnStyleWebSocket` adapter

Add a ~15-line function that wraps a `ws`-style `.on()` WebSocket as an
EventTarget-based WebSocket:

```ts
export function wrapOnStyleWebSocket(ws: {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}): S2sWebSocket {
  const target = new EventTarget();
  ws.on("open", () => target.dispatchEvent(new Event("open")));
  ws.on("message", (data: unknown) =>
    target.dispatchEvent(new MessageEvent("message", { data })));
  ws.on("close", (code: unknown, reason: unknown) =>
    target.dispatchEvent(new CloseEvent("close", {
      code: typeof code === "number" ? code : undefined,
      reason: String(reason ?? ""),
    })));
  ws.on("error", (err: unknown) =>
    target.dispatchEvent(new ErrorEvent("error", {
      message: err instanceof Error ? err.message : String(err),
    })));
  return Object.assign(target, {
    get readyState() { return ws.readyState; },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    addEventListener: target.addEventListener.bind(target),
  });
}
```

#### 2c. `sdk/capnweb.ts` — Delete `createBridgedS2sWebSocket` and `bridgeS2sWebSocketToPort`

These are no longer needed. The worker uses `BridgedWebSocket` for S2S
connections too. The host uses `bridgeWebSocketToPort`.

Delete:
- `createBridgedS2sWebSocket` (~55 lines)
- `bridgeS2sWebSocketToPort` (~60 lines)

#### 2d. `sdk/worker_shim.ts` — Use `BridgedWebSocket` for S2S

Change the S2S WebSocket factory (lines 169–173) to use `BridgedWebSocket`
instead of `createBridgedS2sWebSocket`:

```ts
const createWebSocket: CreateS2sWebSocket = (_url, _opts) => {
  const { port1, port2 } = new MessageChannel();
  endpoint.notify("host.createWebSocket", [url, JSON.stringify(opts.headers)], [port2]);
  const ws = new BridgedWebSocket(port1);
  return ws; // BridgedWebSocket already satisfies S2sWebSocket (EventTarget-based)
};
```

Remove the `createBridgedS2sWebSocket` import.

#### 2e. `sdk/server.ts` + `cli/_server_common.ts` — Wrap `ws` instances

Where `CreateS2sWebSocket` factories create `ws` WebSocket instances, wrap
them with `wrapOnStyleWebSocket`:

In `sdk/server.ts` (line 55–56):
```ts
return wrapOnStyleWebSocket(new WS(url, { headers: opts.headers }));
```

In `cli/_server_common.ts` (line 50–51):
```ts
const createWebSocket = (url: string, opts: { headers: Record<string, string> }) =>
  wrapOnStyleWebSocket(new WS(url, { headers: opts.headers }));
```

#### 2f. Update remaining consumers

- `sdk/session.ts`, `sdk/direct_executor.ts`, `sdk/winterc_server.ts` — these
  pass `CreateS2sWebSocket` through as options. The type change propagates
  automatically; no code changes needed beyond what TypeScript requires.

---

## Part 3: Verify

- `pnpm test` — all tests pass
- `pnpm lint` — no lint errors
- Grep for stale references to `sendBinary`, `createBridgedS2sWebSocket`,
  `bridgeS2sWebSocketToPort`, and the `.on()` pattern on `S2sWebSocket`

---

## What's NOT Changing

- `BridgedWebSocket` class — stays, now used for both client and S2S connections
- `bridgeWebSocketToPort` — stays, now used for both client and S2S connections
- `CapnwebEndpoint` (RPC layer) — stays as-is
- `ui/session.ts` browser-side WebSocket code — unrelated
- The `"audio"` CustomEvent on the S2S EventTarget handle (`session.ts:303`) —
  stays; it's the internal event from S2S to session, populated by the
  `reply.audio` JSON decode in `s2s.ts`

## Net Effect

- ~170 lines removed from `capnweb.ts` (from ~427 to ~260)
- ~15 lines added (adapter function)
- `S2sWebSocket` unified with `SessionWebSocket` (both EventTarget-based)
- One bridge implementation instead of two
- One code path for audio in `s2s.ts` (no bridged/direct split)
- No new dependencies
