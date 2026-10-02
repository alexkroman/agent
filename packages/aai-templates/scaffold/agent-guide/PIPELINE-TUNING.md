# Pipeline mode, speech-to-speech, telephony and voice tuning

Part of the aai authoring guide (start with the core guide). This file covers
the session's MODES — the default pipeline, S2S, text — answering and placing
phone calls, speaking from outside a turn, and the pipeline's turn-taking knobs.
Which vendor runs each stage is `PROVIDERS.md`; the full `agent()` field list is
`AGENT-API.md`.

## Pipeline mode

Pipeline mode is the default: omitting `stt`/`llm`/`tts` (and `s2s`) gives you
the all-AssemblyAI pipeline, and any stage you do declare replaces just that
stage — the rest keep the default.

**S2S mode is an explicit opt-in.** `mode: "s2s"` beside an
`s2s: assemblyAIS2s()` descriptor (imported from `@alexkroman1/aai`, next to
`agent()`) selects AssemblyAI's speech-to-speech Voice Agent API: STT, the LLM
loop, and TTS run service-side in one socket. Fewer moving parts, but you cannot
choose the model or swap a provider. There is no way to reach S2S by omission,
and the S2S member of `agent()`'s parameter type has none of the
`stt`/`llm`/`tts` triple or its tuning. (An `s2s` descriptor with no `mode` is
refused: that declares a pipeline agent carrying an unused descriptor.)

```ts
import { agent, assemblyAIS2s } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  mode: "s2s",
  s2s: assemblyAIS2s(),
});
```

The descriptor takes three optional knobs, all forwarded only when set:

```ts
import { agent, assemblyAIS2s } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  mode: "s2s",
  sttPrompt: "Callers spell order numbers one character at a time.",
  s2s: assemblyAIS2s({
    voice: "michael",
    languages: ["en"],
    keyterms: ["Acme Rewards", "SKU"],
  }),
});
```

- `voice` — the agent's voice. Unset uses the service default.
- `languages` — **leave it unset for multilingual calls**: unset means "detect
  per turn", so pinning `["en"]` on a line that takes other languages disables
  detection for every caller. Pin it when the line really is monolingual — on a
  benchmark run that plus a transcription prompt took a caller's spelled first
  name from 1 of 6 attempts correct to 6 of 6.
- `keyterms` — product names and proper nouns to bias transcription toward. Use
  `sttPrompt` (above, and honoured in **both** modes) for prose guidance and
  `keyterms` for a term list.

**Prefer pipeline mode** — the default — unless the user specifically asks for
the speech-to-speech API. Nearly every template ships this way, and it is what
AssemblyAI Build defaults to. The host runs the LLM loop locally (Vercel AI SDK)
with your chosen STT, LLM, and TTS. You want explicit providers when:

- you want a specific LLM (Anthropic, OpenAI, Gemini, Mistral, xAI, Groq,
  hundreds of models via OpenRouter, or 25+ models via the AssemblyAI LLM
  Gateway)
- you want a specific STT model, a non-AssemblyAI TTS provider, or another voice
  (`tts: assemblyAITts({ voice })`)
- you need to swap providers without changing agent code

**The rule:** declare only the stages you're changing — any subset of `stt`,
`llm`, `tts`; each unset stage runs on the AssemblyAI default. Combining `s2s`
with any pipeline provider or pipeline-only tuning field is a compile error
naming the rule; a voice has one place to live, the TTS descriptor (there is no
agent-level `voice`). A raw config that skips `agent()` is still checked at
parse time.

```ts
import { agent } from "@alexkroman1/aai";
import { assemblyAIStt } from "@alexkroman1/aai/stt";
import { llm } from "@alexkroman1/aai/llm";
import { cartesiaTts } from "@alexkroman1/aai/tts";

export default agent({
  name: "My Agent",
  stt: assemblyAIStt({ model: "universal-3-5-pro" }),
  llm: llm({ provider: "anthropic", model: "claude-haiku-4-5" }),
  tts: cartesiaTts(),
});
```

Tools, the database, `ctx`, and the UI all behave identically across modes. Only
the audio + LLM transport differs.

**Four modes, one field on `agent()`: `mode`.** Omit it for PIPELINE (voice,
cascaded STT → LLM → TTS) — the default, and the mode this guide assumes.
`mode: "s2s"` selects speech-to-speech. **`mode: "text"` selects a text-only
agent**: no STT, no TTS, `llm` is the one stage, and the host runs it with
`createTextAgent` from `@alexkroman1/aai-runtime`. `workflowApp()` (see
"Workflow apps") is `mode: "workflow-app"`: a form with no session at all. Each
mode is its own member of the parameter type, and a field that mode does not
have is simply ABSENT from it — so setting one is a compile error naming the
member, and the modes cannot be mixed by accident. Every pipeline agent must
declare a real TTS provider — that is a statement about pipeline mode, not about
the SDK.

### Answering a phone call

**Say which carriers may call, and `WS /phone` is served for exactly those.**
`telephony` is an allow-list on `agent()`, and it is the whole of the wiring:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Support",
  greeting: "Support line — what's happened?",
  // `true` admits every carrier decoded; omitted, `/phone` is not served.
  telephony: ["twilio"],
});
```

Point the carrier at `wss://<your-agent-url>/phone?carrier=twilio` (or
`telnyx`). An unknown `carrier` gets a `400`, an undeclared one a `404`. 8 kHz
mu-law is transcoded both ways, so a call is a transport, not a mode.

