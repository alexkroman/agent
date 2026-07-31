# @alexkroman1/aai-ui

## 3.0.0

### Patch Changes

- Updated dependencies [bb02ded]
- Updated dependencies [2b395b3]
- Updated dependencies [d917095]
- Updated dependencies [08f2937]
- Updated dependencies [bb02ded]
- Updated dependencies [2236275]
- Updated dependencies [2236275]
- Updated dependencies [2236275]
- Updated dependencies [eb9f662]
- Updated dependencies [6cac47f]
  - @alexkroman1/aai@3.0.0

## 2.0.0

### Major Changes

- 6047231: Remove the per-agent sync client transport and simplify the app model to two
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

### Minor Changes

- 41b5dad: Capture microphone audio with auto gain control, noise suppression, and voice isolation off (echo cancellation stays on), shared across every capture path as the exported VOICE_CAPTURE_CONSTRAINTS.

### Patch Changes

- Updated dependencies [377ecd3]
- Updated dependencies [e17fdc4]
- Updated dependencies [4051d7a]
- Updated dependencies [6047231]
- Updated dependencies [7fc476d]
- Updated dependencies [ed4f2e7]
- Updated dependencies [89a032d]
- Updated dependencies [158d5d5]
  - @alexkroman1/aai@2.0.0

## 1.16.0

### Patch Changes

- da2662a: Fix the sync-mode microphone going permanently deaf on its first flush: the capture worklet sized its next batch buffer from a view whose ArrayBuffer had just been transferred (and so detached to length 0), which wedged the audio render thread in an infinite loop posting empty chunks. No utterance was ever endpointed, so a sync agent never sent a turn. Also bound the sync session's replayed history to the server's own window and release the microphone when the view unmounts mid-startup.
- Updated dependencies [c261662]
- Updated dependencies [5ea4cba]
  - @alexkroman1/aai@1.16.0

## 1.15.0

### Patch Changes

- Updated dependencies [9ffec74]
- Updated dependencies [f87ff84]
  - @alexkroman1/aai@1.15.0

## 1.14.0

### Minor Changes

- f389673: The default sync client is now a hands-free voice agent: `SyncChatView`
  opens the microphone once via `startSyncMicrophone` and the client-side
  energy VAD endpoints each utterance automatically — no push-to-talk button.
  One toggle starts and ends the conversation; `createPttRecorder` remains
  exported for custom hold-to-record clients.

### Patch Changes

- Updated dependencies [1c57e05]
- Updated dependencies [4469856]
  - @alexkroman1/aai@1.14.0

## 1.13.1

### Patch Changes

- Updated dependencies [f662e45]
  - @alexkroman1/aai@1.13.1

## 1.13.0

### Minor Changes

- cbb8b71: Fix sync-mode microphone failing with "Unable to load a worklet's module": the capture worklet now loads from a blob URL (allowed by the agent page CSP) instead of a data URI (blocked). The export is renamed CAPTURE_WORKLET_DATA_URI -> CAPTURE_WORKLET_MODULE_URL, and the hold-to-record pipeline is now available as createPttRecorder. SyncChatView is rebuilt as a push-to-talk console in the same visual design as the WebSocket ChatView (logo + live-status eyebrow header, raised output card, design-system button): recording runs while the button is held, each release sends one POST /sync turn, and the view shows the transcript, the reply, and the endpoint the utterance is sent to.

### Patch Changes

- Updated dependencies [2b3c0e0]
  - @alexkroman1/aai@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [83be5b2]
- Updated dependencies [bd4405a]
  - @alexkroman1/aai@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [310eedb]
- Updated dependencies [a6bb262]
- Updated dependencies [d72c86b]
- Updated dependencies [163cb6f]
  - @alexkroman1/aai@1.11.0

## 1.10.0

### Minor Changes

