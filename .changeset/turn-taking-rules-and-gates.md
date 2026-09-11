---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Three turn-taking layers over the thresholds: a regex-keyed endpointing table, a start-speaking floor, and the two barge-in phrase lists.

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
