---
"@alexkroman1/aai": major
"@alexkroman1/aai-ui": major
"@alexkroman1/aai-runtime": major
"aai-studio-server": patch
---

Reshape the `agent()` public surface. The SDK is unreleased, so the old
spellings are removed outright rather than aliased; the stray-field check names
the replacement for each.

- **`mode` discriminates the agent.** `agent()` is overloaded over
  `mode: "pipeline" | "s2s" | "text" | "workflow-app"` (pipeline is the
  default), and each member has only the fields its mode can use — a
  pipeline-only field on an S2S agent is a compile error naming the member.
  `text: true`, `page: "static"` and a bare `s2s:` are gone: write
  `mode: "text"`, `mode: "workflow-app"` (or `workflowApp()`), and
  `mode: "s2s", s2s: …`. The wire `AgentConfig.mode` carries the authored mode.
- **Pipeline turn-taking is three groups.** The flat knobs move into
  `turnTaking` (`minSilenceMs`, `maxSilenceMs`, `detection`, `userTurnLimit`,
  `preemptiveGeneration`, `startSpeakingFloorMs`), `interruption` (`"off"` or
  `{ minWords, minDurationMs, backoffMs, resumeFalseInterruption }`) and
  `silence` (`{ deadAirCoverMs, nudge: { afterMs, prompt? } }`). The same
  `interruption` type is a dialog state's override (replacing `bargeIn`) and,
  new, a persona's; the pipeline resolves it per key as state, persona, agent.
  `PipelineVoiceTuning` and `DialogBargeIn` are removed.
- **A voice is the TTS descriptor's option.** Agent-level `voice` is removed:
  write `tts: assemblyAITts({ voice: "michael" })`. The unknown-voice warning is
  printed once, by `agentConfigWarnings`, and no longer also by `toAgentConfig`.
- **`syncState` is keyed by slot name**: `syncState: { cart: cartSlot.projected }`
  (the key must be the slot's own). The `state.updated` frame is
  `{ [slot]: view }`. In `@alexkroman1/aai-ui`, `useAgentState(projection)`
  selects its slot, `useAgentState("slot", fallback?)` names one,
  `useAgentState()` is the whole `AgentStateFrame`, and the new
  `selectAgentState(slot)` is a stable `useSessionSelector` selector; an
  unchanged slot keeps its value object across pushes. The eval readers
  `lastStateIn`/`statesIn` take the slot name.