- c147d23: aai-ui hardening from a full package review: fix a reconnect race that could double-run audio init (two live mics) by invalidating in-flight init on every retry; make mic denial on the text-only record button non-fatal instead of bricking the session; release the microphone on fatal server errors; keep straggler audio frames from flipping an errored session to speaking; recover error state to listening (not disconnected) on a live socket; honor pre-aborted AbortSignals in connect(); guard cancel() when disconnected; keep running=true when reset() reconnects; preserve the last ~100ms of speech on close via a capture-worklet stop ack; replace the stale-stop flag with reason-tagged playback stops so a barge-in at turn completion can't settle the next turn early; fire useToolCallStart for tool calls whose start/done frames coalesce into one commit; export Controls; widen the React peer range to ^19.0.0; bound server-sent config sample rates and transcript/error message sizes in the protocol schemas; document session IDs as sensitive.

### Patch Changes

- Updated dependencies [3fe3eff]
- Updated dependencies [5ddca41]
- Updated dependencies [133642f]
- Updated dependencies [fec3fa2]
- Updated dependencies [678556f]
- Updated dependencies [8a5ee8f]
  - @alexkroman1/aai@1.10.0

## 1.9.2

### Patch Changes

- @alexkroman1/aai@1.9.2

## 1.9.1

### Patch Changes

- Updated dependencies [713025a]
  - @alexkroman1/aai@1.9.1

## 1.9.0

### Minor Changes

- d718fe9: Redesign the default UI to the AssemblyAI design system (website refresh): warm cream default theme with deep-indigo primary, editorial serif headings, outlined eyebrow labels, rectangular ALL-CAPS buttons, the AssemblyAI wordmark, labeled agent prose with indigo-tinted user bubbles, and console-style expandable TOOL rows. The theme remains fully overridable via client({ theme }) and custom client.tsx.
- d718fe9: Show the session's UI and API URLs as a labeled pair (SessionUrlChips) instead of the API endpoint alone.

### Patch Changes

- 968c917: Internal cleanup of aai-ui: shared tint constants and JSON/truncate helpers, consolidated tool-call hook scaffolding, single-buffer mic batching, parallel audio setup, reusable resample buffer, and removal of the unused playback-progress machinery
- d718fe9: Default agent UI: paint html/body from the theme background so a cream theme no longer sits in a black letterbox on wide viewports.
- Updated dependencies [0235618]
- Updated dependencies [4758dfc]
- Updated dependencies [0f72bef]
- Updated dependencies [bc62b75]
- Updated dependencies [7e67c24]
- Updated dependencies [8817f3f]
- Updated dependencies [394867e]
- Updated dependencies [8004ff8]
- Updated dependencies [262f1e7]
- Updated dependencies [257a372]
- Updated dependencies [0bdb115]
- Updated dependencies [578a840]
- Updated dependencies [c5a5351]
- Updated dependencies [0235618]
- Updated dependencies [0235618]
- Updated dependencies [a252842]
- Updated dependencies [bbb9d73]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [a413caf]
- Updated dependencies [d718fe9]
- Updated dependencies [2898f21]
- Updated dependencies [882e7d9]
- Updated dependencies [e2ee4fd]
- Updated dependencies [9750db7]
- Updated dependencies [0d024e0]
- Updated dependencies [cb2821c]
- Updated dependencies [9aed108]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [ab38293]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [860bb7d]
- Updated dependencies [82f8253]
- Updated dependencies [d718fe9]
- Updated dependencies [7240ce5]
- Updated dependencies [f22b0f4]
- Updated dependencies [0bb1a20]
- Updated dependencies [7d4a193]
- Updated dependencies [5bf4d41]
- Updated dependencies [ad295be]
- Updated dependencies [d22d9f8]
- Updated dependencies [8f2093b]
- Updated dependencies [296a874]
- Updated dependencies [752af3d]
- Updated dependencies [38f02fa]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [82f8253]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [2fd1078]
- Updated dependencies [711edeb]
- Updated dependencies [fd5a54e]
- Updated dependencies [a413caf]
- Updated dependencies [3db093f]
- Updated dependencies [0c57887]
- Updated dependencies [79e51cb]
- Updated dependencies [d718fe9]
- Updated dependencies [0235618]
- Updated dependencies [cf56703]
- Updated dependencies [115a88e]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
  - @alexkroman1/aai@1.9.0

## 1.8.3

### Patch Changes

- 6b61892: Fix start-of-greeting audio cutoff in S2S mode. The client used to silently drop audio chunks that arrived from the server before `getUserMedia` and worklet registration completed. Early chunks are now buffered and replayed in order once playback is ready.
  - @alexkroman1/aai@1.8.3

