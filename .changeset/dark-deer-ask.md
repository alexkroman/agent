---
"@alexkroman1/aai": major
---

Rename 63 exports for consistency across the published surface.

Every rename is mechanical — no type, signature, behaviour or layering change — but they are breaking, so the old names are gone rather than aliased. What moved, and why:

- **Test doubles speak one word.** The four test-facing subpaths used `Stub` (50 names), `Fake` (7) and `Mock` (2) for one idea, and the split was not by role: `StubSpeech` doubles the `stepSpeak` step while `FakeSpeech` doubled the STT/TTS providers, so the shared word was the ambiguous half and the distinguishing word meant nothing. `FakeSpeech` and its family are now `StubSpeechProviders`, `StubSttSession`, `StubTtsSession`, `createStubSttOpener`, `createStubTtsOpener`, `installStubSpeechProviders`, `STUB_SPEECH_API_KEY_ENV`; `mockWorkflows`/`MockWorkflowsOptions` become `installStubWorkflows`/`StubWorkflowsOptions`, matching the six `installStub*` siblings in the same subpath.
- **`SessionCore` meant two opposite things.** `aai-runtime` exported the server session, `aai-ui` the browser session, and both were declared in a file called `session-core-types.ts`. They are `ServerSession` and `BrowserSession` (`createSessionCore` -> `createBrowserSession`).
- **`client()` and `page()` mount, they do not declare.** Unlike `agent()`, `tool()` and `workflow()`, they resolve a DOM container, render React and return a live handle. Now `mountClient()` and `mountPage()`; the `Config` and `Handle` types keep their names.
- **`/step` prefixes its own vocabulary.** `emit`, `report`, `readUpload`, `writeUpload`, `uploadInfo` and `requireCompleteUpload` take the `step` prefix the subpath's other eighteen exports carry. `mapConcurrent`, `isTransientStatus`, `retryAfter`, `encodeWav` and `wavHeader` stay bare deliberately — they are reached from tool bodies and specs, not only from steps.
- **`/step-errors` settles on one suffix.** Six `*Classified` plus the odd `stepFetchOk` all become `*OrFail`, naming the retry verdict a caller gets rather than an internal act.
- **Channels say handler where they mean handler.** `ChannelKind` was the handler object while every other `*_KIND` in the repo is a string discriminant: now `ChannelHandler`, `SLACK_CHANNEL_HANDLER`, `registerChannelHandler`. `registeredChannelKinds` -> `registeredChannelKindNames` says what it returns, and `channelAdvice`/`slackChannelAdvice` -> `explainChannelFailure`/`explainSlackChannelFailure` name the failure they explain.
- **Suffix outliers.** `UploadPartsSettings` -> `UploadPartsOptions` (the only `Settings` among 105 options bags) and `WorkflowCtx` -> `WorkflowContext` (the only `Ctx` among eight context types, and the one an author writes beside `ToolContext`), with `createWorkflowContext`, `WorkflowContextOptions`, `WorkflowContextRecorder`, `WORKFLOW_CONTEXT_NOW`.
- **Types named as verbs or events.** `FileRead` -> `FileReadMode`, `SkipGreeting` -> `SkipGreetingOption`, `UploadParallel` -> `UploadParallelOption`.
- **Server factories say which layer.** `createServer` -> `createRuntimeServer`, so the generic name stops reading as the default when `createAgentServer` is the front door; `ServerOptions` -> `RuntimeServerOptions`, and `PassthroughServerOptions` -> `SharedServerOptions`, matching `SharedAgentParams`.
- **Storage nouns.** `UploadBlobs` -> `UploadBackend` and its factories, matching the `SessionStateBackend` it sits beside; `UploadStore` keeps its name as the facade.
- **Two functions that differed only in their argument.** `callsIn` and `toolCallsIn` both returned `EvalToolCall[]`; they are `toolCallsInTurns` and `toolCallsInEvents`.
- **Casing.** `S2SConfig` -> `S2sConfig` (the lone `S2S` among seven `S2s`), and the provider factories now derive from their Pascal spelling instead of being exempted in `konsistent.json`: `openaiLlm` -> `openAILlm`, `openaiS2s` -> `openAIS2s`, `openrouterLlm` -> `openRouterLlm`, `xaiLlm` -> `xAILlm`, `XaiLlmOptions` -> `XAILlmOptions`.
- **`make*` -> `create*`.** `makeSttError`/`makeTtsError` were the only two `make*` factories among forty `create*`.
- **`decliningRuntime` -> `rejectingRuntime`**, pairing with the existing `rejectingWorkflows`.

Nineteen capability epochs are dropped and six retained; each dropped epoch records its reason in the tree.
