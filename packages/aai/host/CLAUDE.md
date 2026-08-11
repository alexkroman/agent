# packages/aai/host — transport test harnesses

The randomized and replay-based harnesses that exercise `host/`'s transports
end to end. They live in their own guide because `packages/aai/CLAUDE.md` sits
at the 120,000-character cap (`pnpm check:claude-md`) and these three sections
are the most self-contained thing in it — everything else in that file
describes behaviour an author has to know while writing an agent, while this
describes how the transports are *tested*. The package guide keeps a pointer
here; the root guide's "Package-specific suites" table names this file.

Everything else about `host/` — session modes, the defaults table, telephony,
SSRF, the self-hosted server, `ctx.state`, durable workflows — stays in
`packages/aai/CLAUDE.md`. Read that first.

## Pipeline-transport interleaving fuzz

**`aai` has a randomized interleaving fuzz over the pipeline transport**
(`host/integration/pipeline-fuzz.integration.test.ts`, run by
`pnpm --filter @alexkroman1/aai test:integration`; needs no API keys). The
scripted specs in `host/transports/` each assert ONE interleaving; this drives
random event orderings and checks GLOBAL invariants — turn serialization, no
callback after `stop()`, no write to a closed provider session, reply-text
integrity, no audio after a reply's own `replyDone` — plus the strongest
oracle, validating every LLM request payload the way Anthropic and OpenAI do
(an unmatched `tool` result is a hard 400). That oracle is what surfaced the
`capLlm` bug (see the `maxHistory` row in the package guide's defaults table).
Two rules when extending it: **an oracle must be a property a real provider or
client enforces**, and **the generator must not itself break a provider
contract** — an early draft emitted TTS audio at arbitrary moments, and the
truncation oracle fired on the generator rather than the transport. It also
asserts COVERAGE FLOORS (barge-in, tool execution, history trimming, reply
completion): an all-green fuzz proves nothing if the random walk never entered
the state, so a suddenly greener result is usually a broken generator, not a
fixed bug. Discovery and regression are separate jobs — findings get a
deterministic spec of their own (the `capLlm` one lives in
`pipeline-history.test.ts`), because whether a random walk reaches a given
alignment is luck. That is measured, not assumed: reverting the `capLlm` fix
leaves this suite GREEN (both before and after it moved to fast-check) while
`pipeline-history.test.ts` fails immediately. The step count carries an unusual
`minLength`, because a run spends its first steps getting the session past
`start()` and shorter scripts finish before a reply ever completes.

- Its generated world (`_pipeline-fuzz-input.ts`) is split from the spec, and
  the MODEL — the request-payload validator, the `Monitor`, and
  `createCallbacks`, which is every client-visible callback wired to its oracle
  — from `_pipeline-fuzz-model.ts`, so the spec file is the properties, the
  driver and the coverage floors. Note biome's `noSecrets` rule is off for
  `**/_*-fuzz-*.ts` alongside test files (`biome.json`): a camelCase action
  name like `armBargeInFromTool` reads as high-entropy to it, and mangling a
  domain identifier to satisfy a false positive is the wrong trade.
- **Its fatality oracle needed a generator change to mean anything.** "Nothing
  conversational may reach a client that was told the session is over" passed
  on arrival — the fake LLM could not fail a turn, so the state was
  unreachable and the oracle decorative. The script pattern now carries a
  `fail` turn (an `error` stream part) and the instrumented `doStream`
  sometimes refuses outright, which are separate reporters; it then failed at
  once, on `onReplyDone`/`onSpeechStarted` after a fatal `llm` error. Hence
  the floors on `error:llm`, `llmRefused`, and `nonFatal:llm`: the first two
  keep the state reachable, the third turns a regression to `fatal` into a
  failure rather than a silent gap.
- **`preemptiveGeneration` is part of the generated world**, so both arms run in
  one property. It ADDS guardrail 1 as a global oracle (nothing may reach TTS
  between a cleanly completed reply and the next `onReplyStarted` — exactly the
  idle window a speculation runs in) and floors on speculations started /
  discarded-by-reason. It also COSTS two things, and both are stated in the code
  rather than quietly absorbed: the exact-text reply-integrity oracle is skipped
  in the ON arm (a speculation's text cannot be attributed to a reply at the
  moment it is served, and guessing is how a harness invents findings), which is
  why `replyIntegrityChecked`'s floor is the one floor in the file that has ever
  moved DOWN; and the turn-serialization bound widens, since a speculation is
  deliberately outside the turn chain. Two rules this suite does NOT guard,
  despite looking like it might: the per-utterance BUDGET (deleting the check
  leaves it green — only one speculation is ever held, and the 1 ms
  `speechIdleTimeoutMs` restores the budget before a third could fire) and
  ADOPTION (reached 0-6 times per run, too rare to floor, on the `resumeMooted`
  precedent). `transports/pipeline-speculation.test.ts` and
  `transports/pipeline-preemption.test.ts` own those. `PIPELINE_FUZZ_COVERAGE=1`
  prints the counter table, as `S2S_FUZZ_COVERAGE=1` does for the S2S property.

## S2S property test

**`aai` has a fast-check PROPERTY TEST over the S2S stack**
(`host/integration/s2s-fuzz.integration.test.ts` plus `_s2s-fuzz-model.ts`,
`_s2s-fuzz-harness.ts`, `_s2s-fuzz-commands.ts`; same command, also keyless).
It differs from the pipeline fuzz twice over — in what it composes, and in how
it generates.

- **The only fake is the SOCKET.** `connectS2s` (wire parse + dispatch),
  `createS2sTransport` (resume, tool-result redelivery, audio suppression) and
  `createSessionCore` (turn lifecycle, tool execution) all run for real, with
  a recording `ClientSink` at the far end. That is the point: every S2S spec that
  predates it stubs out a neighbouring layer (the transport specs mock
  `connectS2s`, the wire specs mock the callbacks), and all three bugs it found
  live in the seam BETWEEN layers, with every layer's own suite green.
- **Model-based COMMANDS, where the pipeline fuzz generates a script.** Both
  are fast-check; the difference is that legality here lives in each command's
  `check()` against a model that IS the provider state machine, so an illegal
  frame is never generated (no audio outside a reply, no `reply.started` while
  the service awaits a `tool.result`) and a counterexample contains only the
  commands that ran. Reverting each of the three fixes reproduces it from
  `[session.error(rate_limited)]`, `[drop.transient, openSocket,
  session.error(session_not_found)]`, and `[drop.transient]` — one, three, and
  one command.
- **No timers anywhere.** Socket opening and tool settlement are COMMANDS, so
  when a tool settles relative to a drop is part of the generated plan rather
  than a race. That is what makes shrinking and replay mean anything: this
  suite's own first draft awaited real `setTimeout`s, could not re-run its
  counterexamples, and intermittently reported a finding no rerun could
  reproduce. It is also why it runs in ~150ms rather than ~50s — the
  per-command drain is a `setImmediate`, not a ~1ms timer.
- **Three properties, differentiated by a per-run `faultBudget`** (0 / 2 / 3):
  turns, reconnects, retirement. One combined property cannot serve both ends
  — at 2 faults per 40 commands a tool call rarely survived to be answered (the
  central oracle ran 7 times out of 80 executions), and at 0 there are no
  resumes to redeliver across.
- Oracles: a tool call the service issued gets exactly one `tool.result` (zero
  leaves the service holding a turn it can never continue — the user hears an
  agent go silent until the idle timeout); nothing conversational reaches a
  client that was told the session is over; at most one fatal `connection`
  error per session, and no socket opened after it; no socket left open after
  `stop()`; `session.resume` only ever names an id the service issued. The
  streaming ones live in the harness's sink and THROW, so fast-check shrinks;
  the end-of-run ones run before `stop()`, which legitimately abandons work.
- **A resumed session inherits the dead socket's unanswered tool calls** —
  that is what `session.resume` MEANS, and it is the premise the tool-answer
  oracle rests on. Stop modelling it and the oracle stops meaning anything.
- **A finding is only reachable if the run does not excuse it first.** The
  tool-answer exemptions (interrupted turn, client reset, retired session, link
  not ready, a SIBLING call of the same reply still running — results flush per
  reply as a BATCH) are broad enough to silence the oracle completely, so each
  increments a `skip:<why>` counter and the floors are on the CHECKED counts.
  `toolAnsweredAcrossResume` has been near zero through three separate
  mistakes; it is the floor that stands between a live oracle and a decorative
  one. `S2S_FUZZ_COVERAGE=1` prints the table.
- **The fakes' fidelity is where the false findings came from**, every time.
  Three drafts blamed the transport for behaviour their own fake had invented:
  a `executeTool` that ignored its abort signal (the real one settles promptly
  via `pTimeout({ signal })`, so `stop()` was reported as hanging forever), one
  that ignored an ALREADY-aborted signal (which is exactly what a `tool.call`
  after a client cancel receives, since `onCancel` aborts the reply without
  replacing it), and one that rejected where the real executor always RESOLVES
  with a `toolError(...)` string. Check the real collaborator's contract before
  believing a finding.

## Fixture replay testing

Tests in `packages/aai/host/` use a **hybrid mock** pattern: a real
`Runtime` and tool executor with mocked S2S WebSocket connections. JSON
fixtures in `host/fixtures/` contain recorded AssemblyAI API messages
that are replayed through the real orchestration layer. Key helpers:

- `makeMockHandle()` — creates mock S2S WebSocket using nanoevents
- `replayFixtureMessages()` — dispatches fixture JSON as typed events
- `createFixtureSession()` — wires a real Runtime to mocked S2S