## 1.8.2

### Patch Changes

- Updated dependencies [bb06b4e]
  - @alexkroman1/aai@1.8.2

## 1.8.1

### Patch Changes

- Updated dependencies [ba8effb]
- Updated dependencies [f4cc5ef]
  - @alexkroman1/aai@1.8.1

## 1.8.0

### Patch Changes

- Updated dependencies [a7384ad]
- Updated dependencies [cc013df]
  - @alexkroman1/aai@1.8.0

## 1.7.1

### Patch Changes

- Updated dependencies [3c711da]
  - @alexkroman1/aai@1.7.1

## 1.7.0

### Patch Changes

- Updated dependencies [07b4263]
- Updated dependencies [b79855d]
  - @alexkroman1/aai@1.7.0

## 1.6.1

### Patch Changes

- Updated dependencies [da84b47]
  - @alexkroman1/aai@1.6.1

## 1.6.0

### Patch Changes

- Updated dependencies [149786b]
- Updated dependencies [fd3a167]
- Updated dependencies [c8707d6]
- Updated dependencies [877348c]
  - @alexkroman1/aai@1.6.0

## 1.5.1

### Patch Changes

- Updated dependencies [fbb3816]
  - @alexkroman1/aai@1.5.1

## 1.5.0

### Minor Changes

- 58c5c75: Consolidate session.ts + pipeline-session.ts into a unified SessionCore with two transport strategies (S2S, pipeline). Switch connectS2s to typed callbacks (removing the nanoevents-backed S2sHandle emitter) and flatten client→server→provider dispatch from four layers to two. Wire format is JSON text events + raw PCM16 binary audio frames — the existing public protocol is unchanged. Adds Deepgram as a pipeline-mode STT option and Rime as a pipeline-mode TTS option.

### Patch Changes

- Updated dependencies [58c5c75]
- Updated dependencies [868b85e]
- Updated dependencies [a361363]
- Updated dependencies [58c5c75]
- Updated dependencies [58c5c75]
  - @alexkroman1/aai@1.5.0

## 1.4.5

### Patch Changes

- Updated dependencies [07dc8fb]
- Updated dependencies [2ca5d1f]
  - @alexkroman1/aai@1.4.5

## 1.4.4

### Patch Changes

- 9bd219f: Refine mic constraints: drop no-op sampleRate, add voiceIsolation + default deviceId, remove misleading AEC comment.
- Updated dependencies [74341a4]
  - @alexkroman1/aai@1.4.4

## 1.4.3

### Patch Changes

- Updated dependencies [62d5a99]
  - @alexkroman1/aai@1.4.3

## 1.4.2

### Patch Changes

- Updated dependencies [f877a6f]
  - @alexkroman1/aai@1.4.2

## 1.4.1

### Patch Changes

- Updated dependencies [63de397]
  - @alexkroman1/aai@1.4.1

## 1.4.0

### Patch Changes

- @alexkroman1/aai@1.4.0

## 1.3.2

### Patch Changes

- @alexkroman1/aai@1.3.2

## 1.3.1

### Patch Changes

- Updated dependencies [5a9f3d5]
  - @alexkroman1/aai@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies [c95212a]
- Updated dependencies [f1a9764]
- Updated dependencies [f1a9764]
- Updated dependencies [0231114]
- Updated dependencies [8a79282]
- Updated dependencies [f1a9764]
  - @alexkroman1/aai@1.3.0

## 1.2.3

### Patch Changes

- 6a44b5b: Republish after the 1.2.2 release workflow failed (broken lockfile under `pnpm/action-setup@v6`). Also: `aai init` now skips deploy when `pnpm install` fails, so users see the real install error instead of a cryptic Rolldown `@alexkroman1/aai` resolution failure.
- Updated dependencies [6a44b5b]
  - @alexkroman1/aai@1.2.3

## 1.2.2

### Patch Changes

- Updated dependencies [534122c]
  - @alexkroman1/aai@1.2.2

## 1.2.1

### Patch Changes

- Updated dependencies [7af69b8]
  - @alexkroman1/aai@1.2.1

## 1.2.0

### Patch Changes

