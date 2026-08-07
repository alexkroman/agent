---
"@alexkroman1/aai": patch
---

Fix three S2S defects that left most of the agent's speech unheard, each measured
against tau2-bench retail with a bare Voice Agent API client (no SDK) as control.

**Host-mode audio pacing is now the client's declaration, defaulting to paced**
(`HostConfig.audioLeadMs`: omitted = real time, a number = that lead, `null` =
unpaced). Unpaced was the blanket default, reasoning that a programmatic client
keeps its own clock — but being programmatic does not mean consuming faster than
the wall clock, and only a client whose timeline runs ahead is starved by pacing.
In S2S the service synthesises a whole reply server-side and it arrives in one
burst (up to 1118 frames in one tau2 tick, against 205 on the pipeline
transport), so a client draining at 1x accumulated a backlog of MINUTES — and
tau2 discards its buffer on barge-in, so 36% of all agent audio was destroyed
unheard (p99 181s, max 272s per barge-in on a 215s call, against 18-23% and a
15s max for the pipeline arms). The S2S arm completed a reply for 0.53 of caller
turns where the pipeline managed 1.00, with 18% of sessions completing none.

**`transcript.agent.delta` is accepted.** It was left out of the S2S message
union on a measurement saying the service never sends it; re-measured, a bare
greeting reply emits one frame per word, and one session carried 511 frames
across 20 replies — 5 of which sent deltas and never a final `transcript.agent`,
116 words of agent speech otherwise unrecoverable. Those are the tool-preamble
turns that used to render blank. The accumulation is forwarded as a partial and
committed as the reply's transcript when a COMPLETED reply sent no final — never
on an interrupted one, where the batch covers more than was actually spoken.

**S2S pins Voice Focus** (`near-field` / 0.9) from the same constants the
pipeline STT stage reads, rather than inheriting the service's 0.7. The
interferer that matters is background speech, which only the pre-model filter can
suppress. `turn_detection` is deliberately left unset — its default is adaptive
and entity-aware, and pinning `min_silence` disables that for the session.

**`sttPrompt` is honoured in S2S mode**, sent as `input.transcription_prompt`
(trimmed to that field's documented 1750-char cap, keeping the head). It was
pipeline-only, which made it a silent config drop: `agent({ sttPrompt })` and
host mode's `host.sttPrompt` both reached the agent definition and only
`pipeline-transport.ts` ever read it, so an S2S agent that set one got unbiased
transcription with no warning. Measured on tau2-bench retail, a transcription
prompt took the authenticating caller's spelled first name from 1 of 6 attempts
correct to 6 of 6.
