---
"@alexkroman1/aai": minor
"aai-server": patch
---

Shrink the shapes on the SDK's contracted surface that keep producing breaking
changes. Breaking:

- **Every exported object type carries a direction**: options, config and
  declarations are `@input`; contexts, results, handles and testing records are
  `@sealed`.
- **Toolsets are plumbing**: `Toolset`, `ToolsetEntry`, `ToolExecutor` and
  `ToolSource` moved to `@alexkroman1/aai/manifest`, and `AgentDef.toolsets` is
  gone from the public type (`ResolvedAgentDef` on `/manifest` carries it).
  `ToolBearingAgent` no longer names `toolsets`.
- **Implementation budgets moved to `/internal`** (or `/host-internal`):
  `TRANSCRIBE_SYNC_ENDPOINT`, `TRANSCRIBE_*_TIMEOUT_MS`,
  `TRANSCRIBE_WINDOW_BYTES`, `STEP_SPEAK_TIMEOUT_MS`, `DEFAULT_CALL_*`,
  `DEFAULT_CLIENT_ACK_TIMEOUT_MS`, `DEFAULT_CLIENT_RETRY_MS`,
  `CHANNEL_POST_TIMEOUT_MS`, `DEEPGRAM_DEFAULT_ENDPOINTING_MS`,
  `MCP_TOOL_NAME_MAX`, and the coding tools' `BASH_TIMEOUT_*`, `GLOB_LIMIT`,
  `READ_LIMIT`, `CODING_TOOL_DESCRIPTIONS`. Constants that stay public are typed
  as their primitive.
- **The session event vocabulary is declared, not inferred from zod**:
  `SessionEventMap` is written out; `SessionEventSchema` moved to
  `@alexkroman1/aai/protocol`, typed `z.ZodType<SessionEvent>`. A `"*"` handler
  receives the open `AnySessionEvent` envelope. `SessionErrorCode`,
  `AgentTranscriptRecovery` and an event's `stage`/`limit`/`direction` are open
  (`| (string & {})`). `EventMapOf` and `SessionEventTypeList` are removed;
  `SESSION_SOURCED_EVENT_TYPES` moved to `/internal`. `SessionEventMeta`,
  `RestoredToolCall` and `ClientConfigResponse` are declared types, and their
  schemas are typed `z.ZodType<T>`.
- **Catalogs are plain arrays**: `ASSEMBLYAI_TTS_VOICES` is
  `readonly AssemblyAITtsVoice[]`, `TRANSCRIBE_MODELS` is `readonly string[]`.
- **Closed unions an author receives are open**: `PlacedCallStatus`,
  `ToolRefusalReason`, `Message.role`, `ClientUnreachableReason`,
  `SpeechOutcome`, `ClientRunStatus`, `FfmpegFailureKind`,
  `ClientTranscriptMessage.role`, `StubTranscribeLeg`, `FetchRouteHit.outcome`
  and `.via`.
- **`dialog()` no longer names XState types**: `Dialog<E>` is generic over its
  events only, `Dialog.machine` is `unknown`, and the machine overload takes the
  SDK-owned structural `DialogMachine`.
- **`SlotStore.write(key, value, { durable })`** replaces the positional boolean
  (durable by default); `createSlotStore()` joins `/testing`.
- **`MetricsSample` is its own `@input` interface** rather than an `Omit` of the
  event; `MetricsCollector.collect` takes the event or a sample.
- **`routeResponse(status, body, { headers })`** can set response headers.
- `RunSnapshotOverrides` is derived from `WorkflowRunSnapshot`;
  `ValidatedRouteRequest` is `RouteRequest<Body>`;
  `AssemblyAISttOptions.languages` is `readonly string[]`.
- The `testing` and `agent` capabilities were split for size (`testing-steps`,
  `testing-network`, `testing-workflow`, `testing-client`, `testing-deploy`;
  `agent-routes`, `agent-mcp`, `agent-session`); the subpaths are unchanged.
