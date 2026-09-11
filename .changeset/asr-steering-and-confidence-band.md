---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Steer the recognizer per agent and per turn, and act on the confidence band.

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
