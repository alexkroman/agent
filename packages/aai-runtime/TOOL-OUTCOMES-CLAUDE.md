# TOOL-OUTCOMES-CLAUDE.md — a tool call's result, and what a throw becomes

A SIBLING of `packages/aai-runtime/CLAUDE.md` rather than a second package
guide, for the reason `JOURNAL-CLAUDE.md` is one: Claude Code auto-loads only
`CLAUDE.md`, so a sibling is read on demand and is the right shape for
REFERENCE. The two RULES an author or an editor of this package has to carry
around — read a tool arm by ROLE, and a fifth producer of a `role: "tool"`
message goes through `_tool-result-message.ts` — are in `CLAUDE.md`, under "A
settled tool call writes a `role: "tool"` message" and "A tool's throw is
CLASSIFIED". Everything below is the argument behind them: the four producers,
the two traps that are silent when you get them wrong, and the four guard rules
in `tool-error-policy.ts`.

The AUTHOR-facing account of the `"tool"` arm — what it is, that it does not
reach the model, and that filters by role were unaffected — is
`packages/aai/CLAUDE.md`, "`ctx.messages` has a THIRD arm, and it used to be
dead". This file is the runtime half and does not repeat it.

## One shape, four producers, and a CAP that makes them agree

`_tool-result-message.ts` exports one function, `toolResultMessage()`, and it is
the only place a `role: "tool"` message is built. That is the same move
`historyMessageOf` (`session-event-history.ts`) makes for a TRANSCRIPT, for the
same reason: a tool must see the same history under `aai dev`, in the sandbox
and after a reconnect, and four literals are four chances at a `toolName` that
is present live and absent on resume.

**The result is CAPPED there, and that is what makes the four agree.** The event
log only ever holds `capToolResult(result)` — the wire schema refuses more, see
`MAX_TOOL_RESULT_CHARS` — so a live path recording the FULL string would hand a
tool one thing during the call and a shorter thing after a resume, with nothing
reporting the difference. The model is unaffected: the whole result goes to the
provider, not through here.

`toolName` and `toolCallId` are OMITTED rather than set to `undefined`
(`omitUndefined`). Under `exactOptionalPropertyTypes` those are different types,
and a `{ toolName: undefined }` reaching a `structuredClone` or a JSON round
trip is a key that survives one and not the other.

