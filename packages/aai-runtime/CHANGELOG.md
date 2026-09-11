# @alexkroman1/aai-runtime

## 16.2.0

### Minor Changes

- c129f05: Steer the recognizer per agent and per turn, and act on the confidence band.
  
  We own the ASR and were using three of its steering parameters and none of the
  rest. What the pipeline already sent: `prompt` (`agent({ sttPrompt })`, opt-in,
  empty by default), `language_codes`, the endpointing pair, Voice Focus, and
  `agent_context` — seeded with the greeting and REPLACED with the agent's own
  reply after every spoken turn, which is the per-turn steering the docs
  recommend. What it never sent: `keyterms_prompt` on any model (only the S2S
  descriptor took keyterms), `format_turns`, and any author-supplied context of
  its own.
  
  - **`assemblyAIStt({ keyterms })`** — the domain's own vocabulary, normalized
    host-side before it reaches the wire: trimmed, de-duplicated
    case-insensitively (keeping the first spelling, which is the one the author
    wants in the transcript), terms over 50 characters dropped and the list
    capped at 100. The service IGNORES an over-long term and REFUSES a connect
    carrying more than 100, so a product catalogue that grew past the cap would
    otherwise take a deployed agent off the air; dropped terms are named in a
    warning instead.
  - **`assemblyAIStt({ agentContext })`** — what the application already knows
    about the call, winning over the greeting the runtime seeds. Universal-3.5
    Pro only, as `agent_context` already was.
  - **A `dialog()` state's `keyterms` is LIVE**, where it used to warn that
    nothing applied it. AssemblyAI's `UpdateConfiguration` takes
    `keyterms_prompt` mid-stream, so `SttSession.updateKeyterms` pushes the
    active state's list at the END of each agent turn — the instant before the
    caller answers the question that state just asked. An absent value restores
    the descriptor's own list rather than clearing it.
  - **`agent({ lowConfidence })`** — a third outcome for a committed transcript,
    between "run the turn" and "drop an empty string". Below `discardBelow`
    (0.2) the words reach neither the model nor the record; between it and
    `actionBelow` (0.4) the agent either speaks a clarification and runs no turn
    (`action: "clarify"`) or runs the turn with a note appended to the MODEL's
    copy only (`action: "note"`). OFF unless an agent declares it: the numbers
    are Vapi's published pair and nothing has measured them here. A provider
    that reports no confidence is always ACCEPTED — `SttTurnMeta` carries
    `transcriptConfidence` (the mean of a turn's per-word scores) and
    `minWordConfidence` beside it, and only the AssemblyAI opener fills either
    in. `AgentTranscriptRecovery` gains `low-confidence`, so the clarification is
    spoken and captioned like the two failure phrases and enters no history.
  - **`assemblyAIStt({ formatTurns })`** — one explicit flag for whether a turn
    is punctuated, cased and inverse-text-normalized ("nine seven two" → "972"),
    so it can be A/B'd rather than inherited. Not a parameter on
    `universal-3-5-pro`, where formatting is always on: set there it is not sent
    and the opener says so. On `universal-streaming-english` the service default
    is `false`.
  - **A turn is not answered TWICE, and the flag above is what would have caused
    it.** With `format_turns: true` that model emits two `end_of_turn` messages
    for one turn — the unformatted transcript first, the formatted one right
    after — and the opener treated every `end_of_turn` as a commit. Nothing
    triggered it before, because we sent the parameter on no model; enabling it
    would have made the agent answer the same sentence a second time, on a
    history already containing its own reply, which is a long day to diagnose
    from a transcript. `isCommittingTurn` demotes the unformatted final to a
    PARTIAL when the session asked for formatting — the caption still updates and
    the commit waits for the formatted text. That demotion is load-bearing, not
    tidy-up.
  - **`assembleSpelledRuns` sees a run the RECOGNIZER joined.** It split on
    whitespace and commas, so a formatted transcript's `S-O-F-I-A` — one token —
    contained no single letters and assembled nothing. Measured on tau2-bench
    retail: "Sofia Li" came back "Sophia Lee", the caller spelled the correction
    out loud, and the lookup still went out as `Sophia`, because the annotation
    that carries a spelling was never produced. A token of three or more
    letter segments joined by `-` or `.` is now exploded first; `e-reader` and
    `t-shirt` have one letter each and are unaffected.
  - `retail-orders-agent` ships two worked keyterm sets (`keyterms.ts`): 37 terms
    for the whole call — multi-word product names, variant options, and the words
    the procedure is conducted in — and a per-phase list of the account NAMES,
    declared on `callFlow`'s `identifying` state, boosted while the call is
    working out who is on the line and given back when it moves on. It also sets
    `lowConfidence: { action: "note" }`, which suits an agent that already reads
    every change back before applying it.
  
  Epochs: `aai:agent` 4 (3 retained), `aai:stt` 2 (1 retained), `aai:dialog` 3
  (2 retained), `aai:testing` 4 (3 retained) — every change is additive, and each
  retained epoch has a frozen example.
- 0dcf247: Fix dead-air filler opening the barge-in gate, and assemble spelled identifiers in code.
  
  Filler audio drove the playback clock and `turns.markSpoke()` exactly as real
  speech did, so a caller's "are you still there?" counted as interrupting a
  reply and the abort discarded the reply being generated behind it — the cover
  causing the silence it exists to cover. Measured on a 114-task tau2-bench
  retail run: 435 barge-ins and 75 aborted turns discarding 553s of completed
  work, 48 of them losing over 5s each and the worst 40.6s.
  
  - `HeardTracker.spokeRecordable()` — a turn that has played only filler is no
    longer spoken over, which is the invariant `pipeline-transport.ts` already
    stated for `spoke()`: "a turn that has not spoken cannot be spoken over."
  - Dead-air cover is armed on the `tool-call` part at `DEAD_AIR_TOOL_COVER_MS`
    (1200ms) rather than 5000ms from turn open. 113 of 123 firings on that run
    were the turn-open window at exactly 5000ms — the right turns, too late on
    every one. Only safe because of the change above, and the constant says so.
  - `assembleSpelledRuns()` assembles spoken spelling runs (`"M, E, I,
    underscore, K…"` → `mei_kovacs`) for the model's transcript copy; the
    client's and history's stay verbatim. Previously asked of the model in
    prose, which mis-assembled often enough to be the largest single failure
    source — 22 of 57 failed calls never authenticated, every one with the
    correct identifier already in the caller's own words.
  - `DEFAULT_SYSTEM_PROMPT`: the `PROMPT_ROLE` carve-out now names the TOOLS
    recovery ladder alongside LISTENING and SPEAKING — it pointed at a method in
    a section it did not protect — and TOOLS' "retry once" is scoped to
    non-lookup errors, where it contradicted the four-step ladder four lines
    above it. `aai:defaults` is epoch 2 with epoch 1 retained.
- b7e21aa: Extract the studio coding agent's tool set into the SDK, and ship a generic coding agent as a template.
  
  ## The nine tools are `@alexkroman1/aai/coding-tools` now
  
  `createCodingTools({ dir })` answers the tools an agent that edits code turns out to need — `read_file`, `write_file`, `edit_file`, `delete_file`, `list_files`, `glob`, `grep`, `bash`, `todo_write` — keyed by the names the model calls, over ONE directory and reaching nothing outside it. Every one of them was already written, tested and tuned; what it could not be was USED, because it lived in `aai-guest`, a private package, closed over one studio session's workspace and tangled with the three things only the studio wants: a write-time syntax gate, a post-write type check, and a bundle trial.
  
  What survives deleting all of that is most of it. `studio-edit.ts` and `studio-grep.ts` moved as `host/coding-edit.ts` and `host/coding-grep.ts` with their specs, the capped child-process runner moved as `host/coding-spawn.ts`, and `resolveInside`/`writeFileWithParents`/`isPathInside` joined `host/workspace-files.ts` — the module that already owns what a workspace IS on disk, and where the containment test now has ONE implementation rather than the four it had (`aai-runtime`'s `server-static.ts` re-exports it; the copies that were only correct for an absolute, normalized, trailing-slash-free root are gone).
  
  Three seams a host fills in, and each is a rule the studio paid for:
  
  - **`validate` refuses a write BEFORE it lands.** The studio parses the file: one that does not parse cannot be edited back into shape by text matching, so writing it strands the turn — sixteen steps of read → edit → "could not find that text", no work produced.
  - **`afterWrite` appends to a write that SUCCEEDED**, which is where the studio hands back the workspace's type errors inside the result of the write that caused them. It is the cheap half of what a language server would do and the place a repair round is actually saved.
  - **`env` is `bash`'s child environment**, defaulting to this process's own — right for a CLI on a laptop, wrong for a sandbox, which passes an allow-list so a credential the host holds is out by construction rather than by remembering to subtract it. The studio still passes its 24-name `workspaceChildEnv()`.
  
  `CODING_TOOL_DESCRIPTIONS` and the four limits ride along on the same subpath, because a host that overrides a description has to quote the number the code enforces, and cannot keep the two in step with a constant it may not import. The machinery UNDER the tools is not published with them: the edit matcher and the workspace grep have no consumer outside `coding-tools.ts`, and only the capped child-process runner is on `@alexkroman1/aai/host-internal` — because the guest harness spawns npm, the CLI bundler and the workspace test run through it, and each decides for itself whether a killed child is a failure or an annotated line. A name published in anticipation of a consumer is a surface with no reader.
  
  The record is typed by NAME (`Record<CodingToolName, ToolDef>`, narrowed by `only`) rather than by an index signature, because a template's `tools/read_file.ts` default-exports one entry of it and under `noUncheckedIndexedAccess` an index signature hands back `ToolDef | undefined`.
  
  It costs `@alexkroman1/aai` two runtime dependencies, `diff` and `picomatch`, which were `aai-guest`'s. Both are small and pure-JS; the artifact-size budget will report them and this is the intent.
  
  ## `templates/coding-agent`
  
  A generic coding agent: `text: true`, the nine tools over `WORKSPACE_DIR`, a `system-prompt.md` that is most of what makes it good, and nothing about building voice agents with this SDK. It is the first TEXT-mode template, and this repo's guide previously argued there could not be one — the argument was right about DEPLOYMENT (`createRuntime` refuses `text: true` by name, so there is no session for `aai dev` or the platform to serve) and wrong about the template, since a starter is a worked example first. So it ships its own front door: `chat.ts`, which is `createTextAgent` plus `withToolsDir` (a tool is a FILE even with no bundler in the path), a `readline` loop, and the conversation as a message list the file keeps.
  
  Its tools are ONE `createCodingTools` call in `shared.ts` that each `tools/*.ts` re-exports an entry of — nine factory calls would be nine chances to point one at a different directory, and the directory is the only security-relevant decision in the template. The template says so where an author will read it: `bash` runs what the model wrote with the authority of the process, which is the authority the write and delete tools already have, so it grants nothing new — what it does is make the grant obvious.
  
  ## A TEXT agent's eval suite: `describeTextEval`
  
  `@alexkroman1/aai-runtime/eval/vitest` gains `describeTextEval`, and `/eval` gains `evalTextCredentials`. A template's eval must import that vitest subpath (konsistent's `template-eval-spec`), and what was there for a text agent was a voice suite that refuses one: `describeEval` opens `openEvalSession` → `createRuntime`. Everything a case author sees is shared — the two modes, the announce line, the per-case `stubReply`, the `live`/`scripted` markers, the `EvalTurn` and every reader above it — including `modeFrom`, so `AAI_EVAL_STUB` and `AAI_REQUIRE_EVAL` cannot come to mean one thing at two doors of three and another at the third.
  
  `evalTextCredentials` is a second gate rather than a flag on the first, because `evalCredentials` OVER-ASKS here: it answers about a voice agent, so an agent with no complete pipeline gets the default AssemblyAI STT key added, and a text agent declaring `anthropicLlm()` was reported as needing a key it will never read — which skips a suite the machine could have run live. It asks about the LLM alone, and about the DEFAULTED descriptor when the agent declares none, so the question is asked about the model the run would use.
  
  That is an additive change to the `aai-runtime:eval` capability: epoch 3, with epoch 2 RETAINED and its frozen authoring example written — `v2.ts` is `v1.ts` plus the two names epoch 2 added, used where a case would really reach for them.
  
  ## Why a carrier is in the header
  
  `aai-server` takes a patch because this changes `aai-guest`, whose built `dist/harness.mjs` is baked into the guest snapshot image the platform spawns every sandbox from — so the change reaches production through a server deploy and nothing else. Nothing in `aai-server` itself is touched.
  
  ## What changed in the studio, and what did not
  
  `createStudioTools` is `createCodingTools` with the three seams filled plus `test_agent`, which stays whole — it is the one tool that knows the workspace is an aai agent. The descriptions split the same way: the SDK's, three studio OVERRIDES (a write is type-checked, dependencies have their own tools, a workspace syncs back), and the tools only this host has. `studio/tool-descriptions.test.ts` asserts the three maps together cover the agent's real tool set exactly and that an override names a tool the SDK actually describes — an override of nothing is prose the model never reads. `studio/tools.test.ts` gave up the cases that are now the SDK's and keeps the ones about the seams. No behaviour changed in the studio.
- 180fd15: `describeEval` now refuses a `stubReply` that calls a tool the agent does not declare, and says so when the agent declares none.
  
  A tool is a FILE, so `agent.ts`'s default export carries an empty tool table and `virtual:aai/agent` is the lowered agent that carries the real one. Handing `describeEval` the authored def used to be accepted silently: the suite booted, the scripted model emitted a `tool-call` nothing served, and the case failed dozens of lines away on `expected [] to contain 'look_up_order'` — the symptom, with the cause on the `describeEval(...)` line. `toolRunner` has refused the same mistake at bind for a while; this is that guard for the other door.
  
  Two halves. A `stubReply` step naming an undeclared tool now throws at case DECLARATION, naming the case, the bad tool and the tools the agent does declare — plus, when it declares none, the same import remedy `toolRunner` gives. There is no legitimate reading of that shape, so the throw has no false positives. Complementing it, a suite over an agent declaring no tools and no workflows prints a line on the same channel as the mode announcement; that is a WARNING and must stay one, since a purely conversational agent is a legal eval target and a live run has no script to inspect.
  
  Minor rather than patch because a suite can now fail to collect where it used to run. The only suites that can is one whose scripted tool calls were reaching nothing — i.e. one that was already measuring nothing and passing.
- 7832142: Turn-taking defaults, measured on tau2-bench retail
  
  - `minBargeInWords` 2 -> 1: the caller's one-word give-up probe ("Hello?") could
    not interrupt the agent at all; worst measured case held the floor 12.8s.
    Replicated across two runs: truncated caller utterances 36% -> 20-24%,
    spelled-identifier truncations 4 -> 0, the >3s endpointing tail 33-40% ->
    12-20%, with no measurable cost to agent speech per call.
  - AssemblyAI LLM default model -> `gpt-5.6-luna`, which is inside
    `TOOLS_REQUIRE_NO_REASONING` and so depends on the `reasoning_effort: "none"`
    fill (verified against the live gateway: 200 with the parameter, 500 without).
  - Instrumentation only: dead-air cover firings and TTS first-audio latency are
    now logged. Both closed measurement gaps — cover firings were previously
    unobservable (`record: false`), and the text-to-audio term had only ever been
    inferred by subtraction (it is 66ms, not the 0.7-1.8s assumed).
  - Negative results recorded on the constants they concern, so they are not
    re-tried blind: `preemptiveGeneration` (100% post-adoption poison on a
    tool-calling agent), `deadAirCoverMs` (two clocks; a filler answers the wrong
    question), `interruptionMinDurationMs` (500 is the backchannel filter, not
    overhead), and the local-audio barge-in detector (onset recall is the wrong
    objective).
- f75ad5f: Fix every live template eval failure, and the instrument that hid them.
  
  `pnpm test:eval:templates` failed 15 of 110 cases; it now fails none. The
  instrument came first, because it is why finding them took eight passes:
  `AAI_EVAL_REPEAT` and `AAI_EVAL_ONLY` were declared in `check:eval`'s `env`,
  forwarded by `run-evals.mjs` and documented in its header, but read only by
  `aai-evals` — for all 28 template suites both were silent no-ops. `eval/_env.ts`
  reads them now and `SuiteSpread` reports the spread, so a case that failed only
  SOME repeats prints as `UNSTABLE (n/m)` with the failure it saw and does not
  fail, while one that failed every repeat does. Opt-in: an unset environment is
  byte-identical to before. `describeWorkflowEval` is wired in too, which would
  otherwise have left the five workflow suites silently running once.
  
  The spread report is what caught the one caller-facing defect. `roadside-assistance-agent`'s
  `acknowledge_disclosure` carried "after you have read it to them in full" in its
  DESCRIPTION and nowhere else, so a live desk called `lookup_coverage`,
  `acknowledge_disclosure` and `dispatch_truck` while never calling
  `service_disclosure` — a truck went out on a fee nobody read the caller, in the
  one template whose stated purpose is a price they were told about before it
  moved. `service_disclosure` records the handover now and `acknowledge_disclosure`
  refuses without it.
  
  Eight template prompts had real defects, most of them one shape: an instruction
  to ANNOUNCE a lookup with no instruction to then perform it (topic-briefing,
  executive-inbox in three places), a tool the prompt never mentioned at all
  (entertainment-picks' `recommend`), an escape hatch that literally permitted
  answering uncited (web-research), reading a score conflated with awarding points
  (text-adventure), a clarifying question asked over an already-complete objective
  (research-planner), no positive counterpart to "never invent a value"
  (hotel-reception), and every fee figure handed to the model behind a rule
  forbidding it to summarise them (roadside `lookup_coverage`).
  
  Several evals were wrong rather than the agents: three asserted values a SCRIPT
  determined against a live model, two forbade a documented-valid outcome, one
  demanded three distinct scores from three separate `ctx.generate` calls that
  never see each other, and several read a multi-tool chain out of a single turn.
  `EvalTestContext.mode` now carries the rule that would have prevented the first
  three — a value a script determined may only be asserted under `mode === "stub"`.
  
  Three new exports on `@alexkroman1/aai-runtime/eval`, moving that capability to
  epoch 2 with epoch 1 retained: `expectCalled` names the tier's commonest finding
  (the agent announced and stopped) in one assertion message that quotes the
  sentence said in place of the tool; `lastToolResultIn` is `toolResultIn` without
  the exactly-once refusal, which is right within a turn and wrong across turns;
  and `EvalWorkflowEngineOptions.stepAttempt` lets a case reach a body's PRIMARY
  branch — the engine only ever answered a first-and-only attempt, so
  `isLastAttempt` was always true and `link-digest`'s degraded prompt was the only
  one any eval had measured.
- 9c1fb03: Add `ToolDef.messages` — what a tool says while it runs, and the outcome that answers without the model.
  
  A port of Vapi's tool `messages` design. Four kinds per tool, declared beside
  `execute` and normalized onto the wire `ToolSchema`, so the feature means the
  same thing under `aai dev`, in a deployed guest and in host mode:
  
  - **`start`** — spoken as the call begins. `start: true` draws from
    `DEFAULT_TOOL_START_PHRASES` (Vapi's own five); several entries are VARIANTS
    and one is drawn per invocation, so a turn calling three tools does not say
    the same sentence three times. `blocking: true` holds the call until the line
    has been spoken, bounded at `TOOL_START_BLOCKING_MAX_MS` by a `pTimeout` at
    the call site.
  - **`delayed`** — `afterMs` from the start of the call. **Same timing means
    variants; different timings mean STAGED updates**, so 3000/3000/8000 is a
    two-rung ladder with a coin flip on the first rung's wording, and the rungs
    fire at 3s and 8s rather than 3s and 11s.
  - **`complete`/`failed`** — the role switch, and the reason this is worth
    having. `role: "assistant"` is spoken verbatim and **the model is not called
    at all**: the line latches and `startLlmStream` folds that latch into
    `stopWhen`, so a deterministic outcome costs zero further LLM round-trips.
    `role: "system"` is the other arm — the content rides back with the tool's
    result as a hint and the model writes the sentence, which is almost always
    the better answer for a failure.
  
  All four take `when` conditions over the call's ARGUMENTS (Vapi's six
  operators), so one tool can say a different thing for a refund than for a
  lookup.
  
  **Filler cannot cost a caller a reply, which is the invariant the dead-air
  cover already paid for.** `start` and `delayed` go out `record: false` — the
  flag `HeardTracker.spokeRecordable()` reads — so a turn that has played only
  tool filler still cannot be spoken over, and neither line reaches
  `ctx.messages`, the model's view or a committed transcript. The runner owns no
  signal, cancels no TTS and flushes nothing: a `blocking` start waits out the
  line's ESTIMATED length rather than a provider acknowledgement, deliberately,
  because waiting on the TTS session means touching the lifecycle of the reply in
  flight. Vapi's "idle messages are disabled during tool calls" is here too — the
  generic dead-air cover stands down while a tool is covering its own gap, rather
  than speaking a second, generic sentence about one silence.
  
  `quickstart-agent`'s `get_weather` is the worked example. Eight `aai`
  capabilities are bumped with their previous epoch retained: `ToolDef` gained an
  optional field and appears in all eight reports.
- 9c1fb03: Three turn-taking layers over the thresholds: a regex-keyed endpointing table, a start-speaking floor, and the two barge-in phrase lists.
  
  Each one answers a question the existing knobs are structurally unable to see.
  All three are Vapi's shapes with our numbers, because our measured baseline is
  1600ms of end-of-turn silence and theirs is not.
  
  - **`endpointingRules`** — content-keyed overrides of the STT's end-of-turn
    window, evaluated as the HIGHEST-priority endpointing layer: three rule kinds
    (`assistant`, `user`, `both`), first match wins, `RegExp.test` substring
    semantics, `timeoutMs` capped at 5000 and clamped again at run time to the
    session's `maxTurnSilenceMs` (a floor above that ceiling is the measured
    inversion on `DEFAULT_MIN_TURN_SILENCE_MS`). Pushed to the provider mid-stream
    through a new optional `SttSession.updateEndpointing`, because endpointing is
    the provider's decision and a host-side hold could only ever lengthen a wait
    the provider had already ended. AssemblyAI has the verb
    (`UpdateConfiguration.min_turn_silence`); any other provider gets one warning
    and an inert table.
  
    The shipped set is retail-shaped, every number is argued from a measurement,
    and **every rule lengthens the wait or leaves it alone**: 3000ms while the
    caller is SPELLING or after the agent asks WHO they are (names are where
    turns collapse — "Yusuf" → "Yuta" → "Yufus", three failed lookups; digit
    strings were already fine at 1600), and 2600ms after an identifier ask or
    while the transcript ends in a digit (the measured worst-case dictation pause
    is 1455ms).
  
    The closed-question rule is **present and NEUTRAL** — at the baseline, not
    the 900ms the ~470ms first-partial model floor would allow. That floor is a
    LOWER bound and not the measured distribution of caller responses to closed
    questions that shipping a shortening default would need, and the asymmetry
    decides it: a lengthening rule that misfires slows the agent, a shortening
    one TRUNCATES the caller — and "closed questions get open answers" is routine
    ("Can you confirm that's the right address?" → "Well, actually…"). A
    truncation also surfaces as a reward flip, which is exactly the signal that
    is unreadable at n=3. `endpointing-rules.test.ts` asserts the
    never-shortens property.
  
  - **`startSpeakingFloorMs`** (Vapi's `waitSeconds`) — a minimum delay at the
    END of the pipeline, after TTS is ready, before audio goes out, so "when did
    I decide the turn ended" and "when do I start speaking" stop being one
    number. **Defaults to 0**, which is a pass-through rather than a zero-length
    wait: on this pipeline p50 response latency is ~4.1s, against which Vapi's
    own 0.4s would be inert except on the turns that already feel good.
  
  - **`interruptionBackoffMs`** (Vapi's `backoffSeconds`) — agent audio stays
    blocked for this long after a real interruption. SEQUENTIAL with the floor,
    never cumulative: the two are one deadline, `max(floor, backoff)`. Also
    **defaults to 0**, because `resumeFalseInterruption` already occupies that
    window and waits on the transcript stream rather than a fixed deadline.
  
  - **`acknowledgementPhrases` / `interruptionPhrases`** — Vapi's published
    production lists, ON by default. An acknowledgement NEVER interrupts however
    many words it carries and however long it lasts (matched against the whole
    normalized utterance, so "okay" is a backchannel and "okay so cancel that" is
    a turn); an interruption phrase ALWAYS does, bypassing both
    `minBargeInWords` and `interruptionMinDurationMs` (matched as a whole-word
    run anywhere). The yes/no asymmetry is deliberate and pinned: "yes" never
    interrupts, "no" always does. `bargeIn: "off"` still wins over both lists —
    a dialog state declaring that this sentence gets finished is a stronger,
    more local claim than an agent-wide list.
  
    Unmeasured as lists on this corpus, and the instrument is named: tau-voice
    S_BC selectivity plus the give-up-probe rate, with the cancelled/reply_done
    ratio (1.06 on the hardest measured case, ~85 events a run) as the direct
    proxy. `[]` switches either off.
  
  `aai:agent` is epoch 4 and `aai:testing` epoch 4, both with epoch 3 retained —
  every new field is optional, and the two frozen examples say so.
- 7fe0571: Close the API-parity gaps found by comparing the authoring surface against the Anthropic Agent SDK, OpenAI Agents SDK, Mastra and Pydantic AI. Everything here is additive — no published type was renamed and no epoch was dropped.
  
  **`ctx.messages` has a real third arm.** `Message.role` has always included `"tool"` and nothing ever produced one, so a tool could see every word of the call and nothing any tool had returned. A settled call now contributes `{ role: "tool", content, toolName?, toolCallId? }` in all three modes and on resume, capped so a live history and a resumed one are the same history. Read the arm by role — the two id fields are optional.
  
  **Per-tool error classification.** `ToolDef.onError` (and `dialog.tool`, `slot.tool`, `slot.updateTool`) turns a throw into either a result the model may recover from or a fatal failure that stops the turn. Previously every exception — a bad credential, a bug in the tool body — was serialized back to the model and retried until `maxSteps` burned. A tool with no `onError` behaves exactly as before.
  
  **Agent-level guardrails.** `inputGuardrails` / `outputGuardrails` on `agent()`, reusing the subagent `GuardrailVerdict` vocabulary. The output guardrail holds a reply at the single TTS funnel and can discard it unspoken. Pipeline-only: s2s has already spoken the sentence and text mode owns no funnel, so both are refused by name at config time rather than silently doing nothing.
  
  **Dynamic instructions.** `systemPrompt` accepts `(ctx: AgentSessionContext) => string`, resolved per model request. A project carrying a `system-prompt.md` can now use one — `withSystemPrompt` passes a resolver through instead of throwing, and its string-case error no longer suggests a remedy that never worked.
  
  **Host-side usage accounting and budgets.** `usageLimits: { totalTokens }` plus a `usage.updated` session event. The meter counts the conversational loop, `ctx.generate` and `ctx.delegate`/subagents, and is checked at every spend site; durable workflow steps and s2s stay uncounted and say so on the field.
  
  **Agent/subagent parity.** `description`, `maxOutputTokens`, `maxRetries` and `resetToolChoice` on `agent()` — the subagent had several of these and the agent did not. All five model-tuning knobs are refused in s2s mode, where this runtime never assembles the request.
  
  **One vocabulary for delegation.** The `delegate` tool's input key is `subagent`, matching the `subagents` field and the `SubagentDef` type; it was `coworker`. This changes the tool's JSON schema, not any TypeScript type.

### Patch Changes

- 180fd15: Correct the doc comments behind the generated SDK reference, which described an API the SDK no longer has.
  
  `ctx.db` and `ctx.state` are gone, but seven published comments still taught them. `ToolContext`'s summary claimed it "provides access to the session environment, state, database, and conversation history" — four things, two of which do not exist, on a type with eleven fields — and omitted `signal` and `deadlineAt`, the two a tool doing slow work most needs. It now rosters the real fields, grouped by what a tool reaches for. `ctx.generate`, `workflow()` and `stepReport()` no longer explain themselves by analogy to a capability that was removed, and `aai-runtime`'s README no longer tells a self-hosting reader that `ctx.db` is whatever `Db` they passed: a self-hosted tool receives no database, and `RuntimeOptions.db` is spent on session-slot storage and the workflow run journal and key store. `TextAgentOptions.db` is documented as accepted-and-unused rather than as the thing that makes `ctx.db` work.
  
  The reference front page taught `slot.projection()` where the guide teaches `slot.projected`; the `@module` table and its worked example now declare a `view` on the slot and pass `slot.projected`, and `AgentDef.syncState` leads with the same spelling, keeping `projection(view)` as the multi-view case. `mapConcurrent`'s only example issued no `ctx.step` at all, contradicting the hundred lines of module doc above it arguing the callback must issue exactly one, synchronously, under one literal name — it does now.
  
  A second sweep took the rest of both packages. On the published surface: the `/runtime` reference landing page introduced `createPostgresDb` as "the `ctx.db` handle over your own database" — the first thing a self-hosting reader meets — and now says what it is, a `Db` over your own Postgres for the stores the runtime keeps there (session slots, the workflow journal and its correlation-key index), never handed to tool code. `AgentServerOptions.db` said "SQL handle exposed to tool code as `ctx.db`" and now matches `RuntimeOptions.db`. `StartOptions.key` no longer offers "an index in `ctx.db`" as the alternative it saves you from, and `ClientConfig.credentials` and `unknownCredentialName` state the `DATABASE_URL` threat as what it now is — a client pointing the runtime's own stores at a server it controls. `createKeyedLock`'s module doc motivated itself with two tool calls interleaving on `ctx.state`; the bug is the same one and the thing they share is a session slot.
  
  The internal comments went with them, so the next reader of `postgres-db.ts`, `app-db.ts`, `workflow/client.ts`, `session-state-postgres.ts`, `runtime-session-state.ts` or `host-mode.ts` is not told a tenant database is on the other end of the pool. References that describe the REMOVAL — `sdk/db.ts`, `session-events.ts`, `workflow/keys.ts`, `uploads-platform.ts` and the conformance headers — are left as they are; they are the history, and they are correct.
- 440e38a: `createAgentServer` now applies the session-state and workflow-journal DDL at boot when the resolved store is Postgres. It previously did neither, so the documented self-hosting path — the one the docs call "own the boot" and claim runs state and workflows "the same" — printed `runStore: "postgres"` and then died on the first run with `42P01`. Both appliers are idempotent and warn rather than throw, and the work is memoized per URL, so a server that boots today cannot start failing because of this.
  
  A platform guest, whose stores belong to the platform, is excluded. `publicUrl` is deliberately still not sniffed from the environment — that stays the deployment layer's job, and the shipped example now does it.
- 482b874: Fix the two defects a graded run found in the spelled-run extractor.
  
  The recognizer-joined fix is live and producing annotations — 7 on one
  tau2-bench retail arm against a baseline of 0 — and **one of the seven was
  right**. All seven utterances are now fixtures in `utils.test.ts`, verbatim off
  the wire, because two of the six failures were in shapes nobody would have
  invented.
  
  - **A run that ENDED A SENTENCE never exploded.** The trailing-punctuation
    strip ran inside the walk, on a word `explodeSpelledWord` had already
    declined to split, so `"…M-E-I and last name A-H-M-E-D."` yielded `mei`
    alone and `"E-X-A-M-P-L-E dot C-O-M."` yielded `example.` — the surname and
    the TLD, which are exactly the halves a lookup fails on. The strip happens
    before the split now. Note what it was NOT: `and`, `last name` and `dot` all
    worked, and the same two utterances without the full stop were always
    correct, so the diagnosis "the separators are wrong" would have fixed
    nothing.
  - **A run spanning two names asserted a word that does not exist.**
    `"My name Sophia Liz, S-O-F-I-A-L-I"` assembles `sofiali`, which matches no
    name — and a nonsense token asserted alone reads as authoritative, so the
    model dropped it and sent the misheard "Sophia". The boundary is not in the
    letters and no threshold recovers it (`example` is as long as `sofiali`), so
    `spelledAloudNote` now reports the LETTERS beside the token for a single run
    of pure letters — `S-O-F-I-A-L-I = sofiali (may be more than one word)` — and
    leaves the split to the model, which has "Sophia Liz" in the same utterance.
    Several runs keep the old form (`yusuf, rossi`): the caller's own pauses gave
    the boundaries, and that is the string measured to produce the right tool
    call. A run carrying a separator or a digit is an identifier and keeps it too.
  - `assembleSpelledRuns` returns `readonly SpelledRun[]` rather than strings, and
    the annotation's WORDING moved to `spelledAloudNote` beside it — what the note
    may claim is a property of the run, not of the call site.
  
  Deliberately NOT fixed here: a seventh annotation faithfully read `fofia` from
  a spelling the recognizer itself misheard as `F-O-F-I-A`. That is the extractor
  working correctly on bad input, and a plausibility filter inside it would be an
  extractor second-guessing its own input; the guard belongs where the "the
  letters REPLACE what you heard" instruction lives.
- 350e80f: Give the durable-workflow half of `aai-runtime` a directory. `workflow-*` had reached 166 files — a third of the package, and more than the whole `aai` SDK — so the filename prefix is a path now: `workflow/`, with `api/`, `replay/` and `journal/` for the three clusters that were 20+ files each. Two groups moved in that never carried the prefix: the `_workflow-*` spec harnesses, and `journal-conformance*`, which is the `JournalStore` contract and imports the backends directly. No published export moved — every entry point on this package is a barrel at `src/` root — so `dist/` and the `exports` map are byte-identical.
  
  What the move cost is the part worth recording, because the next prefix split will pay it again. Three suites discover their own subject by FILENAME, and a `startsWith("workflow-journal-")` scan matches nothing the moment that prefix becomes a directory — a registry comparing "what is in the tree" against "what is registered" then compares two empty sets and passes. All three failed loudly instead, and only because each carries an `expect(found.length).toBeGreaterThan(0)` floor under its scan. The journal scan keys on the DIRECTORY plus a `create*Journal` export now, which is strictly wider: a backend can no longer arrive under a name it fails to recognise, only in a directory it does not read.
- Updated dependencies [c129f05]
- Updated dependencies [440e38a]
- Updated dependencies [0dcf247]
- Updated dependencies [b7e21aa]
- Updated dependencies [4ab107e]
- Updated dependencies [07a046e]
- Updated dependencies [7832142]
- Updated dependencies [180fd15]
- Updated dependencies [440e38a]
- Updated dependencies [482b874]
- Updated dependencies [440e38a]
- Updated dependencies [9c1fb03]
- Updated dependencies [9c1fb03]
- Updated dependencies [3e8e8a4]
- Updated dependencies [9c1fb03]
- Updated dependencies [49cebb8]
- Updated dependencies [7fe0571]
  - @alexkroman1/aai@16.2.0

## 16.1.0

### Patch Changes

- @alexkroman1/aai@16.1.0

## 16.0.1

### Patch Changes

- da1967d: Reach every optional OpenTelemetry peer through a dynamic `import()`, so a project that never installed one can still BUILD.
  
  `_tracing-otel.ts` is reached only through the env gate's dynamic `import()`, but a consumer bundles this package with `ssr: { noExternal: true }` and `codeSplitting: false` — `aai build`'s worker, and every deployment target's entry — and both settings together INLINE that import, so the module's own imports had to resolve at the consumer's build time. Vite answers an unresolvable optional peer with `__vite-optional-peer-dep:<peer>`, which exports nothing, and rolldown checks every named binding against it: twelve `[MISSING_EXPORT]` errors, one per name, killed a real `vercel deploy` of a scaffolded project. The same module had done it once before through a different importer, and the remedy both times was to keep it out of that bundle — an invariant over the whole import graph, re-decided by every new caller and checked by nothing.
  
  The peers now arrive as loaded namespaces from `loadOtelPeers()` and are threaded to `startTracingOtel`, `buildIntegration` and the propagator as values; the types come from `import type`, which is erased. Measured against vite 8 / rolldown, a dynamic import is not export-checked in either spelling, so a project without the peers builds clean and meets the existing install line only when it arms `OTEL_*`, while a project that has them gets them inlined and traced exactly as before. The guest still bundles the implementation into `dist/harness.mjs`. No published surface changed.
  
  Two gates hold it: `pnpm check:optional-peers` fails any static value import of an optional peer from a module a published entry can reach (reachability over static AND dynamic edges, since a bundler inlines both), and `aai-cli`'s `_target-bundle-peers.scenario.test.ts` builds a real target entry against a runtime copied out of the workspace with the peers unlinked — the only way to reproduce a user's install, since resolution follows a symlink to its realpath.
- @alexkroman1/aai@16.0.1

## 16.0.0

### Minor Changes

- bbd1a47: Three things the templates kept rebuilding move into the SDK.
  
  `describeMedia(info)` on `@alexkroman1/aai/ffmpeg` turns a `probeMedia` result into the `41:20 of aac` a progress line wants, degrading a field at a time (`41:20`, `aac`, `the recording`) when ffprobe did not report one. `call-audit` and `transcription-workflow` each carried the same function.
  
  `dialogResultSchema(result)` on `@alexkroman1/aai/testing` is the envelope a `dialog.tool` answers with — `{ result, state, done, instruction? }` — as a zod schema around the tool's own, for an eval reading a serialized result back through `toolResultIn`. Three template evals had written it out under a comment saying the shape was the SDK's.
  
  `describeEval` now gives the workflow engine it opens beside a voice agent the same env `describeWorkflowEval` gives a workflow app: in stub mode a declared key nobody has is a placeholder, so a step's `requireStepEnv` reaches the scripted provider instead of throwing over a credential the case was never going to use. The two templates that hand off to a run drop the `EVAL_ENV` they each carried for exactly this.
- b463bb5: Drive a declared `agent({ dialogs })` from the session: session events reach the dialog, per-state deadlines fire, the active state's instruction reaches the model every turn, and three of its voice knobs take effect.
  
  Events are offered to each dialog between the client send and the author's `events` hooks, so a hook reading `position()` sees the state the dialog moved TO. Deadlines run from the dialog's last move, which is what makes both a silence ladder (a self-transition on `@user-transcript.committed` restarts the window) and an abandonment deadline (nothing extends it) expressible without the runtime guessing. `bargeIn`, `toolChoice` and `temperature` are live on the pipeline, the latter two per STEP; `voice` and `keyterms` cannot take effect mid-session and warn at the first session rather than doing nothing quietly. Preemptive generation is disabled for a session whose dialogs vary the LLM knobs, since a speculation decides once whether it is free.
- c94f702: Subagents gain `expectedOutput`, a `guardrail` that can send an answer back, and `agent({ subagents })` — a roster the model routes over.
  
  `SubagentDef.expectedOutput` declares what a good final message is and the runtime appends it as its own section, making structural the "tell it to summarize" rule that was previously a sentence every author had to remember. `SubagentDef.guardrail` checks an attempt and may return a complaint, in which case the subagent is re-run with its own rejected answer and that complaint appended to the conversation it already has — so the retry keeps the tool results the first attempt paid for. Exhausting `maxRetries` (default 1) returns the last attempt with `accepted: false` and the `complaint` rather than throwing, because a caller on a live call still has to say something.
  
  `agent({ subagents: [a, b] })` publishes a roster as one `delegate` tool whose `coworker` argument is an enum over the names, described by each subagent's new `description`. It is the other way to choose a subagent: a tool body naming one is the author routing in code, a roster is the model routing per turn. `briefing-desk` demonstrates both side by side.
- 07f0a3e: `stepDelegate` — a whole tool loop from inside a workflow step, and two templates stop hand-rolling one.
  
  `stepGenerate` was the one-shot a step already had; the gap beside it was the loop. A step is handed no `ToolContext`, so `ctx.delegate` was unreachable there and a workflow that needed a model to search-read-search hand-rolled it: an action schema for the model to pick from, a counter for the budget, a sentence telling it to answer once the budget was spent, and a branch for the turn where it named an action and filled in none of its fields. `stepDelegate(subagent, { task })` is the same `createSubagentRunner` `ctx.delegate` runs on, bound to a sessionless parent bag — a published `Symbol.for` slot rather than an import, because `ToolLoopAgent` may not ride into the agent bundle. `stubStepDelegate` and `installStubStepDelegate` drive one in a spec; an unpublished slot throws rather than answering emptily, since there is no degraded version of running a model loop.
  
  `research-workflow`'s `investigate` deletes 82 lines of loop and helpers for it, and its second model call went too — `expectedOutput` compresses where the raw material already is (the file nets 44 code lines lighter; the rest is the researcher, its `cite` tool, and reading the run's cost off `toolCalls`). `plan-and-execute`'s `executeStep` is the same conversion through `ctx.delegate`, which its tool had all along; its executor gained a `read` tool, closing a gap its own prompt had left open ("search once, read what comes back", with no way to read).
- 4986d01: Move OTLP span export into the runtime, so self-hosted and `aai dev` agents can point at a collector — not only the managed platform. The OpenTelemetry packages are optional peer dependencies loaded through a dynamic import, so nothing is installed or constructed unless a deployment enables tracing. Adds the `@alexkroman1/aai-runtime/tracing` subpath, and joins a model call to the request that caused it by forwarding W3C `traceparent` across the platform hop.
- 0b81685: Publish the eval and workflow-test types that were referenced by public options and exported by nothing (`HostGenerateFn`, `EvalWorkflowEngineOptions`, `JournalStore` and its six records, `DeterminismKind`, `JournalConflictError`, `DEFAULT_RUN_TIMEOUT_MS`), and render `/eval`, `/eval/vitest` and `/testing` in the API reference.
- b463bb5: Resolve the system prompt per turn rather than once per session, so a phase-aware prompt can reach the model on turns that call no tool.
  
  `TransportSessionConfig.systemPrompt` accepts a thunk as well as a string, and `Transport.refreshSystemPrompt()` pushes a changed prompt to a live OpenAI Realtime session as an `instructions`-only `session.update`, sent only on a change. A speculation now records the prompt it launched on and is discarded as `prompt-moved` when that has since changed, because a request in flight cannot have its `system` amended. AssemblyAI S2S resolves once at construction — its tool loop is service-side and has no per-turn moment. A plain string behaves exactly as before.
- ffb795f: The second half of the template audit: five families of code the templates kept rebuilding move into the SDK, and the templates become their worked examples.
  
  **`@alexkroman1/aai-ui` — the session chrome kit.** `SessionStateDot`, `SessionControls` (with the headless `useSessionControls`), `ConversationView` (which `MessageList` is now built on, DOM unchanged), plus `AudioResult` and `WorkflowRunPanel` for workflow-app pages, and an `.aai-scroll` utility in `styles.css`. Three custom chromes (`dispatch-center`, `retail`, `infocom-adventure`) each rebuilt the dot, the Start/Pause/New/End row with the same twelve-line comment on `end()` vs `reset()`, and the conversation skeleton; two pages each rendered the audio block and the run panel by hand.
  
  **`@alexkroman1/aai` — `sessionSlot({ caps })`.** A per-array growth cap the slot enforces after every write (after the author's `after` hook), typed so only array-valued keys are accepted (`SlotCaps<T>`). Ten templates paired a `MAX_*` constant with a wrapper whose whole body was `pushCapped`, and a wrapper caps only the paths that call it: `executive-assistant` had three uncapped arrays riding every `syncState` frame. `pushCapped` stays for nested lists.
  
  **`@alexkroman1/aai/step` `mapSettled` / `partitionSettled` / `Settled`** — bounded fan-out with per-item failure isolated into a value, which `hiring-desk` and `briefing-desk` had composed over `mapConcurrent` and `Promise.allSettled`. **`@alexkroman1/aai/tts` `ttsVoiceIds(language?)`** — the `z.enum` tuple of catalog voices two templates derived by hand. **`spokenAlphanumeric`** beside `spokenDigits`.
  
  **`@alexkroman1/aai/testing`** — `expectDeployable` (the three starter invariants six specs wrote out), `expectPromptBuiltinsDeclared` / `commandedBuiltins` (the prompt↔`builtinTools` scan two specs had byte-identically), `runGuardrail`, and `scriptedToolContext` (both model seams scripted, answering `{ ctx, model, desk }`).
  
  **`@alexkroman1/aai-runtime/eval`** — `runCodeIn` / `runCodeOutput` (the second throws on the executor's refusal, importing the sentence from the executor rather than letting a spec re-type it), `expectToolBeforeSpeech`, and `EvalTurn.errors` with `errorsIn`.
  
  Epochs: `aai:state` 18, `aai:testing` 29 and `aai-runtime:eval` 9 retain their predecessors with frozen examples; `aai:spoken`, `aai:step`, `aai:tts` and the three `aai-ui` capabilities are bumped with the additive-drop reason this repo records for a package that keeps no example of the superseded epoch.

### Patch Changes

- b890150: Load the six @ai-sdk provider packages and the Postgres driver on first use instead of at import.
- 8bd5841: Move six things the templates kept rebuilding into the SDK.
  
  - **The OUTBOUND half of `spoken.ts`.** `spokenMoney`, `spokenDate`,
    `spokenTime` and `mintCode` — data as the words a TTS voice reads correctly,
    which is the same problem `resolveOne` solves from the other end. Fixed ASCII
    shapes and no `Intl`: the `toLocaleDateString("en-US", …)` this replaces
    answers to the host's ICU build, so a desk could read dates correctly on a
    laptop and differently in a sandbox.
  - **`ctx.random`.** `ToolContext` gains a required `random`, with `randomInt` /
    `pickOne` / `shuffled` / `createSeededRandom` beside it. Ten sites across
    seven templates called `Math.random()` directly and could not be pinned by a
    spec. `createToolContext` defaults it to a SEEDED source, so a spec that never
    mentions randomness is still deterministic.
  - **`isoDate(what)` / `clockTime(what)`**, plus the `calendar.ts` predicates and
    UTC arithmetic behind them. A tool-argument rule declared where the model
    READS it rather than discovered by being refused after it has committed.
  - **`orFail` / `failable`.** The forwarding half of the `T | ToolFailure` union,
    so a chain of lookups is written once rather than guarded per step. The union
    and how a tool returns it are unchanged.
  - **`parseWav`** and the RIFF chunk walk, the read side matching `encodeWav`.
    A reader that assumes 44 bytes transcribes ffmpeg's own `LIST`/`INFO` chunk as
    audio.
  - **`roundMoney`**, sharing `formatMoney`'s `toFixed(2)` basis so a total cannot
    compare as one number and print as another.
  
  Breaking: `ToolContext.random` is required, so code that hand-builds a
  `ToolContext` rather than using `createToolContext` no longer compiles.
- Updated dependencies [66568a5]
- Updated dependencies [8bd5841]
- Updated dependencies [bbd1a47]
- Updated dependencies [1ecf911]
- Updated dependencies [55ddb0a]
- Updated dependencies [c94f702]
- Updated dependencies [b890150]
- Updated dependencies [b463bb5]
- Updated dependencies [07f0a3e]
- Updated dependencies [55ddb0a]
- Updated dependencies [c36a3c0]
- Updated dependencies [ffb795f]
- Updated dependencies [8bd5841]
- Updated dependencies [31bec98]
- Updated dependencies [b890150]
- Updated dependencies [0666785]
- Updated dependencies [ffb795f]
- Updated dependencies [55ddb0a]
  - @alexkroman1/aai@16.0.0

## 15.1.0

### Patch Changes

- @alexkroman1/aai@15.1.0

## 15.0.0

### Major Changes

- 77b86d9: AgentServer now exposes the `node:http` server underneath as `node`, so a serverless host can be handed a wired-but-unbound server instead of being asked to start one. Vercel's Node runtime wants `export default <http.Server>` and binds the socket itself; the only route before was to listen on an ephemeral port inside the function and proxy HTTP plus upgrades to it. `port` is now read off that server rather than latched by `listen()`, and `close()` gates on whether the server is listening, so both are correct for a host that bound `node` itself. `createAgentServer` publishes the workflow step env at construction rather than just before the bind, so a deployment that never calls `listen()` does not silently fall back to `process.env` in its steps. Breaking only for a host that IMPLEMENTS `AgentServer`, which must add the member; every consumer of the handle is unaffected.

### Minor Changes

- 29fbf01: Give `createTextAgent` a typed event stream: `onEvent` reports a text agent's turns as the same `SessionEvent` union a voice session emits, narrowed to what a text agent can honestly report, so an eval reads a text turn with the readers it already has instead of scraping the reply text. `runTextAgent` hands the recorded list back as `TextAgentTestRun.events`. Additive: `TextTurnResult` is still the AI SDK's own `StreamTextResult`.
- 29fbf01: Publish a scripted-model test harness for text agents on `@alexkroman1/aai-runtime/testing`: `scriptedTextModel(steps)` builds the `LanguageModel` a spec hands `createTextAgent({ model })`, and `runTextAgent(def, input, { script })` drives one turn through the real `createTextAgent`, the real tool executor and the real tool `ctx`, handing back the text, the tool calls in order with their arguments and results, the steps, and the messages the turn appended. Replaces the hand-written provider fakes (and their `as unknown as LanguageModel` casts) that every caller was writing, each copy re-deriving the `finish` frame whose bare-string `finishReason` silently stops every tool from running.
- 29fbf01: Publish the TEXT-AGENT eval harness on `@alexkroman1/aai-runtime/eval`: `openEvalTextAgent({ agent })` stands up a real `createTextAgent` — the resolved model, the real tool executor, `ctx` and its slots, the step budget — and hands back a `send()` that returns the `EvalTurn` it provoked, plus `sendAll`, `events()`, `said()` and `toolCalls()`. The sibling of `openEvalSession`, which structurally cannot serve a text agent because `createRuntime` refuses `text: true` by name, and deliberately the same shape: the turn record, the event readers and every assertion above them are shared rather than reimplemented, since a text agent emits the same `SessionEvent` union.
  
  A turn ends on a real terminator rather than a timer, and here that is structural: the harness consumes the turn's own stream, so `reply.completed`/`reply.cancelled` has passed through by the time `send()` resolves and the next message cannot be sent inside the previous turn. One agent per conversation, so `ctx.state` and the model's view of the history carry across turns; a turn nothing about the agent can be read off (the model stream failed, or a tool was called the agent has no definition for) throws instead of reporting a reply that said nothing.

### Patch Changes

- 77b86d9: Fix silently mute audio on Node 24, and pin the SDK to its declared engine floor. `base64ToUint8` called `Uint8Array.fromBase64` — a Stage 3 proposal absent from Node 24 — inside a `try` whose `catch` exists for a malformed payload, so the `TypeError` was swallowed and every audio frame decoded to zero bytes. Measured on Vercel nodejs24.x: 77 TTS frames in, 77 empty, 0 emitted; a deployed voice agent transcribed the caller, answered in text, and said nothing. Affected every audio path (TTS, S2S, telephony, OpenAI Realtime) on any Node 24 or 25 host, plus binary workflow values, which failed with a mislabelled error instead. The decode now feature-detects once and falls back to a validating decoder; `tsconfig` pins `lib` to ES2025, `@types/node` to the 24 line, and CI runs the engine floor rather than the newest Node.
- Updated dependencies [f9c1a98]
- Updated dependencies [8dc4cbb]
  - @alexkroman1/aai@15.0.0

## 14.0.0

### Minor Changes

- a9c1577: Bound what a pipeline step SENDS the model by tokens rather than by message count. A `prepareStep` preparer trims the request to the model's advertised context window less an explicit 25% reserve for the system prompt, the tool declarations and the reply, calibrating its estimate against each completed step's reported `usage.inputTokens`; conversation history itself is untouched, so the client replay, resume and `ctx.messages` still see everything and `DEFAULT_MAX_HISTORY` stays as the guard on unbounded growth. Tool-call/result pairs trim together, and a model whose context window this SDK does not know is left entirely alone rather than trimmed against a guessed window.
- a9c1577: `parseTraceparent` keeps the caller's span id and flags beside the trace id
  `traceIdOf` already answered, and is published on
  `@alexkroman1/aai-runtime/internal`. One parser, so a log line and an exported
  span can never name two different traces for one request.

### Patch Changes

- 292ae33: createAgentServer answers HEAD /health (the verb a load-balancer check sends by default, which fell through to a 404) and logs a Serving line naming the routes it mounts. The scaffold's server.mjs now reports a boot configuration failure — a missing provider key, an unreachable DATABASE_URL, a port in use — as a message plus the fix and a non-zero exit, instead of a traceback into bundled dist internals, and warns that a databaseless deployment needs sticky sessions behind a load balancer.
- 79e3ea6: Cut duplicated logic and wasted work across the host runtime.
  
  Seven near-copies collapsed onto the helper that already owned each rule: `publicWebhookUrl` composes its URL through `workflowWebhookUrl` (base, prefix and token encoding are three independently-wrong-able parts, and a webhook URL that does not match the path parsing it 404s weeks later on somebody else's server); the five spellings of "a descriptor's `apiKeyEnv` beats the registry default" become one `envVarOf`, the omission of which had already made a preflight demand a variable the session does not read; three cycle-safe `cause` walks in the error classifier become one, where the file's own doc claimed there was already only one; and `safeJsonParse`, `errorMessage`, `pushCapped`, `codeUnit` and `shell.streamError` replace hand-rolled copies. Seven separate silent `Logger` objects become one `silentLogger` beside `consoleLogger` — placed there rather than in the test utils because the fuzz harnesses are compiled by the declaration build and may not import a vitest-backed module.
  
  Wasted work removed on four hot paths: the telephony bridge scans a session frame before parsing it (it acts on four event types out of the ~50 a turn emits, and the transcript frames it discards are the largest on the wire); the OpenAI SSE repair transform encodes and enqueues once per network chunk instead of once per line, on the time-to-first-token path of every turn; gateway tool schemas are pruned once per schema object instead of once per LLM request; and two regexes that were being allocated once per CHARACTER — on every STT partial, and on every barge-in alignment — are hoisted to module scope. A brokered blob read now cancels the response body on 404/416, which was leaving a pooled connection unusable until GC.
  
  Also: the telephony bridge's PCM16-to-bytes view goes through `pcm16ToBytes`, restoring the endianness check that module exists to own; two harness outcome types are derived from `JournalOutcome` rather than re-declaring its six fields, so widening the shared reader cannot leave a property law silently unable to see the new one; a write-only step accumulator, two dead eval symbols and a dead fuzz type are deleted; and three doc blocks that described deleted mechanisms are corrected.
- 1a093ea: Document how to build a server in the aai-runtime README: the three shapes from examples/ (self-hosted single agent via createAgentServer + withToolsDir, multi-tenant createHostServer, and embedding via createRuntime), each with a compiling example and links to the runnable example.
- 5fc40e3: Cut three sources of durable-workflow latency, and make a run's journal RPCs
  readable in production logs.
  
  - **A run that settles in this process wakes its watchers immediately.** The
    synchronous `wait=`, the SSE stream and the notify watcher discovered a
    finished run on their own timer, so a run that completed here was reported up
    to a full poll interval later. The engine now signals the shared reads, which
    brings their next journal READ forward — no snapshot is pushed and nothing is
    resolved from it, so a run walked by another replica is unaffected.
  - **A sleep shorter than the queue's poll interval no longer costs a whole
    one.** A short park is announced, and the pass it wakes reads the deadline out
    of the queue and arms one extra look at it — which is how "due at T" gets
    expressed without giving the notification a payload. A long park still
    announces nothing.
  - **The journal method rides the path** (`/:slug/workflow-journal/<method>`), so
    a per-request log line decomposes per operation at zero added volume. The
    method is still sent in the body and the bare route still answers it, because
    a deployed agent bundle carries its own copy of the runtime.
- a9c1577: Generalize the gateway tool-schema prune into a provider-compat layer: the verified $schema/propertyNames removal still runs for every model, and a Gemini layer selected by model id additionally folds the constraints its function-calling subset cannot express (string formats and lengths, number bounds, array lengths, defaults) into the schema description rather than dropping them, and restates const, oneOf, type unions and tuples inside the subset.
- 292ae33: ctx.generate now validates a schema call's reply against the caller's own schema. jsonSchema() only describes a shape to the provider and carries no validator, so a model reply that missed the schema was returned as GenerateObjectResult<T>.object typed as T and unchecked. A Standard Schema call now returns the PARSED value and throws naming the failing property; a plain JSON Schema call keeps working, with the reply's top-level type checked against the document's own.
- Updated dependencies [b5beca2]
- Updated dependencies [79e3ea6]
- Updated dependencies [a9c1577]
- Updated dependencies [292ae33]
- Updated dependencies [292ae33]
- Updated dependencies [79e3ea6]
- Updated dependencies [292ae33]
- Updated dependencies [a9c1577]
- Updated dependencies [ef096bb]
  - @alexkroman1/aai@14.0.0

## 13.3.0

### Minor Changes

- 130898e: Carry every guest→platform call down one multiplexed WebSocket, with the five HTTP routes kept as the fallback. A deployed guest opens `WS /:slug/platform-socket` once per process and frames session state, upload records, the workflow journal, its key index and enqueues onto it; the platform turns each frame back into a real request through the same Hono app, so every route's status, body cap and bearer check are unchanged. A call the socket refuses before writing falls back to HTTP; one already written does not, so nothing is applied twice.

### Patch Changes

- 14c54ac: eval: refuse a turn nothing about the agent can be read off. A turn the pipeline failed (a rejected credential, a provider error) is answered with errorPhrase, so a live refusal case passed against a rejected key; a scripted tool call naming a tool the agent does not declare emitted tool.called, never ran, and left result undefined. Both now fail the case, naming the provider error (an empty provider message reads as "(no message)") or the tools the agent really has. A suite whose every case is skipped by the mode gate now FAILS instead of exiting 0 green and empty, and every suite announces how many of its cases the chosen mode will run. A stubGenerate answer its own call's schema rejects is refused rather than handed back as a typed lie.
- 78ed86c: Open a workflow delivery in ONE platform round trip, and place guest sandboxes where the platform database is.
  
  `execute` awaited `journal.getRun(runId)` and only then issued the step read, the wait read and the `running` compare-and-set — so every delivery paid two sequential round trips (~840 ms each on the platform arm) before a body could run. Nothing in that opening depends on the record: the three reads are pure functions of the run id and the set carries its own `expect`, so all four are now issued together. A set that loses is re-asked rather than believed — issued beside the record read it can reach the store ahead of a racing `start`'s `createRun` and decline a run that exists a moment later.
  
  `modal_deploy.py` also exports its own `REGIONS` list as `MODAL_SANDBOX_REGION`, so guests are placed in the platform's region instead of wherever Modal finds capacity: a durable run's journal calls are made by the guest, sequentially, at ~24 ms an operation out of region against ~2 ms in it. It is the LIST rather than a single region — a bare pin is what once made a spawn Modal could not schedule fail the session with `Sandbox operation timed out`.
- @alexkroman1/aai@13.3.0

## 13.2.0

### Minor Changes

- 93ea30c: eval: publish the four affordances every template eval was hand-rolling — `toolNames`/`describeToolCalls` and `describeTurn` (the turn diagnostic behind ten `expect(value, message)` sites across five templates), `EvalSession.sayAll` with `callsIn`/`turnCalling` (so a case asserts about the turn a mechanism fired in rather than pinning a turn index, which is a flake with a misleading name), and `EvalWorkflows.settleAll` — plus `close()` now warning about a run it abandons instead of letting a mid-flight body call out on the next case's fakes or a real key.

### Patch Changes

- 9cb7392: Keep millisecond precision in a durable workflow's wake delay: a sub-second `ctx.sleep` was ceiled to a whole second by the platform dispatcher, adding ~1,000 ms to every wake (a measured 100 ms sleep resumed at ~1,780 ms). The delay is now ceiled at MILLISECOND granularity, which still guarantees a delivery is never earlier than the deadline.
- Updated dependencies [4fb6b05]
  - @alexkroman1/aai@13.2.0

## 13.1.0

### Minor Changes

- 61fe5cd: An attempt charge becomes a lease that EXPIRES, so a dead walk cannot refuse a healthy step forever. claimAttempt charges an attempt before a step body runs and answers how many are outstanding; a crash burns one, which is the mechanism that stops a wedging step being redelivered forever. But a scalar counter cannot expire: the charge a dead walk left was indistinguishable from a live one, so it stood permanently and maxAttempts deaths on one step key refused that step for the life of the run, with StepAbandonedError reporting a run nobody could revive — the residual workflow-replay-step.ts named and said needed a heartbeat to close. claimAttempt and releaseAttempt now take the walk's own id as a holder, and claimAttempt takes the window a charge counts for; the store keeps one row per (run, key) holding a map of holder to when it claimed, prunes what has aged out on every claim, and answers the number of live holders. A re-claim by a holder that already has a charge answers the same number rather than a higher one, which also makes the call idempotent over an at-least-once transport. The window is an hour and there is no heartbeat, so it deliberately clears the longest walk that can legitimately be running — erring long is recoverable where erring short removes the ceiling. One row per key rather than one per holder is the atomicity: measured on a real Postgres, a row per holder answered [1, 1, 3] for three concurrent claims against a contract that no two ever agree.

### Patch Changes

- 61fe5cd: Split the runtime's own egress into two connection pools: rpcFetch for a platform route (a kilobyte of JSON, one per step transition, bursts StepGate bounds at 16) and blobFetch for an upload window's bytes (up to UPLOAD_PART_BYTES, 32 concurrent probes per part claim). They were one pool, so the byte path could occupy the sockets a journal write then queued behind, and one allowH2 answer served both shapes though the measurement behind it — 14 of 16 concurrent 17.66MB requests completing over HTTP/2 against 16 over HTTP/1.1 — is about multi-megabyte bodies exhausting a flow-control window, which a kilobyte of JSON cannot do. Both still default to HTTP/1.1; what changes is that the RPC pool's answer is a decision rather than inheritance, and AAI_EGRESS_RPC_HTTP2 lets an operator revisit it without a deploy. That switch raises the pool's in-flight stream gate in the same breath, because undici gates H2 streams behind pipelining and leaving it at the HTTP/1.1 answer of 1 would make the switch strictly slower than what it replaced. The byte pool takes no such switch: HTTP/2 there is the configuration that was measured failing.
- 61fe5cd: Carry a W3C traceparent on every guest-to-platform RPC, and read it at the route. The busiest of those calls costs ~840ms of server time and that was a total with no breakdown: withReserved measures the server's half (how long the admin reservation waited, how long the statement ran) and the rest of the wall clock — the proxy, the round trip, anything queued before the handler ran — was unaccounted. Both halves are now measured; what was missing was the ability to put one beside the other, since a busy replica writes hundreds of these lines a second and a timestamp cannot correlate them. The runtime mints one span per call and logs its elapsed at debug, the platform route puts the trace id on every line withReserved writes, and 863ms against a waited+work of 43ms is a conclusion neither side could reach alone. W3C rather than a private header so an OTEL collector later reads these spans for free. ReservedCall declares the trace as a required key with an optional value, so a new platform route cannot forget to look for one.
- @alexkroman1/aai@13.1.0

## 13.0.0

### Major Changes

- b94fdd1: Read an upload's record ONCE per read, not once per chunk.
  
  `UploadReader.info` and `UploadReader.read` each resolve the record for themselves and every reader needs both, so one logical read cost two look-ups of one row and the byte route cost one per `UPLOAD_CHUNK_BYTES` of the answer. On a deployed guest a look-up is a `POST /:slug/upload-records` across the platform and into the admin pool — measured over 48h of production at n=1428, mean 537ms, and within one 33-segment transcription it outnumbered the journal 515 to 212 for a run that moved 140 part windows.
  
  `UploadReader.open(id)` hands back the record AND a reader bound to the windows THAT record named. `readUpload` is 1 look-up where it was 2; `GET /workflows/uploads/:id` is 1 where it was N+1 for an N-chunk answer. It also PINS the window map for the operation, which the route's own `Content-Length` was already assuming: a part landing mid-download could previously answer bytes the header had promised were something else.
  
  BREAKING: `UploadStore` gains a required `open(id)`, so a host implementing that interface must supply one. `UploadReader.open` is OPTIONAL and `readUpload` falls back to `info` + `read`, so every two-method fake — `stubUploads` included — is unchanged.
  
  The claim path is deliberately untouched at two calls: `recordParts` reads before it writes because it validates every named window against the DECLARED total and decides the finished-upload refusal, neither of which the write can see.
- b94fdd1: Answer an ELAPSED durable wait from the walk's own snapshot, so a polling run's journal traffic stops being quadratic.
  
  A replay answered a settled `ctx.step` from the one `readSteps` it takes at the top of a walk, and round-tripped `claimSleep` for every elapsed `ctx.sleep` it walked past — an unconditional call whose answer was almost always "that finished several deliveries ago". A body that polls mints a new wait key per iteration, so delivery N re-claimed N-1 finished waits before doing any work. Measured on a deployed 34-segment transcription run: journal POSTs rose +1 per delivery, monotonically, across 69 consecutive deliveries — 2,675 in 25 minutes, the gap between deliveries growing 11s to 37s in step with the count, and the run never completed. Every call succeeded, so the only symptom was a run getting slower.
  
  BREAKING: `JournalStore` gains a required `readSleeps(runId)`. A host supplying its own journal through `RuntimeOptions.journal` must implement it: it answers every durable wait of a run, ordered by key, as a `SleepEntry` (a `SleepRecord` plus its key). Both shipped databases key the sleeps table on (run_id, key), so it is a range scan already in that order and needs no migration. The engine issues it beside `readSteps`, concurrently, and hands it down as `ReplayOptions.sleeps`.
  
  The snapshot may only answer a wait it already HOLDS and that is over by a monotonic test — woken, or a deadline already past. `claimSleep` is a claim rather than a read, so a miss must still create the record, and a future-dated unwoken wait must still round-trip in case a wake landed since. A stale snapshot can therefore only ever cost a round trip it did not need.

### Patch Changes

- 4647b84: The durable-workflow queue claim reads two new columns instead of re-deriving them every tick: `workflow_queue.run_id` (generated from the payload envelope) and `workflow_queue.kind` (written at enqueue from the DevKit queue-name grammar). A busy tick goes 516 ms to 20 ms and an idle one 1.7 ms to 0.9 ms on a 200,000-row queue, and the expression index the old spelling needed is dropped with nothing in its place. Also: a zero-delay re-park now notifies, so a guest parking a busy walk no longer waits out a whole poll interval; and `STEP_QUEUE_NAME_PATTERN`/`WORKFLOW_QUEUE_NAME_PATTERN` leave `@alexkroman1/aai-runtime/internal`, which existed only to cross into that SQL.
- ef6c39c: Workflow engine performance and concurrency: the divergence check scans the journal with a cursor rather than re-scanning every journaled step per fresh step, the step gate dequeues waiters through a head cursor rather than an O(n) shift, a walk issues its two opening journal reads together rather than one after the other, the memory journal answers readStep from its key index rather than a scan, and the in-process dispatcher collapses deliveries that arrive during a walk into one deferred re-delivery instead of racing concurrent walks of the same run.
- 4647b84: Give the workflow correlation-key index a platform backend, so a deployed run
  stays findable by the caller who started it.
  
  `(workflow, key) -> runId` is the only pointer from a caller to the durable run
  their last call started, and it had two backends: the agent's own `DATABASE_URL`
  and a `Map`. The platform provisions no tenant database, so on a typical deployed
  agent `resolveKeyStore` fell to the `Map` — inside a sandbox that self-exits after
  `AGENT_IDLE_EXIT_MS`. Since the journal gained its platform backend the RUN
  outlives that sandbox and the pointer did not, so `find()` answered `[]` on the
  caller's next call and the agent started a second run for somebody it had already
  served. Nothing reported it: an empty index and a first-time caller are the same
  answer, and the boot line printed `keyStore: "memory"` on every deployment.
  
  The third implementation is `createPlatformKeyStore`, one `POST
  /:slug/workflow-keys` per call over the per-sandbox bearer, against a new
  slug-scoped `aai_platform.workflow_run_keys` under deny-all RLS. `selectKeyStore`
  resolves platform, then postgres, then memory — the same preference
  `selectJournal` makes, so the runs and the index cannot land in different homes —
  and the boot line now names which one won. A new hourly pg_cron sweep collects a
  key whose run the retention pass already deleted.
- ef6c39c: The self-hosted journal's boot-sweep query reads the wait table once instead of once per candidate run. resumableRuns computed each run's earliest wake with a correlated subquery inside a CTE, which Postgres inlines - so the expression was re-planned as a fresh index scan at each of its three sites (filter, sort key, output). A grouped left join plus a hashed anti-join takes it from 349-375ms and 123,102 shared buffers to 24-28ms and 1,194, result-identical over the whole answer, verified with EXPLAIN ANALYZE against a real Postgres holding 50,000 runs. It matters because aai dev rebuilds its runtime on every file save and each rebuild is a boot sweep.
- Updated dependencies [9e12bb2]
- Updated dependencies [9e12bb2]
- Updated dependencies [9584e2e]
- Updated dependencies [9584e2e]
  - @alexkroman1/aai@13.0.0

## 12.0.0

### Major Changes

- 4507050: Bound a durable run's journal growth, and answer the contended step read by key.
  
  A live run's journal could grow without limit. Retention only ever bounded the POPULATION — `sweep_terminal_workflow_runs()` deletes terminal runs after 30 days — and a live run is not eligible for it at any size, nor can its journal be truncated, because replay answers every settled key from it. The cost is O(N) per delivery and O(N squared) across a run, since every walk reads the whole journal, so a long run got monotonically slower at doing the next step and eventually became undeliverable with nothing said. `workflow-journal-bound.ts` now warns at 8,000 journaled steps naming the count and the ceiling, and refuses at 10,000 with a message naming the remedy, before a body runs.
  
  BREAKING: `JournalStore` gains a required `readStep(runId, key)`. A host supplying its own journal through `RuntimeOptions.journal` must implement it: it answers ONE settled step by key, or undefined when it has not settled. `settledSince` — the re-read on the contended path, reached when `claimAttempt` says another walk touched a key — used to read the whole journal and keep one entry, an O(N) scan for an O(1) question in exactly the runs where N is largest. Both shipped databases key the step table on (run_id, key), so it is an index seek and needs no migration.

### Patch Changes

- @alexkroman1/aai@12.0.0

## 11.0.0

### Minor Changes

- 36a3f22: Make a `createAgentServer` forwarding gap unrepresentable, and close the fourth one.
  
  `AgentServerOptions` is a hand-written subset of `RuntimeOptions` where every field is optional, so an option added to the runtime is silently unreachable through the door most deployments use. That is not a hazard to remember — it has happened FOUR times, and each was found by somebody needing the option rather than by anything checking: `telephony` mounted an unauthenticated `WS /phone` with no way to switch it off, `page` served a static agent the voice surfaces, `env` left `AAI_WORKFLOW_API_TOKEN` and `DATABASE_URL` doing nothing, and `journal` left a deployment that owns a database unable to say so.
  
  `journal` is forwarded now. And `agent-server-forwarding.ts` is what stops a fifth: every `RuntimeOptions` member is either on `AgentServerOptions` or on an explicit `UnforwardedRuntimeOption` deny-list carrying its reason, and `ForwardingGap` is the subtraction — `never` today, and the NAME of the offending member the moment one is added. It fails `turbo run typecheck` AND the build, since the module is compiled by `tsconfig.build.json` and a build failure cannot be skipped by a test filter. Same shape as `AgentConfigSchema`'s `HOST_ONLY_AGENT_FIELDS` subtraction one package over, for the same reason.
  
  Checked in BOTH directions, and the reverse one earned its place immediately: a `StaleExcuse` (an entry naming a member `RuntimeOptions` no longer has) and a `RedundantExcuse` (one the door now forwards) each fail the same way, and the first caught three wrong entries on its first run — a draft excused `name`, `greeting` and `hostBaseAgent`, none of which is a `RuntimeOptions` member at all.
- 6bbef9b: Add `@alexkroman1/aai-runtime/testing` — `runWorkflow`, which starts a declared workflow on the real replay engine over an in-memory journal so a spec can assert that a run suspended, resumed off its journal, retried, was answered by a signal, and survived a worker that died mid-step. The constraint the older helpers cite — that a body is only durable after a compile-time transform — has not been true since the Workflow DevKit was replaced.
- 36a3f22: Record which CODE a durable run was started against. `RunRecord.codeVersion` joins the journal, and the divergence message uses it to state whether the code changed instead of handing the reader a test.
  
  A run outlives the process that started it — that is what durable means — so it also outlives the bundle: a `ctx.sleep("nextDigest", DAY_MS)` parks for a day, deploys land, and the delivery that wakes it replays the body from whatever bundle the sandbox now runs. The engine has always been honest that resuming a run against a changed body is unsupported and had no way to say whether that is what happened.
  
  The cost showed up in the sharpest error this engine produces. `workflow-replay-divergence.ts`'s message ends by handing the reader a test to run against their own source, because the two causes of an unreached step key — a redeploy mid-flight, or a non-deterministic body — want opposite fixes, and a journal holds what a value WAS and never how it was produced. One version per run settles half of it: an inequality states the redeploy and names both bundles, an equality ELIMINATES it and leaves the computed name as the only remaining cause. The two-cause fork stays in the text either way, because it is what tells a reader what to look for.
  
  It is a DIAGNOSTIC and never a gate. Nothing refuses a run whose version moved: a deploy touching a page, a tool, a prompt or an unrelated workflow leaves this body's step sequence identical while the bundle hash changes on every deploy, so refusing on inequality would fail nearly all such runs to catch the few that really diverged — and the divergence check already catches those precisely, at the step that proves it.
  
  The value is read from THIS PROCESS's environment (`AAI_BUNDLE_SHA256`), never the agent's, for the reason `platformGuestOptions` is a separate name from `resolvePlatformQueue`: `agentServerEnv` strips only `AAI_ALLOW_HOST`, so an agent may set any other `AAI_*` key as a secret. Read from a tenant env, an agent could pin its own version and every walk would then report the code unchanged — which is worse than no version at all, since the message would assert as a fact the one cause it had ruled out. Absence therefore means UNKNOWN in both directions and must never read as unchanged; only a deployed guest has a hash, so `aai dev` and a self-hosted server keep the original two-cause fork.
  
  All four journal backends carry it, `20260902010000_workflow_run_code_version.sql` adds the platform column, and three conformance cases pin the round trip — one of them asserting `listRuns` carries it and not only `getRun`, which caught two live instances of exactly that: the postgres arm's second select, and the unit platform arm's fake transport, whose run-row field list was written out twice and is now one function.

### Patch Changes

- 165f9b2: Make the durable-workflow journal's first-write-wins claims one statement each and retry the indeterminate answer, escape the characters PostgreSQL cannot store, and give the reconcile pass an end so a run its guest can never finish is failed rather than re-walked forever.
- 623a8bb: Collapse duplicate workflow-journal round trips and widen the platform admin pool.
  
  A deployed run's every journal operation is one `POST /:slug/workflow-journal`, measured at ~840 ms of platform time each. Three things multiplied them: a fan-out's stale-snapshot check re-read the whole journal once per step, overlapping walks each opened with their own `getRun` and `readSteps`, and every delivery took three of those round trips sequentially before a body ran.
  
  Concurrent identical `getRun`/`readSteps` now share one round trip (a coalescer, not a cache — no caller is answered from a read that started before it asked), and a delivery's step read is issued beside the `running` compare-and-set rather than after it. `ADMIN_POOL_MAX` goes 4 to 16: guest platform routes reserve a connection for the whole request, so 4 was a hard ceiling of four in-flight guest calls per replica, and with `PLATFORM_POOLER_URL` in transaction mode the pool costs the instance's max_connections nothing.
- 36a3f22: Re-take the rollback property's coverage floors at `numRuns: 80`, because two of them were unsatisfiable at 20.
  
  `pipeline-history-rollback-property.test.ts` aggregates its five reach counters across the property's runs, so `numRuns` is what decides how heavy their left tail is. Measured over 24 consecutive runs at 20: `toolHealedAtCap` came out **0 twice** against a floor of `> 10` — a state the corpus simply failed to reach on ~8% of green runs, so no positive floor was settable at all — and `atCapConversation` produced the **144** that failed a real CI job against a floor of 200 whose recorded range started at 442.
  
  Neither recorded range was wrong when it was taken. Twenty draws was too few to describe the unluckiest run, which is the failure mode `AGENTS.md` warns about in the same paragraph that says to floor under the observed minimum: what one script reaches is correlated across all 260 of its steps rather than independent per step.
  
  So the fix is the draw count rather than lower numbers — a floor under a distribution whose minimum is zero cannot be set. Four times the draws costs 635ms → ~2.6s against the unit tier's 5s budget, and it moves `toolHealedAtCap`'s observed minimum from 0 to 672. Every floor is re-taken over 14 consecutive runs at 80 with its new range recorded in place.
- Updated dependencies [36a3f22]
- Updated dependencies [0718b57]
- Updated dependencies [fe3b6d6]
- Updated dependencies [63e1c8e]
- Updated dependencies [36a3f22]
- Updated dependencies [f10b6aa]
- Updated dependencies [7ab47cf]
- Updated dependencies [31459e8]
  - @alexkroman1/aai@11.0.0

## 10.0.1

### Patch Changes

- f35bdf7: Fix a durable-workflow livelock and the park cadence that hid it.
  
  A workflow step longer than the guest's idle window never completed in production. The guest counted workflow work by HTTP RESPONSE, so the platform's 60s delivery abort read as an idle guest while the walk carried on; the sandbox self-exited mid-step `AGENT_IDLE_EXIT_MS` later and a fresh one restarted the same step, forever. Activity is now counted at the WALK — the promise the delivery door already awaits — so a running step keeps the guest alive and an idle one still exits promptly. A parked delivery is credited nothing, deliberately.
  
  The guest half reaches production through a platform DEPLOY rather than through its own version — the harness is baked into the guest image, whose content-addressed tag the server pins at deploy time — which is why `aai-server` is named alongside it.
  
  The park delay is also proportionate to the walk instead of a flat 5 seconds: `clamp(walkingForSeconds / 8, 5, 120)`, with the log line on the same curve. A 15-minute step now costs ~24 queue round trips and ~24 log lines rather than ~170 of each, while a brief race between two deliveries still gets its fast 5s retry.
- @alexkroman1/aai@10.0.1

## 10.0.0

### Major Changes

- dd699c7: Remove the Workflow DevKit's world, compiled surface and queue callbacks. `AgentServerOptions` loses `workflowCode`/`stepCode` and the `SweepSkip` type is gone; neither has a mechanism behind it now.

### Minor Changes

- dd699c7: Raise the workflow step-concurrency default from 3 to 16, measured against a guest rather than inherited from graphile-worker. A fan-out was capped at three whatever the body asked for, so a template's own measured width was inert. Sixteen is what a real libkrun microVM holds at Modal's guaranteed reservation (1 CPU / 1024 MB): a concurrent transcription segment costs 26.1 MB at 48 kHz stereo, putting sixteen at 576 MB of 982 MB usable. Also raises the workflow progress-poll default from 1s to 5s — two of those hooks on one run spend a page's entire per-IP request budget and contend with the upload for the same link.
- dd699c7: `SessionStateBackend.discard` now reclaims a session's EVENT LOG as well as its slots on every backend. `createPostgresStateBackend` dropped slots only and left the log to the retention sweep, so "discarded" meant two different things depending on whether a session ran self-hosted or on the platform; the append-only grant that justified the asymmetry no longer exists. One CTE, so the pair is atomic against a concurrent append, and the retention sweep stays as the backstop for a session whose guest died before it discarded.
- dd699c7: Persist durable workflow runs to Postgres when a `DATABASE_URL` is configured, so a run survives a restart instead of living in the process that started it.
- dd699c7: Make a deployed run's `ctx.sleep` come back: the platform's queue now holds a deployed workflow's schedule, instead of a `setTimeout` that dies with the sandbox.
- dd699c7: Make a DEPLOYED durable workflow run actually durable: its journal now lives in the platform's database rather than in a sandbox that self-exits.
- dd699c7: Bound how many workflow step bodies execute at once. The DevKit's world provided this and the replay engine did not, so a body's fan-out width became its execution concurrency and killed a guest.
- dd699c7: Share the workflow API's one-shot run reads, bound the platform pool's reserve, and answer a platform shortage as 503 rather than 500. `GET /runs/:id` and `/runs/:id/stream` each opened their own journal read, so N concurrent readers of one run cost N round trips against a four-connection admin pool; they now join the same coalesced read. `createPostgresDb` gains an optional `reserveTimeoutMs`, and an exhausted pool is reported rather than waiting forever behind a caller that has already given up.

### Patch Changes

- dd699c7: Roll an injected prompt back completely when the conversation window is full. `dropTrailingUser` popped where the push had already trimmed, so a resume prompt, silence nudge or `injectTurn` rolled back at the 200-message cap permanently cost the oldest real conversation turn. The LLM view could lose two, since capping can orphan a `tool` result its removal split.
- dd699c7: `createRuntime` now refuses `executeTool` without `toolSchemas` (and the reverse) instead of silently running the in-process tool path with no tools. A lone `executeTool` used to discard the caller's relay entirely and answer every call with `Unknown tool`.
- dd699c7: Refuse a session event the platform cannot read instead of dropping it from the page. A read of the session event stream is a cursor, so a skipped entry was an event silently gone rather than a degraded answer — and an entry whose index coerced to `0` was worse, taking the place of the session's real first event. Both ends of the wire now refuse what they cannot read.
- dd699c7: A streamed upload whose body dies now keeps the window it was filling. The growing window cut buffered up to 8 MiB against its next target and discarded it when the body failed, so a torn stream published less than had actually arrived.
- dd699c7: Restore workflow progress streaming on deployed agents. The run context was a module-level AsyncLocalStorage, so the harness's copy of the runtime and the agent bundle's copy each had their own — a step's `report()` found no context, streamed nothing, and logged an empty context object.
- dd699c7: Fix the in-memory workflow correlation-key index to record each run id at most once, matching the Postgres store's `on conflict (run_id) do nothing`. A retried `record` after a lost connection used to list the same run twice, promote it past a newer run, and index it under a second key — found by the new shared WorkflowKeyStore conformance table.
- dd699c7: A malformed base64 audio frame is now reported — one warning per 10s per logger, carrying the running count — instead of being dropped silently. The three callers that own a session log there; the three provider openers use the default logger.
- dd699c7: Bound a step's outbound HTTP again. The step fetch pool had undici's header and body timeouts disabled, justified partly by a step budget the DevKit removal deleted, so a `stepFetch` call passing no signal had a deadline from no layer at all. Both are set to a 10-minute INACTIVITY bound — undici's timers are phase timers, not total-duration ones, so the number does not scale with the payload — and the walk's `AbortSignal` now reaches every step request, so a cancelled run stops its in-flight I/O instead of finishing an upload nobody is waiting for.
- dd699c7: A step that suspends no longer spends its own retry budget. An attempt is now a lease: tries are counted in the walk, and the durable charge is given back when a body suspends, so overlapping deliveries of one run can no longer exhaust a budget between them and journal `failed` over a step that had succeeded. The refusal is a verdict about the walk rather than a journal entry, so only a walk whose own body threw can write a `failed` entry.
- dd699c7: A completed run's snapshot falls back to `WdkAdapter.readOutput` when the record carries no `output`, which is legal for an adapter written against a retained epoch. Such adapters silently reported `output: undefined` for every completed run.
- dd699c7: Remove the Workflow DevKit adapter, which the replay engine replaced.
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
  - @alexkroman1/aai@10.0.0

## 9.2.0

### Patch Changes

- 1e5170a: Stop an author's own data from forging a typed-JSON envelope, and decode base64 strictly.
  
  The workflow wire codec tagged binary as `{ __type: "Uint8Array", data }` and dates as
  `{ __type: "Date", iso }`, and both revivers recognised one structurally — so a plain
  object of that shape, written by an author, decoded as a `Uint8Array` or a `Date` at any
  nesting depth with nothing raised. A run's input arrives over public HTTP, so that was
  reachable type confusion. An author's reserved keys are now escaped on the way out and
  unescaped on the way in, which makes the round trip total for every JSON value.
  
  Decoding a malformed base64 payload used to return arbitrary bytes, because
  `Buffer.from(s, "base64")` drops characters outside the alphabet; it now throws. A date
  envelope whose `iso` will not parse throws rather than reviving the `NaN` that previously
  stalled durable runs.
  
  A bare `__type` envelope still decodes exactly as before, so data already on the wire is
  unaffected — deploy the decoder first.
- Updated dependencies [1ad4977]
- Updated dependencies [bee46bc]
  - @alexkroman1/aai@9.2.0

## 9.1.0

### Patch Changes

- Updated dependencies [041a5a2]
  - @alexkroman1/aai@9.1.0

## 9.0.2

### Patch Changes

- dcb2050: Pin the runtime's own outbound fetch to HTTP/1.1, and answer a transport failure as a 503.
  
  Every call the runtime made of its own — the upload broker's byte operations, the operator-bucket ones beside them, every platform RPC, and the run-event stream read — used `globalThis.fetch`, which undici 8 lets negotiate HTTP/2. A deployed guest's concurrent requests to one origin were therefore multiplexed onto one connection, where a capacity limit arrives as a stream reset carrying no HTTP status: a part claim's bucket probes and an unrelated run-event stream failed with `fetch failed` in the same instant, and the claim answered `500 Internal server error`, so the browser re-sent windows it had already stored into the same fault. They now share one HTTP/1.1 keep-alive pool, the same fix `stepFetch` already had, and a transport failure answers 503 with a `Retry-After` instead of an opaque 500.
- cc317e4: Read a plain-text tool result as text in the eval helpers instead of throwing a SyntaxError
- @alexkroman1/aai@9.0.2

## 9.0.1

### Patch Changes

- 533e217: Cut a batched upload part claim from three record round trips and eight probe rounds to one read, one write, and probes that run alongside them.
- 533e217: Retry a transient guest-to-platform upload byte operation instead of failing a whole batched part claim with a 500.
- @alexkroman1/aai@9.0.1

## 9.0.0

### Major Changes

- 1f21e37: Retire the durable-workflow wake hint. The platform's delivery sweep IS the wake now: it claims due messages from a table with a slug and an available_at and brokers a sandbox to deliver them, which is the query the DevKit's own schema could not answer and the whole reason a per-app hint table existed. Removes createWakeHintPublisher, WakeHintOptions, WakeHintPublisher and WORKFLOW_WAKE_TABLE from /internal — a removal from a published subpath, hence major, though that subpath carries no capability contract by construction.

### Minor Changes

- 006cc1e: Add the guest's HTTP Storage client and the JSON-with-binary wire codec both sides of platform-owned run storage use. The codec reads a value's raw form before toJSON, which is what carries a Buffer across the wire as bytes instead of {type:"Buffer"} — the Postgres world returns Buffers for every bytea column.
- bccae5a: Add the guest-side platform queue client: `queue()` becomes one authenticated POST to the agent's own `/:slug/workflow-enqueue` instead of a graphile-worker job against the tenant's database. No new credential — the per-sandbox bearer the guest already holds to verify inbound platform requests proves the reverse outbound, and it is bound to one sandbox name so it authorizes exactly one slug.
- fcb113c: Add the live stream read: GET /:slug/workflow-stream on the platform and the guest client for readFromStream. The HTTP body IS the stream; the response is bounded so a stream whose run died cannot hold a connection forever, and the guest resumes with startIndex.
- 9115625: Add the platform's queue-delivery door: a host-only `POST /workflow-queue` that dispatches a delivered message to the flow or step entrypoint by the DevKit's queue-name grammar. One door rather than widening the loopback gate on the two callbacks, so that grammar is parsed on the side that depends on the DevKit; refused unless the composition vouches for the caller, which `aai dev`, host mode and a self-hosted server do not.
- 7dd348f: A deployed guest's durable-workflow world is now the platform's: journal, streams and queue all reached over HTTP, with only the DevKit's createQueueHandler kept locally. The platform world wins over a DATABASE_URL, so a workflow agent opens no database of its own for runs.
- 9e41442: Self-hosted agents run durable workflows. `createAgentServer` now configures a workflow world and mounts the DevKit's flow/step callback routes, off two new optional options (`workflowCode`/`stepCode`) that the scaffold's `server.mjs` reads from its built worker. Before this, only `aai dev` and the platform guest ever called `configureWorkflowWorld`/`startWorkflowWorldIfDeclared`, so a self-hosted server accepted a run and no world was ever started to execute it — it sat pending with nothing logged. Also splits the DevKit queue-name grammar into two exhaustive patterns (`WORKFLOW_QUEUE_NAME_PATTERN`, `STEP_QUEUE_NAME_PATTERN`) on `@alexkroman1/aai-runtime/internal`, so a name matching neither is refused rather than silently classified.
- 95be1ca: Bound platform-facing Postgres access so a network partition sheds load instead of hanging: createPostgresDb gains optional connectTimeoutSeconds and queryTimeoutMs (a client-side per-pooled-query deadline — the only bound that survives a silent partition, where a server statement_timeout's cancellation notice is blackholed too; reserved/advisory-lock connections are exempt). The self-hosting createServer also sets an explicit headers timeout and keep-alive timeout to reap slowloris connections on its public surface.
- c871232: Compose the platform-owned queue into the DevKit's Postgres world: a deployed guest now enqueues through the platform and never subscribes graphile-worker. Storage and the streamer stay in the tenant's own database, so this gives back graphile's held LISTEN connection and its worker concurrency rather than the whole workflow surcharge.
- 857c3d9: Move workflow upload records to the platform's own database, so a deployed guest keeps nothing durable on local disk. createUploadStore chose an upload's home from whether the agent had a ctx.db, on the premise that a database meant durable runs — which the platform workflow world falsified. A deployed guest with no DATABASE_URL therefore got durable runs with their uploads in a directory that recycles, which is how one sandbox filled its filesystem and ENOSPC'd every write. The platform arm is now checked first, ahead of a DATABASE_URL, the same way the workflow world is.
- 6d360a7: Preserve turn-level durability without a tenant database: a third SessionStateBackend that keeps a session's slots and event log on the platform, reached over HTTP. It wins over a DATABASE_URL, so a deployed agent's durability no longer depends on whether it provisioned a database. SessionStateBackend.name gains "platform" (epoch 1 retained — widening a field an implementor supplies is not breaking).
- 4743746: Durable-workflow delivery is NOTIFY-driven. enqueue announces on a Postgres channel when a message is due now and a replica listens, so a step-to-step hop no longer pays the poll interval — the same thing graphile-worker does with jobs:insert. The interval stays as the timer for PARKED messages, which a notification cannot express, and as the mechanism that makes delivery eventual when a listener is reconnecting. CloseableDb gains a required listen() member; aai-runtime:db epoch 2 is RETAINED, since adding a member to a type a caller receives is not breaking for a consumer, and a frozen example proves it.
- 9690f28: Add the guest's Streamer client (six of seven members; readFromStream's live stream needs its own route) and per-tenant stream names on the platform. Their readFromStream looks a stream up by name alone with no run filter, so in one shared schema two agents sharing a name would share a stream — the platform qualifies the name on the way in and strips it on the way out.
- af284a7: Publish ensureSessionStateSchema and call it from the scaffold's server.mjs, so a self-hosted agent with a DATABASE_URL creates its own session-state tables instead of failing every session at start.

### Patch Changes

- 65ad531: Refuse boot without AAI_PUBLIC_ORIGIN on a platform tier, and stop treating a full disk as transient. The origin was optional on the reading that only durable webhook URLs needed it; it is now the only source of the base URL a guest needs to install the platform workflow world, so unset meant every durable run silently ran on the DevKit's local world and died with its sandbox. ENOSPC now maps to 507 with no Retry-After, instead of falling through to a 500 that three layers retried.
- 841f460: The local-storage boot announcement tells the truth in both compositions it is reachable from: under `aai dev` a run and its upload survive a restart, under a per-process data directory they do not.
- 841f460: Clamp the session-events startIndex so a huge value is a page, not a 500
- 044236f: Fix durable workflow runs on the platform: carry Dates across the storage RPC (a Date arrived as an ISO string, so the DevKit computed `workflowStartedAt` as NaN, the step payload carried null, and every run stalled at `step_created`), and give the storage reply an explicit `ok` so a VOID method — every `report()` line — is not read as a protocol error. The queue path keeps the DevKit's own format, which is what its own reviver reads.
- 9d5e2a2: Serve every route from a table, and let the platform's guest-route map import it instead of re-typing it. `SERVER_ROUTES` and `WORKFLOW_CALLBACK_ROUTES` (on `/internal`) name every path this package serves; `createServer` dispatches off them, and `aai-server`'s `GUEST_ROUTES` composes ten of its seventeen entries from them rather than transcribing the strings. A renamed path is a compile error, and a new one fails a test instead of only a grep.
- af284a7: Answer `cancelled: false` rather than a 500 when a workflow run is already over, and print the eval mode on a green `aai eval` run.
- 841f460: Fix `GET /workflows/runs/:id/events` holding a silent stream for five minutes on an empty run id, and bound the stream's retry so a persistently failing read hands the client back to its poll instead of looking idle.
- 841f460: An unsafe run id in a path is a 400 rather than a 500
- 86398d7: Fix a Buffer nested in an array being serialized as Node's own `toJSON` shape instead of a binary envelope on the workflow storage wire. The replacer guarded its holder read with `isRecord`, which excludes arrays, so `{ chunks: [buf] }` crossed as `{type:"Buffer",data:[...]}` and the peer decoded a plain object rather than bytes.
- e8bc7d9: AssemblyAI streaming TTS: keep the final segment's word timings, and recognize a sentence closed by a curly quote. A `WordBoundaries` frame trails its own flush's `FlushDone` (~20 ms, measured against the sandbox host), so guarding on `turn.inFlight()` dropped the last segment's timings on every reply — the tail then degraded to the proportional heard-cursor estimate over exactly the span where per-flush padding makes it worst. The sentence-boundary and coalescer closer classes now carry `’` and `”`, which is what an LLM emits by default; a straight-only class cut mid-sentence and tripled the run-to-run duration spread (18% -> 6%) at identical time-to-first-audio.
- 4e2f9f3: Fix a guest dialling itself for every platform call under the local microVM backend: split the URL a third party dials (AAI_PUBLIC_BASE_URL) from the URL the guest dials (AAI_PLATFORM_BASE_URL), which resolvePlatformQueue now reads.
- 841f460: cancel() on a run that does not exist resolves false on every world, not just Postgres
- 841f460: A NUL in a request path segment is a 400, not a 500
- bca2d99: Answer 503 with a short `Retry-After` when a workflow request cannot get an app-database connection, instead of a generic 500 — a caller can back off on the first and not the second. A workflow app whose durable-run world cannot start now fails its boot rather than serving a guest that reports healthy and 500s forever; a voice agent keeps today's behaviour, since a broken world does not stop it answering the phone.
- 01046b6: Template evals now use the published createVmRunCode() executor instead of four byte-identical hand-rolled copies.
- 841f460: A part re-sent while its first attempt is still draining no longer fails with a 500: the local blob and record stores give each write attempt its own temp path instead of sharing a fixed one.
- 18dfb1c: Platform RPC clients share one HTTP body: a non-2xx whose reply cannot be read now still names the status, and every timeout names the deadline that elapsed.
- 13b610f: No SDK change. Platform groundwork for running the durable-workflow world on the platform's own database: a run-ownership table (the tenant boundary the DevKit's schema has no column for) and the world constructed against the platform's connection string with its pool pinned.
- 044236f: Make a deployed agent's session state durable, and stop reporting an absent run as a server error. The runtime read the platform pair (`AAI_PUBLIC_BASE_URL`/`AAI_GUEST_TOKEN`) out of the AGENT's env, where the platform never puts it, so every deployed agent fell back to the memory backend and a session did not survive its sandbox restarting; uploads fell back to local for the same reason. A 404 from platform run storage now becomes the DevKit's own `WorkflowRunNotFoundError`, so GET/DELETE/wake on an unknown run answer 404/`cancelled:false`/`woken:0` instead of 500. The browser client reports a refusal close's own reason instead of discarding it, and a dev-mode `aai init` pins the third-party deps it shares with the linked workspace so two copies of xstate cannot fail the typecheck gate.
- 841f460: The session-event stream reported `tail: 0` for a session this process never handled, so a cold read of a DURABLE stream answered with a full page of events beside a cursor of zero — and `startIndex=-N` counted back from that zero and returned the whole stream.
- 6796ae3: Complete the workflow HTTP API's stated auth posture, and pin it on the routes that
  matter. The module doc reasoned only about the COST of failing open — which is the one
  exposure the platform's per-IP limits already bound — and said nothing about the two
  that nothing bounds: the unkeyed arm of `GET /workflows/runs`, which converts knowing a
  slug into knowing run ids, and `DELETE /runs/:id` / `POST /runs/:id/wake`, which change
  a run somebody else started and rest on those ids being unguessable. The posture and the
  argument now live in `workflow-api-auth.ts`, and the token gate is covered on the run
  listing, cancel and wake rather than only on `GET /workflows` — a check that moved
  inside a route would have left the destructive verbs open with the suite green. No
  behaviour change: open-by-default is unchanged, and closing the enumeration arm
  independently is recorded as the open question rather than taken.
  
  Also corrects `WorkflowApiOptions.engine`'s doc, which still argued that an undefined
  client has two causes and that naming one would be "a confident false statement".
  `buildWorkflowClient` returns undefined on exactly one condition, and the message it
  answers with was corrected to say so; this doc was the holdout arguing that was a
  mistake.
- 841f460: cancel() on an already-cancelled run now resolves false, matching its documented contract
- 841f460: A fatal session error now ends a phone call instead of leaving dead air
- af284a7: Fix telephony: the bridge configured itself on a `config` frame the runtime never emits (it sends `session.configured`), so both resamplers stayed null and a phone call connected with neither end able to hear the other.
- 777d0eb: No SDK change. The platform's run-storage route: one bearer-gated POST that scopes every DevKit Storage call to the calling agent, with the five methods whose lookup key is not a run id each handled by name.
- 35a57fb: Refuse the durable-workflow queue callbacks from any peer that is not loopback. `POST /.well-known/workflow/v1/flow` and `/step` were declared `guest-internal` on the argument that "loopback is the whole gate", and nothing checked: a deployed guest binds every interface behind a public Modal tunnel whose origin the public `/:slug/client-config` hands to any browser, so `step` would execute one of the tenant's registered step functions with a caller-supplied payload. The gate lives in `handleWorkflowRequest`, so it covers `aai dev`, host mode, studio mode and a self-hosted `createAgentServer` alike. The webhook route is deliberately untouched — its URL is handed to third parties and the DevKit's path token is its authorization.
- 841f460: An expired workflow webhook token answers 404 instead of 500, so a third party stops retrying a dead callback; and a refused upload part offset names its real reason instead of always reporting misalignment.
- Updated dependencies [444e209]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
- Updated dependencies [e888216]
- Updated dependencies [444e209]
- Updated dependencies [444e209]
- Updated dependencies [444e209]
- Updated dependencies [f6be741]
- Updated dependencies [af284a7]
- Updated dependencies [e20a992]
- Updated dependencies [444e209]
- Updated dependencies [841f460]
- Updated dependencies [b238ba0]
- Updated dependencies [6796ae3]
- Updated dependencies [5bac92d]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
  - @alexkroman1/aai@9.0.0

## 8.2.1

### Patch Changes

- @alexkroman1/aai@8.2.1

## 8.2.0

### Minor Changes

- 690a623: Retry a failed workflow-world start, because its commonest failure is transient.
  
  A blue-green handover boots the replacement guest while the old one drains, so
  for a few seconds two guests share the app role's `APP_DB_CONNECTION_LIMIT` — a
  boundary `app-db-budget.ts` states outright. What it did not say, because it is
  `startWorkflowWorldIfDeclared`'s business, is what losing that race COST:
  `migrateAndSubscribe` ran once, the catch logged, and the replacement then
  served its entire life with NO QUEUE WORKER — while answering `/client-config`
  and voice sessions normally, so nothing looked wrong and every durable run for
  that agent was stranded.
  
  Measured on a real redeploy mid-run: the replacement logged `too many
  connections for role "app_…"` 300ms after listening, and a flow job that came
  due 15s later sat unlocked at `attempts 0/3`, claimable, with a live guest that
  was not polling. With a bounded backoff (five retries, ~62s, covering a
  draining predecessor's exit) the same scenario now recovers on attempt 3 in
  6.5s. Exhausting the budget still logs and returns rather than throwing — an
  agent whose workflows are broken should still answer the phone.

### Patch Changes

- 690a623: Tell the POSTGRES workflow world its callback base URL, not just the local world.
  
  `configureWorkflowWorld` set `WORKFLOW_LOCAL_BASE_URL` only on the local
  branch. The name reads like a local-world setting and is in fact the FIRST
  branch of world-postgres's own `getExecutionBaseUrl()` — the origin its queue
  dispatches `flow` and `step` callbacks to. Unset, that function fell through to
  health-probe port AUTO-DETECTION on every dispatch.
  
  Measured at ~45ms per dispatch, steady, against ~7ms of step work and ~1ms for
  graphile-worker's whole enqueue-to-handler path. Two dispatches per step-to-step
  hop made it ~90ms of a ~120ms hop, so a durable run spent roughly 40% of its
  latency rediscovering a constant. A six-step run goes from 1.3-1.7s to 72ms on
  the microVM backend (a 17x improvement in hop latency), and measured throughput
  from 3.6 to 24.6 steps/sec. Nothing errored, which is why it is now pinned by a
  test.
- @alexkroman1/aai@8.2.0

## 8.1.0

### Patch Changes

- Updated dependencies [2f899e1]
- Updated dependencies [1789a55]
  - @alexkroman1/aai@8.1.0

## 8.0.0

### Minor Changes

- 32bbb05: Add the eval harness: `@alexkroman1/aai-runtime/eval` and `/eval/vitest`.
  
  `openEvalSession` drives a real session from TEXT — this runtime, the pipeline
  transport, the tool executor, `ctx` and the session event stream, with only the
  two speech stages faked — and `say()` returns the turn it provoked.
  `describeEval` gates a suite on a credential and, without one, runs it against a
  SCRIPTED model rather than skipping: the same code below the model, so a keyless
  run checks the wiring for free. `describeWorkflowEval` / `openEvalWorkflows` do
  the same for a workflow app, over the real workflow client and key store (no
  durability — the engine's doc says so at the seam). `run_code`, `fetch`,
  `toolTimeoutMs` and `workflows` are all suppliable per case, and `saidIn` /
  `toolCallsIn` / `toolResultIn` / `lastStateIn` / `customEventsIn` read the
  answers out of the event stream.
  
  `RuntimeOptions.toolTimeoutMs` is new and applies beyond evals: the tool
  executor always accepted a per-call deadline and the session path passed none,
  so a session's 30s voice-turn budget was unreachable from any caller.
  
  New `aai eval` command runs a project's `agent.eval.test.ts`, and every shipped
  template now has one.

### Patch Changes

- Updated dependencies [83edc89]
- Updated dependencies [1d58f53]
- Updated dependencies [6960bfa]
- Updated dependencies [efa6152]
- Updated dependencies [01b790c]
- Updated dependencies [56b775c]
  - @alexkroman1/aai@8.0.0

## 7.0.0

### Major Changes

- 76ca287: **BREAKING — the last 76 `@internal` names come off the two packages' public
  barrels: 68 to `@alexkroman1/aai-runtime/internal`, 8 to a new
  `@alexkroman1/aai-ui/internal`.** Both `contracts/internal-surface.json`
  ratchets are now at zero, which is where `@alexkroman1/aai` already stood.
  
  The exemption those files record is the one hole in the capability contracts: a
  name tagged `@internal` at its declaration site but reachable anyway from a
  public subpath belongs to no capability, gets no epoch and no frozen compiling
  template, and is held to nothing but a comment. It is a ratchet that may shrink
  and may never grow, and counting it is what got it paid off — `aai` went 71 to
  0, `aai-runtime` 68 to 0, `aai-ui` 8 to 0.
  
  A release tag cannot close it from the barrel. API Extractor reads `@internal`
  at the DECLARATION site, so the tag on a re-export clause member is silently
  ignored and the name stays `@public` in the report. A deny-listed subpath is the
  mechanism, and it is the third time this repo has reached for it.
  
  **`@alexkroman1/aai-runtime`** — the second tranche off that root barrel, after
  the 31 host-internal pass-throughs that made the subpath exist. These 68 are the
  package's OWN host infrastructure: the host-mode server and its tool relay, both
  transports and the `Transport` contract they satisfy, the session core, the
  session-state backends and the table names and DDL they own, the workflow
  serving half (API handler, surface, world, install), the wake hint, the
  queue-lock sweep, the step-slot publishers, and the two shipped `Logger` values.
  What stays on the root barrel is exactly what a capability covers.
  
  Where a type is contracted and its constructor is not, the two now split: the
  `SessionCore`, `SessionStateBackend`, `SessionStateStore`, `SessionEventPage`,
  `SessionEventStream`, `Logger` and `S2SConfig` TYPES — the shapes a host
  implementing one has to name — stay on the root barrel; `createSessionCore`,
  `createMemoryStateBackend`, `createSessionStateStore`, `createSessionEventStream`
  and `consoleLogger` move. The 17-name OPENER CONTRACT deliberately did not move,
  for the reason it did not move last time: relocating it would make a custom
  speech provider import from two subpaths, one labelled not-semver-covered.
  
  **`@alexkroman1/aai-ui`** gains its first `./internal` subpath, carrying
  `SessionProvider`, `ThemeProvider`, `ToolConfigContext`, the three URL chips
  (`ApiUrlChip`, `SessionUrlChips`, `UiUrlChip`), `buildAgentUrl` and
  `loadClientConfig` — none of which a `client.tsx` names, and all of which sat in
  a client author's autocomplete beside `client()` and `useAgentState`.
  
  `aai-server`, `aai-guest`, `aai-cli`, `aai-evals` and `aai-studio-server` import
  the moved names from the new subpaths — the cross-package consumers the seam
  exists for.
  
  Both barrels now state the rule in their module docs, so the next name does not
  re-open the ratchet: a name on `/internal` that wants to become public gets its
  `@internal` tag REMOVED at the declaration site and joins a capability under
  `contracts/entrypoints/`, which is what buys it an epoch. It is never
  re-exported from the public barrel with the tag still on it.
- b8a5529: **BREAKING — 31 names move off `@alexkroman1/aai-runtime`'s root barrel to
  `@alexkroman1/aai-runtime/internal`.**
  
  Every one is a re-export of `@alexkroman1/aai/host-internal`, which the SDK
  itself deny-lists from its contracted surface as "not semver-covered". That
  exemption is per SUBPATH, so re-publishing the names on this package's root
  barrel defeated it — fifty not-semver-covered names sat on the one surface an
  embedder autocompletes over, one package along, and no contract could cover them
  without promising epochs on the SDK's internals.
  
  A release tag cannot fix it from here: API Extractor reads `@internal` at the
  DECLARATION site, so a `/** @internal */` on a re-export clause member is
  silently ignored (verified — the name stayed `@public` in the regenerated
  report). A subpath is the mechanism, and `NON_AUTHORING_SUBPATHS` now names this
  one so a name arriving there joins no capability contract.
  
  What moved: the builtins resolver, the SSRF-safe fetch pair, the four step-slot
  publishers, and the upload byte constants and id grammar. `aai-server`,
  `aai-cli` and `aai-guest` import them from the new subpath — the cross-package
  consumers the seam exists for.
  
  The 17-name OPENER CONTRACT deliberately did NOT move. `registerSttKind`/
  `registerTtsKind` are on the root barrel, and relocating their parameter types
  would make a custom speech provider — the documented use — import from two
  subpaths, one labelled not-semver-covered.
  
  Two dead mocks came out with it, both of which had stopped covering anything
  while every spec kept passing: `aai-guest`'s `vi.mock("@alexkroman1/aai-runtime")`
  replacing `safeFetch` (the import had moved, so the real function ran), and the
  CLI dev-server factory's `publishStepEnv`.

### Minor Changes

- 19c1ce4: createAgentServer now forwards the agent env to the server it builds, so AAI_WORKFLOW_API_TOKEN and AAI_SESSION_EVENTS_TOKEN close their routes through that door and DATABASE_URL reaches the upload store (AAI_ALLOW_HOST is filtered out, as in the guest). A malformed upload id answers 400 naming the grammar on every /uploads/:id route instead of 500 on the two reads. SESSION_EVENTS_TOKEN_ENV is exported, so a host can spell the variable that closes that surface.
- abfc018: `createAgentServer` can now express what `createRuntime` + `createServer` can, and the LLM registry's writer is published.
  
  - **`telephony` is reachable from the front door.** `createServer` defaults it to on for a voice agent, and `createAgentServer` forwarded neither it nor `page` — so every server built through the documented door, the scaffold's own `server.mjs` included, mounted an unauthenticated `WS /phone` with no way to switch it off short of abandoning the wrapper and restating by hand every field it derives. `telephony`, `page` and `uploadBroker` are forwarded now, and `page` DEFAULTS TO THE AGENT'S OWN: a `page: "static"` agent used to get the voice surfaces and a voice `GET /client-config`, because nothing carried the declaration through — the same silent drop `createAgentServer` exists to prevent for `name` and `greeting`.
  - **A `PassthroughServerOptions` bag can be spread into `ServerOptions`.** Its three fields were optional without `| undefined`, so `{ ...hooks }` widened each and `exactOptionalPropertyTypes` rejected the whole object (TS2379) — the one bag that exists to reach all three front doors could not be handed to any of them. `ServerOptions`' `logger`, `upgrade` and `request` accept `undefined`; existing callers are unaffected.
  - **`registerLlmKind` and `LlmRegistryEntry` are on `@alexkroman1/aai-runtime`**, beside `registerSttKind` and `registerTtsKind`. All three are one mechanism, and the LLM one was published from no subpath at all while `resolveLlm` — which reads the registry it writes — was public and contracted. A host wiring a model the SDK does not ship no longer has to reach past the descriptor path.
  - **`@alexkroman1/aai-runtime/internal` drops 63 re-exports nothing imports**, taking it from 99 names to 36. Every removed name is `@internal` at its declaration and was reachable only through that subpath; intra-package use is relative imports, so nothing in the repo changes. The three that stay unimported (`WakeHintOptions`, `WakeHintPublisher`, `WorldKind`) are kept because a name that IS imported has one of them in its signature.
  
  This subpath carries no semver promise, but the removal is listed here because it is the visible half of the change.
- abfc018: Add `withToolsDir` to `@alexkroman1/aai-runtime`: a self-hosted Node process can now discover an agent's `tools/` directory at startup, so a tool is registered by existing on that path too rather than only where a bundler enumerates it.

### Patch Changes

- d98169a: **Breaking (nominally): `@alexkroman1/aai-ui/default-client/*` is removed.** It
  had no consumer in any form — not one import specifier in the repo, the
  templates, the scaffold, or any README — because every real consumer reaches
  those files by filesystem path through `./package.json` (`client-dir.ts`,
  `aai-server/transport-websocket.ts`). `files: ["dist"]` still ships them, so
  nothing that worked stops working. `aai-studio-client`'s `./dist/*` goes for the
  same reason: both of its consumers `require.resolve` the manifest and join
  `"dist"` themselves.
  
  Also widens `check:attw`. `aai-ui` pinned `--entrypoints .`, which silently
  excluded `./client-dir` — a typed, contracted subpath — and `aai-runtime`
  inherited the same pin. `aai-ui` now uses `--exclude-entrypoints styles.css`
  (a CSS entry point has no type declarations, which is the only reason the pin
  existed) and `aai-runtime` drops it entirely, so a NEW subpath defaults into
  being checked instead of out.
- b8a5529: Version `@alexkroman1/aai-runtime`'s published surface in epochs, like `aai` and
  `aai-ui`. Twelve capabilities — `server`, `runtime`, `session`, `session-state`,
  `providers`, `telephony`, `uploads`, `db`, `keys`, `workflow`, `logging`,
  `text` — partition all 122 public names, each with a committed epoch and a
  frozen, compiling authoring example. `pnpm check:api-contracts` now reports 42
  contracts across 3 packages.
  
  The split shipped a published package with no `contracts/` tree, so 221 exports
  could move with nothing recording it while its two siblings could not change a
  parameter without a gate asking which. `contracts/internal-surface.json` opens
  at 68 and may only shrink — the ratchet that took `aai` from 74 to 0.
  
  Two gate-test parsers had never seen shapes this package introduces, and both
  reported a healthy tree as broken. A capability whose every name is a type
  collapses to `export type { … } from` under Biome, which
  `api-contracts-gate.test.ts` read as "declares something of its own" — so
  `session` and `session-state`, the two most obviously correct roots, failed. And
  an entry point can be ALL re-export (`/internal` passes on 31 names and declares
  nothing), which `api-surface-file.test.ts` read as an empty report —
  indistinguishable there from a parser that stopped working. The gate tests also
  pin the three-way `:workflow` ambiguity now, plus `:session` and `:uploads`,
  which is what makes the CLI's refusal to guess load-bearing.
- Updated dependencies [12ead27]
- Updated dependencies [028044a]
- Updated dependencies [429126e]
- Updated dependencies [abfc018]
- Updated dependencies [43ceb43]
- Updated dependencies [8c9ce20]
- Updated dependencies [9b9051a]
- Updated dependencies [55d5ec1]
- Updated dependencies [d98169a]
- Updated dependencies [ea0c9c9]
- Updated dependencies [d1e7c56]
- Updated dependencies [abfc018]
- Updated dependencies [a7309a5]
- Updated dependencies [51d571d]
- Updated dependencies [43ceb43]
- Updated dependencies [6596e4b]
- Updated dependencies [df8effa]
- Updated dependencies [23e8b3f]
- Updated dependencies [abfc018]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
  - @alexkroman1/aai@7.0.0
