---
"@alexkroman1/aai-runtime": major
"aai-server": patch
---

Slim `@alexkroman1/aai-runtime`'s contracted surface to what an embedder writes against.

- **Moved to `@alexkroman1/aai-runtime/internal`** (no public signature took or returned them): `ServerSession`, `TransportEventBody`, `TransportEventType`, `StateSyncSession`, `StoredSessionEvent`, `SessionStateBackend`, `SessionStateStore`, `UploadStore`, `UploadBackend`, `HttpUploadBackendOptions`, `createHttpUploadBackend`, `createMemoryUploadBackend`, `partKey`, `partsOf`, `UPLOADS_TABLE`, and the CLI's `requiredProviderEnvVars`, `withHostCredentialFallback`, `CARRIER_PARAM` and `TELEPHONY_PATH`. `HostCredentialEnv` is no longer re-exported (import it from `@alexkroman1/aai/host-internal`).
- **Removed from every subpath**: `WdkAdapter`, `WdkRunRecord`, `WdkStreamOptions`, `WorkflowClientOptions` — nothing published accepted them. `WdkRunRecord.status` is `WorkflowRunStatus` now.
- **`Runtime` loses `executeTool`, `toolSchemas` and `createSession`**, and `RuntimeOptions` loses `createWebSocket`, `createOpenaiRealtimeWebSocket`, `s2sConfig`, `sessionStartTimeoutMs`, `executeTool`, `toolSchemas`, `onToolResult` and `toolGuidance` — testing and relay seams, now host-only. `EvalSessionOptions` (and so `DescribeEvalOptions`) loses `generate`.
- **New `HostAgentOptions`**, the fields `RuntimeOptions`, `TextAgentOptions`, `EvalSessionOptions` and `EvalTextAgentOptions` share. `RuntimeOptions`' shared fields no longer accept an explicit `undefined`.
- **The opener contract (`SttOpener`, `SttSession`, `TtsOpener`, … `Unsubscribe`) is declared in this package** rather than re-exported from `@alexkroman1/aai/host-internal`, which no longer carries it. `OpenerRegistryEntry` takes the kind's options type as a second parameter, and `registerSttKind`/`registerTtsKind` infer it.
- **Closed unions opened**: `CarrierName` is `string` (validated at run time), and the `telephony` option of `createAgentServer`/`createRuntimeServer` takes carrier names rather than the SDK's closed union. `Logger` is an interface with the same four methods.
- Received-only handles are tagged `@sealed`.
