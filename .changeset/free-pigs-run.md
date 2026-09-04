---
"@alexkroman1/aai": minor
---

Rename public API parameters for consistency: the options bag is `options` everywhere it was `opts`, and a dozen per-signature fixes an audit of every parameter in every `etc/*.api.md` report found — `WorkflowClient.get`/`EvalWorkflows.settle` take `workflow` rather than `of`, `stepTranscribePoll` takes `transcriptId` rather than an `id` its neighbour spells `uploadId`, `registerChannelHandler` takes `handler` rather than `kind`, `mapConcurrent` takes `width`, `slugifyName` takes `(name, maxLength)`, `responseErrorMessage` takes `response`, `createRunSnapshot` takes `overrides`, `decodeWorkspaceText` takes `bytes`, `LogFn` and `onToolResult` take `message`, `ClientSink.event` takes `event`, `ServerSession.command` takes `command`, and the eval mode gates take `hostEnv`. Parameters are positional, so no call site changes.