- Updated dependencies [ed0dfbb]
- Updated dependencies [231ebc1]
  - @alexkroman1/aai@1.2.0

## 1.1.0

### Minor Changes

- 5cda7c5: Add ctx.send for real-time tool-to-client events

  Tools can now push arbitrary events to the browser client via `ctx.send(event, data)`. Events flow over the existing WebSocket as `custom_event` messages. The new `useEvent` React hook subscribes to named events. Migrated solo-rpg, pizza-ordering, dispatch-center, and night-owl templates from `useToolResult` to `ctx.send` + `useEvent`.

### Patch Changes

- f342260: Show AAI ANSI art logo on default start screen
- Updated dependencies [5cda7c5]
- Updated dependencies [41fab1a]
  - @alexkroman1/aai@1.1.0

## 1.0.6

### Patch Changes

- @alexkroman1/aai@1.0.6

## 1.0.5

### Patch Changes

- @alexkroman1/aai@1.0.5

## 1.0.4

### Patch Changes

- @alexkroman1/aai@1.0.4

## 1.0.3

### Patch Changes

- @alexkroman1/aai@1.0.3

## 1.0.2

### Patch Changes

- a3d3835: Force all libraries and the server to publish/deploy after the 1.0.1
  release failure. Restores the `@alexkroman1/` scope on publishable
  packages so npm accepts the publish, and bumps `aai-server` to trigger
  the Fly.io deploy job in the release workflow.
- Updated dependencies [76d25d4]
- Updated dependencies [a3d3835]
  - @alexkroman1/aai@1.0.2

## 1.0.1

### Patch Changes

- b4ff42e: Redeploy aai-server and refresh client/CLI/SDK releases
- Updated dependencies [5517333]
- Updated dependencies [5d55c12]
- Updated dependencies [b4ff42e]
  - aai@1.0.1

## 1.0.0

### Major Changes

- 7669733: Migrate aai-ui from Preact to React 19 with simplified API: useSession, useTheme, useToolResult hooks + two-tier defineClient
- 486fb23: Simplify aai-ui package: remove Reactive<T> abstraction, hardcode Preact signals, inline micro-components, merge createSessionControls into createVoiceSession, remove ./session subpath export.

  BREAKING CHANGES:

  - `createSessionControls` removed (merged into `createVoiceSession`)
  - `SessionSignals` type removed
  - `Reactive<T>` type removed
  - `useSession()` return shape changed (returns `VoiceSession` directly)
  - `VoiceSessionOptions` no longer accepts `reactiveFactory` or `batch`
  - `./session` subpath export removed
  - Components removed from exports: `ErrorBanner`, `StateIndicator`, `ThinkingIndicator`, `Transcript`, `MessageBubble`
  - `ButtonVariant`, `ButtonSize` types removed from exports
  - `ClientHandle.signals` removed (use `ClientHandle.session` directly)

### Minor Changes

- 8ecb7d1: Add protocol compat fixtures and harden wire format for rolling upgrades
- 9211c65: Add default aai-ui client served by the server when no custom client is deployed. Remove zod externalization from the worker bundler — zod 4 works natively in Deno sandboxes. Update S2S API endpoint and fix load test event handling.

### Patch Changes

- f6e7a5c: BREAKING: Align SDK naming with S2S API

  - `instructions` → `systemPrompt` in AgentOptions/AgentDef
  - `DEFAULT_INSTRUCTIONS` → `DEFAULT_SYSTEM_PROMPT`
  - `onTurn` → `onUserTranscript` hook
  - Protocol events renamed: `transcript` → `user_transcript_delta`, `turn` → `user_transcript`, `chat` → `agent_transcript`, `chat_delta` → `agent_transcript_delta`, `tts_done` → `reply_done`, `tool_call_start` → `tool_call`

- Updated dependencies [8ecb7d1]
- Updated dependencies [3bd18a9]
- Updated dependencies [befca9a]
- Updated dependencies [9211c65]
- Updated dependencies [b9b5c02]
- Updated dependencies [99db30d]
- Updated dependencies [5cc9550]
- Updated dependencies [4c1cd20]
- Updated dependencies [ab98c61]
- Updated dependencies [837e34f]
- Updated dependencies [f6e7a5c]
- Updated dependencies [7669733]
- Updated dependencies [14d0653]
- Updated dependencies [9d2141b]
- Updated dependencies [05f8759]
- Updated dependencies [1678546]
- Updated dependencies [5fd5cb3]
- Updated dependencies [64d83b6]
- Updated dependencies [6d3ec72]
  - aai@1.0.0

