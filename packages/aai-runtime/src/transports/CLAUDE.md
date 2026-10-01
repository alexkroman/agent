---
summary: >-
  Transport-wide rules: the `Transport` boundary, the capability table, when each transport
  resolves the system prompt, and run notify
read_when: >-
  editing `transports/types.ts`, `capabilities.ts`, an `openai-realtime-*` or `s2s-*`
  module, or anything under `src/transports/` outside `pipeline/`
---

# aai-runtime transports

`types.ts` is the transport boundary; session-side rules are in
[`../CLAUDE.md`](../CLAUDE.md). The pipeline transport is the directory
[`pipeline/`](pipeline/CLAUDE.md), one subdirectory per stage.

## What works on which transport is ONE descriptor

`Transport.capabilities` (`capabilities.ts`) answers every "can this transport
do X"; read the flag, never a verb's presence, and never add an "S2S cannot"
branch at a call site. An absence is handled at `agent()` (`config-rules.ts`
refuses by mode), once at session start (`reportSessionCapabilities`), or as an
ignored client command. The table is RENDERED by `renderCapabilityTable()` and
`capabilities.test.ts` holds it, and each optional verb, to the descriptors —
edit the rows there, then paste the output here:

<!-- capability-table:start -->

| capability         | feature                                                                                      | pipeline | OpenAI Realtime | AssemblyAI S2S | where absent                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------- | -------- | --------------- | -------------- | -------------------------------------------------------------------------------------- |
| `say`              | `speech.say()` — speak host text VERBATIM (`interruptible`, `record`)                        | yes      | no              | no             | logged at session start; every `say` settles `dropped`                                 |
| `replyState`       | `speech.interrupt()` knows whether a reply is in flight                                      | yes      | no              | no             | "cannot tell" interrupts, as the client's blind `cancel` does                          |
| `announce`         | an unprompted MODEL turn — a run's `notify`, `ServerSession.announce`                        | yes      | no              | no             | logged at session start; `announce` answers `false`                                    |
| `typedTurn`        | a typed user turn (`user_text`)                                                              | yes      | no              | no             | client command ignored, warned once per session                                        |
| `manualTurn`       | push-to-talk (`turnTaking: { detection: "manual" }`)                                         | yes      | no              | no             | refused by `agent()`; client commands ignored, warned once per session                 |
| `reset`            | client `reset` clears the conversation and re-greets                                         | yes      | no              | no             | ignored — the service holds the conversation (a known gap)                             |
| `seedHistory`      | a resume re-seeds the host-held model history                                                | yes      | no              | no             | nothing to seed — the service resumes its own context                                  |
| `playbackProgress` | client `playback_progress` corrects the heard clock                                          | yes      | no              | no             | ignored — the host keeps no playback model                                             |
| `promptPush`       | a changed system prompt is PUSHED to the service                                             | no       | yes             | no             | pipeline: resolved per request, nothing to push                                        |
| `perTurnPrompt`    | the system prompt is re-resolved between turns (a `dialog()` phase, a persona)               | yes      | yes             | no             | resolved ONCE at construction; a phase is learned through tool results                 |
| `dialogKnobs`      | a dialog state's `interruption` / `toolChoice` / `temperature`                               | yes      | no              | no             | warned at session start; states, deadlines and tool gates still work                   |
| `personaKnobs`     | a persona's `interruption` / `toolChoice` / `temperature`                                    | yes      | no              | no             | warned at session start; the prompt section and tool gate still hold                   |
| `fatalTool`        | a tool's `onError` FATAL verdict stops the turn and speaks `errorPhrase`                     | yes      | no              | no             | warned at session start; a fatal verdict reaches the model as a failure result instead |
| `turnMetrics`      | one `metrics.collected` frame per settled reply (`pipeline/turn/metrics.ts`)                 | yes      | no              | no             | no frame — the service reports no per-stage marks (a known gap)                        |
| `hostedTurn`       | the HOST runs the model turn: guardrails, `usageLimits`, model tuning, pipeline voice tuning | yes      | no              | no             | refused by `agent()` (`config-rules.ts`) — never reaches a session                     |

<!-- capability-table:end -->

## The system prompt is resolved PER TURN, and one transport cannot

`TransportSessionConfig.systemPrompt` is a `SystemPromptOption` (`string |
(() => string)`) with one reader, `resolveSystemPrompt` (`types.ts`) — one
field, not a string plus a resolver, so no read site has a precedence to forget.
A plain string resolves to itself. This is a transport seam, NOT the authoring
`AgentSystemPrompt`, which needs the session and is resolved in
`../runtime/system-prompt.ts`.

| Transport       | Resolves                                                | Why there                                                                                        |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| pipeline        | at each `startLlmStream`                                | the one place a `streamText` request is assembled                                                |
| OpenAI Realtime | at open, then on `refreshSystemPrompt()`                | `instructions` is service state; sends an `instructions`-only `session.update`, only on a change |
| AssemblyAI S2S  | **once, at construction** (`buildAssemblyS2sTransport`) | the service runs the tool loop; the host has no moment between turns                             |

So an S2S agent learns about a `dialog()` phase through tool results alone.

## A run can tell the caller it finished

`start(def, input, { key, notify })` makes the starting session take an
unprompted, interruptible turn when the run lands. `Transport.injectTurn` is the
primitive (`announce` in the table). See `../workflow/notify.ts`.