**Declaring nothing answers no carrier**, in dev and deployed.
`createAgentServer({ telephony })` overrides one deployment; embedding:
`createTelephonyBridge`, `startTelephonySession`.

**A call your app places** (below): the session starts on the carrier's `start`
frame, so `sessionContext`/`onSessionEnd` get `call` —
`{ carrier, callId?, parameters }` — and a tool reads `sessionCall(ctx)`.
`/phone` is unauthenticated: check a parameter you issued and answer
`{ refuse: "why" }` otherwise (hung up before the greeting or any model call; a
WebSocket gets 1008). A tool hangs up with `endSession(ctx)` once the reply has
been spoken (`{ afterReply: false }` cuts it); a spec reads
`endSessionCalls(ctx)` (`/testing`). Tunnel to the port `aai dev` prints.

**Turn-taking tuning (`PipelineTuning`, pipeline only)** is three groups:

- `silence.nudge: { afterMs, prompt? }` makes the assistant take a turn after
  that much user silence ("Are you still there?"); `afterMs` is required inside
  it. It is never a user transcript, and stops after 3 unanswered nudges.
  `silence.deadAirCoverMs` is how long a turn may go silent before a short
  filler is spoken (default 2400; `0` disables). The wording is fixed:
  declarative, never a request for patience, or the caller's answer barges in.
- `interruption` — `minWords` (default 1) words interrupt a reply, gated by
  `minDurationMs` of sustained speech (default 500 ms; `0` disables; interims
  only — committed turns always land); `backoffMs` holds agent audio after a
  real interruption; `resumeFalseInterruption` (default `true`) resumes a reply
  whose barge-in was noise. `interruption: "off"` means nothing the caller says
  cuts the agent off. **The same type is a dialog state's `interruption` and a
  persona's**, overriding the agent's per key (state, then persona, then agent).
- `turnTaking` — `minSilenceMs`/`maxSilenceMs` are how long a pause ends a turn
  (lowered onto the default `assemblyAIStt()`; with an explicit `stt` set them
  on the descriptor, e.g. `deepgramStt({ endpointing })`). `userTurnLimit`
  (`{ maxWords }`, `{ maxDurationMs }` or both; `{}` refused) ends ONE turn as a
  pause would, emitting `userTurn.exceeded`. `detection: "manual"` is
  PUSH-TO-TALK (`usePushToTalk()` in `aai-ui`): the mic is heard only while
  held, all of it is ONE turn answered on release, and pressing is the barge-in.
  `preemptiveGeneration` (default **`false`**) starts the reply from a confident
  interim, adopted if the commit matches (measured **+8ms per turn**, 44% of
  requests wasted); it never speaks or calls a tool until adopted.

### Placing a call

`stepPlaceCall` (`/step`) dials through Twilio from a step; the answered call
streams to `<agentUrl>/phone?carrier=twilio` (an agent with `telephony`):

```ts
import { requireStepEnv, stepPlaceCall } from "@alexkroman1/aai/step";

export async function dial(to: string, callRef: string): Promise<string> {
  const { callId } = await stepPlaceCall({
    carrier: "twilio",
    to,
    from: requireStepEnv("TWILIO_FROM_NUMBER"),
    agentUrl: requireStepEnv("CALLER_AGENT_URL"), // its public base URL
    parameters: { call: callRef }, // → `call.parameters`
  });
  return callId;
}
```

Credentials: env `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`, or `credentials`.
Poll `stepCallStatus({ carrier, callId })` between `ctx.sleep`s until
`completed`/`busy`/`no-answer`/`failed`/`canceled`. Failures are
`PlaceCallError` (`retryable` only on 429/5xx/no answer; advice for common
Twilio codes; never the token). A lost answer can ring twice: keep the dial
step's `maxAttempts` small. `timeLimitS` (default 600) caps the call. Specs:
`stubPlaceCall()` (`/testing`). Twilio only.

### Saying something from outside a turn — `ctx.speech`

A timer, webhook or event can speak an exact sentence on a live call, or stop
the agent. `ctx.speech` is on `events` handler and tool contexts, and
`ctx.speech(sessionId)` on a route's (`undefined` if that call is not live).
`say(text)` is a reply of its OWN, spoken verbatim behind the reply in flight.
Options: `interrupt: true` cuts that reply first; `interruptible: false` stops
the CALLER talking over it (code and `cancel()` still can); `record: false`
keeps it out of history. `interrupt()` is the client's `cancel()`.

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Timer",
  events: {
    "tool.called": (event, ctx) => {
      if (event.toolName !== "start_timer") return;
      setTimeout(async () => {
        const outcome = await ctx.speech.say("Your timer is done.", { interrupt: true }).done;
        if (outcome !== "played") console.log(`timer line ${outcome}`);
      }, 60_000);
    },
  },
});
```

**A handler that speaks can hear itself**: the line is an
`agentTranscript.committed` that reaches your handlers again, so a handler
speaking on every one never stops. Speak from an event your line cannot produce
(`tool.called`, a timer), or check the event's `text` first.

`done` never rejects: `"played"` once playback ends, `"interrupted"`,
`"dropped"` (call ended, taken back, or an S2S agent). **Never await `done`
inside the reply it waits behind** (a tool's `execute`). **A session id is not
authorization**: verify a webhook first. Specs: `createToolContext()` records
into `ctx.said`.
