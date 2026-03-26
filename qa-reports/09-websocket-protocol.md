# WebSocket & Protocol QA Report

## Summary

Audit of WebSocket and real-time communication across all four packages (`aai`, `aai-ui`, `aai-server`, `aai-cli`). Found 14 issues ranging from missing error handlers and absent heartbeat/keepalive mechanisms to race conditions in session lifecycle, lack of backpressure handling, and incomplete reconnection logic. The most impactful issues are the absence of any WebSocket ping/pong keepalive (risking silent disconnections behind NATs/load balancers), the client-side missing `error` event handler (losing diagnostic information), and several race conditions around session start/stop and audio initialization.

## Issues Found

### Issue 1: No WebSocket heartbeat/keepalive on S2S connection
- **File**: `packages/aai/s2s.ts:208-356`
- **Severity**: High
- **Description**: The `connectS2s` function establishes a WebSocket to the AssemblyAI S2S API but never sets up ping/pong frames or any application-level heartbeat. Long-lived voice sessions can be silently dropped by intermediate proxies, load balancers, or NATs that enforce idle timeouts (typically 30-60 seconds). Once the TCP connection is severed without a FIN, neither side detects the failure until the next send attempt or OS-level TCP keepalive fires (often minutes later).
- **Recommendation**: Implement periodic WebSocket ping frames (e.g., every 30 seconds) using the `ws` package's `ping()` method, and close the connection if a pong is not received within a reasonable timeout. Alternatively, send an application-level heartbeat message and expect a response.

### Issue 2: No heartbeat/keepalive on the client-to-server WebSocket
- **File**: `packages/aai-ui/session.ts:244-301`
- **Severity**: High
- **Description**: The browser client's `createVoiceSession` opens a WebSocket to the server but implements no heartbeat mechanism. The browser's native WebSocket API does not expose ping/pong control. If the server or an intermediary silently drops the connection, the client will not detect the loss until it tries to send audio data, which may lead to a prolonged period of apparent silence with no error reported to the user.
- **Recommendation**: Implement an application-level heartbeat protocol (e.g., periodic JSON `{ "type": "ping" }` messages from the client, with the server echoing a `{ "type": "pong" }`). Set a timer on the client to detect missed pongs and trigger reconnection.

### Issue 3: Client-side WebSocket missing `error` event handler
- **File**: `packages/aai-ui/session.ts:259-301`
- **Severity**: High
- **Description**: The `connect()` function in `createVoiceSession` registers handlers for `open`, `message`, and `close` events on the WebSocket, but there is no `error` event listener. In browsers, WebSocket error events can fire before or without a corresponding close event. Without an error handler, the error is silently swallowed, and the session may remain in a stale state (e.g., `"connecting"`) with no error information surfaced to the user.
- **Recommendation**: Add a `socket.addEventListener("error", ...)` handler that sets `error.value` to an appropriate error and transitions `state.value` to `"error"` or triggers a disconnect.

### Issue 4: Race condition between session start failure and message handling
- **File**: `packages/aai/ws-handler.ts:164-175`
- **Severity**: Medium
- **Description**: In `wireSessionSocket`, the `session.start()` call is async and runs concurrently with message handling. If `start()` fails (line 170-175), the session variable is set to `null` and removed from the sessions map, but the WebSocket remains open. The client can continue sending messages that will be silently dropped (line 186: `if (!session) return`). The client receives no indication that the session failed, and audio data sent during or after the failure is lost.
- **Recommendation**: On session start failure, send an error event to the client via the WebSocket and close the WebSocket connection, so the client can detect the failure and retry.

### Issue 5: No backpressure handling on WebSocket send
- **File**: `packages/aai/s2s.ts:241-243`
- **Severity**: Medium
- **Description**: The `sendAudio` method in the S2S handle constructs a JSON string with base64-encoded audio and calls `ws.send()` without checking `bufferedAmount`. During periods of high audio throughput or network congestion, the send buffer can grow unboundedly. The `ws` package buffers data in memory, which can lead to excessive memory consumption and eventual OOM for long-running sessions with network hiccups.
- **Recommendation**: Check `ws.bufferedAmount` before sending and implement a backpressure strategy (e.g., skip audio frames when the buffer exceeds a threshold, or pause the audio capture until the buffer drains).

### Issue 6: No backpressure on server-to-client audio streaming
- **File**: `packages/aai/ws-handler.ts:53-76`
- **Severity**: Medium
- **Description**: The `createClientSink` function's `playAudioChunk` method calls `ws.send(chunk)` with binary data without any backpressure check. If the client is on a slow connection, the server will buffer all TTS audio chunks in the WebSocket send buffer. For long agent responses, this can consume significant server memory per session.
- **Recommendation**: Monitor `ws.bufferedAmount` and implement flow control. Consider pausing TTS audio generation when the buffer is above a threshold.

### Issue 7: Client audio capture buffer overflow on slow WebSocket
- **File**: `packages/aai-ui/audio.ts:94-111`
- **Severity**: Medium
- **Description**: The capture buffer (`capBuf`) is a fixed-size `Uint8Array` (line 95: `chunkSizeBytes * 2`). The `onmessage` handler accumulates audio data at `capOffset` and sends when `capOffset >= chunkSizeBytes`. However, if an AudioWorklet chunk is larger than `chunkSizeBytes` (e.g., due to sample rate mismatch or a large worklet buffer), the `capBuf.set(chunk, capOffset)` at line 104 can write past the end of the buffer, causing silent data corruption or a runtime error. There is no bounds check before the `set()` call.
- **Recommendation**: Add a bounds check before `capBuf.set(chunk, capOffset)`. If `capOffset + chunk.byteLength` exceeds the buffer size, flush the buffer first or use a dynamically growing buffer.

