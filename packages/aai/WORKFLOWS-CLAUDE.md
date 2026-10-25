---
summary: >-
  Workflow apps and the workflow HTTP API from the authoring side: `lastLine`,
  the input/output readings and the TS7022 escapes, `publicWebhookUrl`, the
  run-lifecycle helpers (`poll`, `report`, signals, `onFailure`, `sayOnClient`,
  `transcribeUploadDurably`), the `workflow_*` builtins
read_when: >-
  writing or changing a `workflow()` body, a `*_status` tool, a workflow app, or
  one of the composed run-lifecycle helpers on `WorkflowContext`
---

# packages/aai — workflow authoring

The authoring-side rules for `workflow()`, `workflowApp()` and the composed
helpers on `WorkflowContext`. Moved here from `src/sdk/CLAUDE.md` when that
guide crossed its cap; the engine half is `packages/aai-runtime/src/workflow/`.

`mode: "workflow-app"` is a page over the workflow API, declared with
`workflowApp()` (`define.ts`), whose member has none of the fields it cannot
use; `GET /client-config` reports it as `page: "static"`. Author-facing half:
"Workflow apps" in `packages/aai-ui/src/CLAUDE.md`.

- **Read a run's newest line with `ctx.workflows.lastLine(runId)`, never
  `streamTail` + `stream` by hand** — a progress channel is never closed, so
  `stream` on an empty run waits forever. A spec stubs `lastLine` directly.
- **A body takes `WorkflowInputOf<typeof def>`; a `*_status` tool holds
  `WorkflowRunOf<typeof def>`.** A body declaring a wider input compiles
  silently (contravariance). The obvious spelling hits `TS7022`; name the schema
  const and ANNOTATE the def (`packages/aai-templates/FFMPEG-CLAUDE.md`). A
  declared `output` schema is what `WorkflowOutputOf` reads (`workflow.ts`).

## A callback URL comes from `publicWebhookUrl`

`ctx.workflows.publicWebhookUrl(token)` is what a tool hands an external
service; the token is the one the body passed `ctx.waitFor`. A body or step uses
`stepWebhookUrl(token)` (`step-webhook.ts`, `/step`) — a `Symbol.for` slot a
host fills. One claim per run; properties in
`packages/aai-runtime/src/workflow/CLAUDE.md`.

`start(def, input, { key, notify })` makes the starting session take an
unprompted, interruptible turn when the run lands (`Transport.injectTurn`,
pipeline only).

## Run lifecycle helpers: each is COMPOSED, and each has one owner

- **`StartOptions.dedupeKey` DERIVES the run id** (`aai-runtime`'s
  `workflow/dedupe-run-id.ts`): every journal already refuses a second
  `createRun` for one id, so two racing starts meet at one insert and no store
  grew a table. Dedupes against a run in ANY status until it expires.
- **`findByKey`/`cancelAll` are `find`/`cancel` composed**
  (`workflow/client-keyed.ts`) — the key index is `(workflow, key)` in all three
  backends, the platform's table included, so a cross-workflow read is N lookups
  merged once, not a new query.
- **`ctx.poll` is `ctx.step` + `ctx.sleep` under one name**
  (`workflow-poll.ts`), so it journals exactly the hand-written loop's keys; its
  budget is a COUNT (`floor(maxMs / everyMs)` sleeps), replay-safe without a
  `ctx.now` per round. Every `WorkflowContext` (engine, `/testing` recorder,
  eval) delegates to it. `stepPollUntil` is the in-step, wall-clock, non-durable
  sibling.
- **`workflow({ onFailure })` runs in the ENGINE, not a body `catch`**
  (`workflow-failure.ts`, runtime `replay/failure-hook.ts`): only for a throw
  classified as the run failing (never a suspend, cancel, journal failure or
  divergence refusal), as the journaled step `onFailure`, before the failure is
  recorded. Not run for an `output`-schema failure (decided after the walk).