## 0.12.3

### Patch Changes

- 4ebd7b6: Standardize file and directory naming to idiomatic kebab-case conventions

  - Add ls-lint for file naming enforcement
  - Drop underscore prefix from internal files in aai-server (e.g. `_schemas.ts` → `schemas.ts`)
  - Rename `_components` → `components` and `__fixtures__` → `fixtures` in aai-ui
  - Rename `__fixtures__` → `fixtures` in aai/host
  - Flatten aai-server by removing `src/` directory

- 68f4d84: Make more cross platform
- Updated dependencies [4ebd7b6]
- Updated dependencies [68f4d84]
  - @alexkroman1/aai@0.12.3

## 0.12.2

### Patch Changes

- @alexkroman1/aai@0.12.2

## 0.12.1

### Patch Changes

- f4762a1: Externalize zod from agent bundles, remove storage cache, improve CI reliability
- Updated dependencies [f4762a1]
  - @alexkroman1/aai@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [99e62c3]
  - @alexkroman1/aai@0.12.0

## 0.11.1

### Patch Changes

- Updated dependencies [c25ee7e]
  - @alexkroman1/aai@0.11.1

## 0.11.0

### Patch Changes

- 491ec37: CLI overhaul: remove generate command, unify output style, template descriptions

  - Remove `generate` and `run` commands and AI SDK dependencies
  - Unify CLI output to use @clack/prompts style consistently
  - Add template descriptions shown as hints in `aai init` select prompt
  - Fix deploy slug mismatch between bundle and deploy steps
  - Clean deploy error messages (no stack traces)
  - Add `@alexkroman1/aai-cli` to scaffold devDependencies
  - Remove fly.toml from scaffold
  - Use cyanBright for all URLs in CLI output
  - Remove eventsource-parser patch
  - Add link-workspace-packages to .npmrc
  - Fix Dockerfile: run esbuild install script, remove patches references

- Updated dependencies [491ec37]
  - @alexkroman1/aai@0.11.0

## 0.10.4

### Patch Changes

- 6f6a43e: Harden platform security and refactor to @hono/zod-validator

  - Fix crash in sandbox-network when host.internal hit without handler
  - Add Zod validation to KV bridge (isolate→host) replacing raw JSON.parse
  - Refactor deploy, secret, and KV handlers to use @hono/zod-validator middleware
  - Fix type errors in \_harness-runtime.ts and sandbox.ts
  - Remove factory.ts, inline into orchestrator
  - Add 185 new security tests for cross-agent isolation, SSRF, and trust boundaries

- Updated dependencies [6f6a43e]
  - @alexkroman1/aai@0.10.4

## 0.10.3

### Patch Changes

- Updated dependencies [8d5f616]
  - @alexkroman1/aai@0.10.3

## 0.10.2

### Patch Changes

- Updated dependencies [9de059e]
- Updated dependencies [1397f37]
  - @alexkroman1/aai@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies [aa23a1c]
  - @alexkroman1/aai@0.10.1

## 0.10.0

### Minor Changes

- Replace LanceDB with sqlite-vec for vector storage, add `generate` CLI command, extract templates to giget, local dev mode improvements, auth cleanup, and graceful shutdown fixes

### Patch Changes

- Updated dependencies
  - @alexkroman1/aai@0.10.0

## 0.9.4

### Patch Changes

- Release all packages with version increment
- Updated dependencies
  - @alexkroman1/aai@0.9.4

## 0.9.3

### Patch Changes

- @alexkroman1/aai@0.9.3

## 0.9.2

### Patch Changes

- @alexkroman1/aai@0.9.2

## 0.9.1

### Patch Changes

- Update
- Updated dependencies
  - @alexkroman1/aai@0.9.1

## 0.9.0

### Minor Changes

- Updated toolchain

### Patch Changes

- Updated dependencies
  - @alexkroman1/aai@0.9.0