The four call sites, and the one thing each contributes that the others do not
(`transports/pipeline-transport.ts` is listed because it is where the first
one's sink is bound, not as a fifth literal):

| Producer | Sink | What is particular to it |
| --- | --- | --- |
| `to-vercel-tools.ts` | `recordToolResult?` on the tool context | The pipeline's and the text agent's tool loop. The AI SDK hands the string straight back to the model and the assistant/`tool` pair only materializes at the END of the step, so this is the one moment the host knows a result at all |
| `transports/pipeline-transport.ts` | `history.pushToolResult(message)` | Wires that sink to the pipeline's own conversation view |
| `text-agent.ts` | a per-turn `view` array, plus `toContextMessages` | Two entries: the sink for a turn it runs, and the conversion of an INCOMING `ToolModelMessage`'s `tool-result` parts when a caller hands the agent a history |
| `session-tool-steps.ts` → `session-core.ts` | `recordToolResult` → `pushMessages` | S2S, where the provider runs the loop and the runtime only observes it |
| `session-event-history.ts` | the rebuilt `messages` array | RESUME, from the `tool.completed` events in the session's own log |

Three details in that table are decisions rather than plumbing:

- **`recordToolResult` is OPTIONAL, and two callers legitimately omit it.** A
  speculation has no history to write into (it uses `toDeclaredTools`, which has
  no `execute` at all), and `TextAgent.tools` is bound to no conversation — a
  growing view behind it would be exactly the agent-scoped accumulator
  `toolsFor` exists to avoid, leaking every call into the next one's
  `ctx.messages` for the life of the agent.
- **It is called AFTER the call and in COMPLETION order.** After, so a tool
  never reads its own result back; in completion order, because a step's calls
  run concurrently and two siblings that finished out of issue order really did
  finish that way — a later call wants what happened, not what was asked for. A
  throw skips it deliberately: `executeTool` resolves with a serialized failure
  for anything the model should see, so a rejection reaching there is the
  executor itself failing, and the model is handed nothing either.
- **The S2S arm records the EVENT's string, not the provider's.** The two differ
  on the failure path (the provider gets `serializeToolFailure(message)`), and
  the event is what a resume replays — recording the other one is precisely how
  a live history and a rebuilt one drift. The `maxSteps` refusal records `"{}"`
  for the same reason: that is what the `tool.completed` frame carried.

`session-event-history.ts` is deliberately NOT part of `historyMessageOf`. That
rule is shared with `session-core.ts`'s live dispatch, which also sees the
pipeline's `tool.completed` reports for a session whose tools already recorded
their results at the call site — appending there would record every pipeline
result twice. The live producers and the resume agree by sharing
`toolResultMessage` and the string the EVENT carries, not by sharing a dispatch.

## Trap 1: the tool-call ANCHOR indexes the client-visible list

`RestoredToolCall.afterMessageIndex` is an index into the VISIBLE messages —
the transcripts, in order, with the `"tool"` ones subtracted. That is the list
the client receives: `session-core.ts`'s `restoreHistory` filters the array to
`user`/`assistant` before it goes on the wire, because `history.restored`
renders dialogue and carries the tool calls separately.

So interleaving `"tool"` messages into that array without re-basing the anchors
slides every tool row down by the number of results ahead of it — a resumed
conversation whose "looked up your order" blocks sit under the wrong turns. **It
is silent: the frame still validates.** `historyFromEvents` keeps a `visible`
counter beside the array for exactly this, maintained rather than derived
(deriving it means filtering the whole list once per `tool.called`), and the
front trim rebases by the number of VISIBLE messages that came off rather than
by the raw count. An anchor that slid out of the window re-anchors to `-1` —
"before any message", the same sentinel the live path uses — rather than
dropping the call.

Two smaller decisions in the same walk: a call with no `tool.completed` stays
`pending`, because it may genuinely have been in flight when the process died
and reporting it as done would invent a result; and a `tool.completed` whose
`tool.called` has been trimmed off the front still contributes a message, with
no `toolName`, because the RESULT is the half a tool reads.

## Trap 2: a `"tool"` message must never be SEEDED into the model's view

`toModelMessage` (`transports/pipeline-stream.ts`) maps `user` to `user` and
**everything else to `assistant`**. Hand it a `"tool"` message and the model is
told it SAID the tool's serialized output. That is why `isLlmSeedable` exists in
`pipeline-history.ts` and why both `createPipelineHistory` and `seed()` filter
with it: the conversation view holds tool results, the LLM view holds tool-call
PAIRS, and this half arrives without the other one.

Widening `toModelMessage` is the wrong repair for the right reason. An orphan
`tool` message is rejected outright by both providers — OpenAI with "messages
with role 'tool' must be a response to a preceding message with 'tool_calls'",
Anthropic with an unexpected-`tool_result` error — so every turn for the rest of
the call would fail at the provider and the caller would hear `errorPhrase`
instead of a reply. `capLlm` heals the same shape when the front trim lands
between a call and its result; the seed filter is the other half of that
invariant.

## What a tool SAYS, and the two places the outcome string forks

`ToolDef.messages` (`aai/sdk/tool-messages.ts`) lets a tool declare its own
speech. Three of its consequences belong here, because they are about what a
settled call leaves behind rather than about what it says.

**A `role: "system"` completion forks the result string, and the RECORD keeps
the tool's own.** The hint is appended to what the MODEL is handed
(`[guidance] …`, `TOOL_SYSTEM_HINT_LABEL`), while `recordToolResult` still
writes the raw result — so `ctx.messages`, the `tool.completed` frame and a
resumed history all carry what the tool returned and not a sentence about it.
That is the same split the S2S arm already makes on its failure path, for the
same reason: the two strings have different readers, and recording the
provider's copy is how a live history and a rebuilt one drift.

**A `role: "assistant"` completion adds an assistant message NO STEP
PRODUCED.** The model is not called, so the sentence exists only in
`consumeLlmStream`'s return value, appended after the settled steps' messages.
It is a fourth producer of a message for history, and deliberately NOT a fifth
producer of a `role: "tool"` one — the tool's result is recorded by
`to-vercel-tools.ts` exactly as it always was.

**Which arm a settled call takes is decided by `isToolFailure` over the parsed
result**, not by whether `execute` threw. A throw the runtime serialized and a
`ToolFailure` the author RETURNED are the same thing to the model, so they are
the same thing here: both take `failed`. A call that rejects outright (the
author's `onError` threw) takes neither — the model is handed nothing and
`settled()` is never reached, only `dispose()`.

## Read the arm by ROLE, never by field presence

`toolName` and `toolCallId` are optional, and the absence of one is not a
signal. A completion whose `tool.called` fell off the front of the event log has
no name to give, and a transport that never recorded the call may have neither.
`m.role === "tool"` is the test; the ids are for telling two calls of the same
tool in one turn apart when they are there.

## A tool's throw is CLASSIFIED: `ToolDef.onError`

`tool-error-policy.ts` is the one place the three kinds of tool failure are told
apart, and its module doc carries the full argument. The three:

- **Expected** — `execute` RETURNS a `ToolFailure`. The author is saying "the
  model can recover from this", and it goes back as an ordinary result. That
  path never reaches this module.
- **Unexpected but recoverable** — `execute` THROWS and `onError` classifies the
  throw, returning what the model should see.
- **Unrecoverable** — `execute` throws and `onError` throws in turn. The call
  REJECTS with a `FatalToolError` and the model is handed nothing, **and the
  turn stops.** The rejection alone would not stop it: the AI SDK catches a
  rejecting `execute`, emits a `tool-error` part that `pipeline-stream-parts.ts`
  drops on its `default:` arm, and keeps stepping. `FatalToolLatch` is the side
  channel that carries the verdict out of the tool call — `to-vercel-tools.ts`
  fires it through `onFatalToolError`, and `withFatalSignal` folds its signal
  into the REQUEST signal only, never the turn's, because aborting the turn's
  own signal reads as a barge-in (interrupted tail, no drain, nothing spoken).
  The turn then ends through its ordinary failure path. **S2S is the exception
  and does not abort**: `session-tool-steps.ts` catches the rejection and hands
  the provider a serialized failure, because the provider owns the loop and the
  host has no verb to stop a turn service-side.

**A tool with no `onError` keeps the old behaviour exactly.** `resolveToolError`
answers `"default"` for it rather than synthesizing a recoverable outcome —
including which log level it uses and the fact that `onUncaught` fires — because
every tool written before the field existed depends on the throw arriving as a
result, and that is still the right answer for a flaky upstream.

**Every builder that makes a `ToolDef` forwards it**, which is what stops the
field being unreachable from the agents most likely to need it: `tool()`,
`slot.tool` / `slot.updateTool`, and `dialog.tool`. All three carry it on the
same `...rest` spread `description` rides, and each has a spec asserting nothing
eats it. On a GATED tool there is one thing extra to know, and it is on
`DialogToolDef.onError`: the handler runs after the gated call has unwound,
which is past `send`/`sendFrom`, so what it returns reaches the model as a bare
failure or string rather than inside a `DialogToolResult`, and the dialog stays
where it was — the same answer a returned `ToolFailure` gets, for the same
reason.

### The four guard rules, and the mistake each one prevents

1. **A CANCELLED call is not a tool fault.** When the call was already aborted —
   a barge-in, a reset, `stop()`, or the per-call deadline — the rejection
   describes the runtime, not the tool, so `onError` is not consulted at all.
   Otherwise every handler would have to filter aborts before it could classify
   anything, and a handler that forgot would turn an ordinary interruption into
   a fatal failure. **The DEADLINE is the one the abort signal cannot report**:
   `pTimeout` settles the await without touching the per-call controller, so
   `executeToolCall` mints its own `TimeoutError` up front and the catch
   recognises that instance BY IDENTITY. Not `instanceof` — a tool running its
   own `pTimeout` inside `execute` throws the same class, and that one is the
   tool's own failure and must still reach the handler. While the identity test
   was missing, a blanket-rethrow `onError` (`topic-briefing-agent` ships one,
   and it is the natural way to write one) turned every transient tool timeout
   into a `FatalToolError` that killed the turn.
2. **`undefined` means "not handled".** A handler written to log and nothing
   else returns nothing, and stringifying that would hand the model the string
   `null` as the tool's answer. It falls through to the default instead.
3. **A thenable is refused, FATALLY.** The handler is synchronous by contract —
   there is no budget left to await in, since the deadline may already have
   passed — so an `async` handler's promise would be serialized as `{}` and the
   model would read an empty object as the result. The refusal names the fix
   ("do the awaiting inside execute"). It is the same rule `slot.updateTool`
   applies to a mutator body, and it fails loudly for the same reason.
4. **A handler that throws for its OWN reason is fatal too.** A `TypeError`
   inside `onError` is not a classification, and there is nothing left to ask;
   treating it as recoverable would send the model a message about the handler
   rather than about the tool.

`FatalToolError` carries the original throw as `cause` and adds the tool's name,
which the raw error never has — so a log or a test can still reach the
`TypeError` (or the missing-credential error) the author decided about.
`isFatalToolError` is an `instanceof` check and deliberately so: every producer
and every consumer is inside this package, and a tool body runs in the same
realm as the executor that called it (the guest harness bundles both).

The RECOVERED arm reports nothing. No `onUncaught`, no warn line, and the value
travels the path a success takes — because the author classifying a throw as
recoverable makes it the same kind of answer a RETURNED `ToolFailure` is.
Installing an `onError` that answers is therefore also how an author silences a
throw they already understand. The fatal arm logs at ERROR rather than warn: the
reply is losing this call outright, and the only trace the model leaves behind
is that it never got a result.

### `onUncaught` widened, and `SessionEvent.fatal` deliberately did not

`onUncaught` is `(message: string, info: { readonly fatal: boolean })`. A second
PARAMETER rather than a second callback, so a reporter that does not care —
`text-agent.ts`'s `toolFault`, which takes only the message — stays assignable
and needed no change.

**`info.fatal` is not the wire's `fatal`.** `runtime-tools.ts` emits
`error.reported` with `code: "tool"` and `fatal: false` for BOTH arms, and that
is the decision to keep: in this codebase a `fatal: true` error frame means the
SESSION is over, and `aai-ui` answers one by releasing the microphone and ending
the call. Neither arm of a tool failure is that. What `info.fatal` distinguishes
is what the MODEL got: `false` means it got the serialized failure, `true` means
it got nothing, so whoever is watching the error frame is the only one who will
ever hear about it.
