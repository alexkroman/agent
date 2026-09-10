---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Turn-taking defaults, measured on tau2-bench retail

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
