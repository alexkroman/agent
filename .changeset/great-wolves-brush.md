---
"@alexkroman1/aai": major
"@alexkroman1/aai-ui": major
---

Remove the per-agent sync client transport and simplify the app model to two
kinds: **agents** (WebSocket chat/voice sessions) and **workflows** (one-shot
`POST /sync` runs).

Breaking changes:

- `agent({ transport })` is removed. The default browser client always uses
  the WebSocket session for agents; workflows automatically get the run
  surface. `POST /sync` remains available as a programmatic API for pipeline
  agents.
- `agent({ kind })` is removed — `workflow()` is the only way to define a
  workflow.
- `ClientTransport` and `assertClientTransport` are removed; `assertAgentKind`
  no longer takes a transport argument.
- `GET /client-config` no longer returns a `transport` field (`kind` decides
  the surface); older responses still parse — the extra field is ignored.
- aai-ui: `SyncChatView`, `startSyncMicrophone`, `createUtteranceDetector`,
  and their option types are removed. `createSyncSession` and
  `createPttRecorder` stay (they power `WorkflowView`). The chat shell now
  uses the server-declared agent name when `client({ name })` is not passed.
- Templates `sync-voice` and `push-to-talk-translator` are removed.
- The `@alexkroman1/aai/workflow` subpath (pattern combinators) is renamed to
  `@alexkroman1/aai/patterns`; the old subpath is removed.