### Issue 8: Session reset creates orphaned S2S connections
- **File**: `packages/aai/session.ts:224-237`
- **Severity**: Medium
- **Description**: In the `onReset()` handler, `ctx.s2s?.close()` is called (line 233), but `connectAndSetup()` is immediately invoked afterward (line 235). If `connectAndSetup()` fails, the session is left with `ctx.s2s = null` and no S2S connection, but the client WebSocket remains open. Conversely, since `connectAndSetup` is async and `onReset` is synchronous, there is a window where the old S2S handle is closed but the new one is not yet assigned to `ctx.s2s`, during which `onAudio` calls (line 218-219) will silently drop audio because `ctx.s2s` is null.
- **Recommendation**: Buffer or pause audio during the reconnection window. Send the client an event indicating the session is reconnecting, and surface errors from `connectAndSetup` to the client.

### Issue 9: Unhandled promise rejection in `done()` when playback node is destroyed
- **File**: `packages/aai-ui/audio.ts:146-152`
- **Severity**: Medium
- **Description**: The `done()` method creates a `Promise` that resolves when the playback worklet sends a `"stop"` message. However, if the AudioContext is closed or the playback node is disconnected before the `"stop"` message arrives (e.g., during a rapid `cancel` + `close` sequence), the promise will never resolve. The `onPlaybackStop` callback is set but never called, causing a memory leak and potentially hanging any `await io.done()` caller indefinitely.
- **Recommendation**: Add a cleanup mechanism that rejects or resolves the pending `done()` promise when `close()` or `flush()` is called. Consider using an `AbortSignal` or tracking the promise so it can be force-resolved during cleanup.

### Issue 10: S2S connection promise never rejects on timeout
- **File**: `packages/aai/s2s.ts:208-356`
- **Severity**: Medium
- **Description**: The `connectS2s` function returns a `Promise` that resolves on the `"open"` event and rejects on `"error"` or `"close"` before open. However, there is no connection timeout. If the WebSocket connection hangs (e.g., DNS resolution stalls, TCP SYN is blackholed), the promise will remain pending indefinitely. The caller (`createS2sSession.connectAndSetup`) will also hang, blocking session startup.
- **Recommendation**: Add a connection timeout (e.g., 10 seconds) that rejects the promise and closes the WebSocket if the `"open"` event has not fired within the timeout window.

### Issue 11: No automatic reconnection on S2S disconnect
- **File**: `packages/aai/_session-otel.ts:274-277`
- **Severity**: Medium
- **Description**: When the S2S WebSocket closes (the `close` event on the handle), the session simply sets `ctx.s2s = null` (line 276). No reconnection is attempted. If AssemblyAI's S2S service experiences a transient disconnect, the session becomes permanently degraded: the client WebSocket remains open, but all audio data is silently dropped (since `onAudio` checks `ctx.s2s?.sendAudio`). The client receives no error notification and no indication that reconnection is needed.
- **Recommendation**: Implement automatic S2S reconnection with exponential backoff. When the S2S connection drops, notify the client with an event (e.g., `{ type: "error", code: "connection", message: "Reconnecting..." }`) and attempt to re-establish the S2S connection.

### Issue 12: Server shutdown does not await sandbox termination
- **File**: `packages/aai-server/src/index.ts:110-119`
- **Severity**: Medium
- **Description**: The `shutdown()` function on line 110 calls `slot.sandbox?.terminate()` without awaiting the returned promise. `terminate()` is async (it stops sessions, disposes the runtime, and closes the sidecar), but the shutdown proceeds immediately to `nodeServer.close()` and the force-exit timer. In-flight tool calls or session stops may not complete cleanly, potentially causing data loss in KV operations or leaving orphaned isolate processes.
- **Recommendation**: Await all `terminate()` promises before closing the node server. Use `Promise.allSettled()` with a reasonable timeout to ensure clean shutdown.

### Issue 13: No protocol version negotiation between client and server
- **File**: `packages/aai/protocol.ts` / `packages/aai-ui/session.ts`
- **Severity**: Low
- **Description**: The wire protocol between the client (`aai-ui`) and the server (`aai`/`aai-server`) uses JSON messages with a `type` discriminator, but there is no version field in the `config` message or any handshake to negotiate protocol compatibility. If the client and server are running different versions (common in web deployments where the browser may have a cached old client), unrecognized message types are silently ignored (both sides log a warning and drop the message). This can cause subtle behavioral mismatches without any user-visible error.
- **Recommendation**: Add a `protocolVersion` field to the `config` message sent on connect. The client should check this version and display an error or trigger a page reload if the versions are incompatible.

### Issue 14: Audio format mismatch not validated on client
- **File**: `packages/aai-ui/client-handler.ts:174-179`
- **Severity**: Low
- **Description**: The `handleMessage` method treats all binary frames as raw PCM16 audio (line 176-178) without validating that the audio format matches what was negotiated in the `config` message. If the server ever sends audio in a different format (e.g., due to a configuration change or a future protocol extension), the client would attempt to play it as PCM16, producing garbled audio output rather than an error.
- **Recommendation**: Validate that the negotiated `audioFormat` from the config message is `"pcm16"` before treating binary frames as raw PCM. If the format is unrecognized, surface an error to the user rather than playing corrupt audio.