- **`stepSayOnClient`** = `stepSpeak` + `stepNotifyClient` with `data.said`; the
  default rate is `agent({ clientInbox: { sampleRate } })`, published beside the
  step env by `createAgentServer` and `aai dev` (`publishClientInboxDefaults`).
  Audio for an undelivered utterance is held across the step's retries.
  **`stepEnvContext()`** is the whole step env plus the step's signal
  (`StepInfo.signal`) as an `EnvContext`, which a `ToolContext` also satisfies.
- **`ctx.sayOnClient(name, clientId, notice)` is ONE `ctx.step` around
  `stepSayOnClient`** (`workflow-say-on-client.ts`), `id` defaulting to the run
  id and `maxAttempts` to `DEFAULT_CLIENT_DELIVERY_ATTEMPTS`; like `ctx.poll`,
  every `WorkflowContext` delegates to `sayOnClientWorkflow` (`/host-internal`).
  Its failure half is **`sayFailureOnClient({ clientId, event, text })`**
  (`say-failure-on-client.ts`, `/step`), a `workflow({ onFailure })` handler
  (`${runId}:failed`, `data.failed: true`, `spokenErrorReason` handed to
  `text`); `deepResearchWorkflow` takes the same `{ run, maxAttempts }` object
  and hands it to the engine, where a FUNCTION `onFailure` still runs in its
  body `catch`.
- **`ctx.report(name, line)` is ONE `ctx.step` around `stepReport`**
  (`workflow-report.ts`); `ctx.poll({ first, slowAfterMs })` is a `ctx.waitFor`
  ahead of the loop plus one `<name>:slow` report step, both journaled as the
  hand-written calls were (`workflow-poll.ts`). `PollResult.woken` is what a
  body reads instead of branching on a journaled submit result.
- **A signal token is DERIVED from the run key** — `<workflow>:<key>:<label>`
  (`workflow-signals.ts`): `ctx.waitForSignal(label)` / `ctx.signalToken(label)`
  in the body, `ctx.workflows.signalRun(def, key, label, payload)` in the tool,
  and both THROW for a keyless run. `StartOptions.key` defaults to `"session"`
  (the session id on a tool's client, `aai-runtime`'s
  `workflow/client-session.ts`; no key anywhere else), so `latest`/`live` read
  back what a tool started. `signal(token, payload, { holdMs })` keeps a payload
  for a wait the run has not reached yet (`signalRun` holds
  `DEFAULT_SIGNAL_HOLD_MS` by default).
- **`workflow({ input, output }).body(fn)`** is the two-phase form whose
  `typeof def` is fixed before the body exists — the `TS7022` escape, with
  `WorkflowInputOf<typeof inputSchema>` as the other (`workflow-readings.ts`).
  `WorkflowDef.describeRun`/`cancelNote` are what the `workflow_status` /
  `workflow_progress` / `workflow_cancel` builtins say
  (`host/workflow-builtins.ts`); `describeRun(def, run)` is the same line for a
  route handler.
- **`StepOptions.maxWaits`** (opt-in) lets a far side's dated `Retry-After` be
  waited out without spending an attempt — `aai-runtime`'s `replay/step.ts`.
- **`stepTextOwner(text, { phone?, links? })`** (`step-text-owner.ts`, `/step`)
  is `text_me`'s rule from a step: `allowedSmsRecipient` over the step env, a
  non-retryable refusal as `{ sent: false, why }`, a transient one thrown
  through `throwStepError`, a missing key FATAL. The env names are
  `_owner-text-env.ts`, which `host/text-me.ts` imports too.
- **`isCallOver(status)`/`CALL_OVER_STATUSES`** (`step-place-call.ts`) are the
  five terminal `PlacedCallStatus`es a dial-and-follow loop stops on.
- **`transcribeUploadDurably(ctx, uploadId)`** (`step-transcribe-durably.ts`,
  `/step`) is the async trio plus `ctx.poll` under three FIXED step names
  (`TRANSCRIBE_DURABLY_STEPS`), each failure classified; a spent budget is a
  non-retryable `TranscribeError` naming the job.
