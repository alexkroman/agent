# `agent()` — every field

Part of the aai authoring guide (start with the core guide, which has the
minimal agent and the fields almost every agent sets). This file lists EVERY
field `agent()` takes, grouped by what it governs. The declarations are the
final word: `AgentDef` documents each field's meaning and default, and
`AgentParams` — a union with one member per `mode` — which fields each mode has.
Both are in `node_modules/@alexkroman1/aai/dist/`.

## `agent()` API

A field the chosen `mode` does not have is simply ABSENT from that member of the
parameter type, so setting one (a pipeline knob on `mode: "s2s"`, `stt` on
`mode: "text"`) is a compile error naming the member; a raw config that skips
`agent()` is checked at parse time.

```ts no-check
import { agent } from "@alexkroman1/aai";

export default agent({
  // ── Identity and prompt ────────────────────────────────────────────────
  name: string;                              // required — display name
  listing?: string;                          // one line for humans choosing the agent (a
                                             // registry, `aai list`) — never sent to the model
  promptContext?: string | ((ctx) => string); // appended UNDER system-prompt.md: a menu, a
                                             // catalogue, or per-request text over session
                                             // state (below). Refused on a workflow app.
  // NO systemPrompt field: the prompt IS system-prompt.md, and `agent()` refuses the key.
  greeting?: string;                         // default: "Hey there..."; "" starts silent
  sttPrompt?: string;                        // STT guidance for jargon/acronyms (both voice modes)
  voicePresets?: VoicePresetName[];          // opt-in prompt presets — see below; each one
                                             // costs tokens on EVERY model request

  // ── Mode and providers (PIPELINE-TUNING.md, PROVIDERS.md) ──────────────
  mode?: "pipeline" | "s2s" | "text" | "workflow-app"; // default "pipeline"; "text": `llm` is the one stage
  stt?: SttProvider;                         // pipeline stage overrides — set any subset;
  llm?: LlmProvider | string;                // unset stages default to AssemblyAI
  tts?: TtsProvider;                         // (llm also takes a model-id string; a voice is
                                             // the TTS descriptor's: assemblyAITts({ voice }))
  s2s?: S2sProvider;                         // the descriptor `mode: "s2s"` requires
  telephony?: true | ("twilio" | "telnyx")[];// carriers that may open WS /phone; omitted = not served
  idleTimeoutMs?: number;                    // close after this much inbound silence: 5 minutes; 0 disables
  // (`mode: "workflow-app"` is what workflowApp() sets for you — see WORKFLOWS.md)

  // ── Tools and the model loop ───────────────────────────────────────────
                                             // (there is no `tools` field — a tool is a FILE;
                                             //  see "A file in tools/ IS a tool" in the core guide)
  builtinTools?: BuiltinTool[];              // default ["think"]; setting it REPLACES the default
                                             // (table in TOOLS.md)
  maxSteps?: number;                         // default: 10 — max tool calls per turn
  toolChoice?: ToolChoice;                   // "auto" (default) | "required" | "none"
                                             // | { type: "tool", toolName }
  roster?: Roster;                           // speakers: mints `handoff` and `delegate`
                                             // (TOOLS.md, "Speakers")
  dialogs?: AnyDialog[];                     // wires a dialog() to the SESSION: @-events, timeouts,
                                             // per-state instruction (TOOLS.md, "dialog()")
  workflows?: Record<string, WorkflowDef>;   // durable runs a tool may start; usually ABSENT —
                                             // a `workflows/<name>.ts` default export is
                                             // registered as <name> (WORKFLOWS.md)
  mcpServers?: McpServers;                   // remote MCP servers' tools, prefixed mcp_<key>_…;
                                             // a host connects them with `withMcpTools`
  requiredEnv?: string[];                    // env vars this agent reads. Publishing CHECKS them,
                                             // so a missing key fails at `aai publish` (the
                                             // deploy) instead of mid-call. Declare every key
                                             // any tool or step reads; provider keys are derived.

  // ── Model tuning (pipeline and text; S2S runs the model service-side) ──
  temperature?: number;                      // sampling temperature for the agent's OWN model calls.
                                             // Unset = the model's default; some models ignore it
                                             // and warn.
  maxOutputTokens?: number;                  // per-STEP output cap, passed to the provider
  maxRetries?: number;                       // provider retries of a FAILED request (AI SDK's own
                                             // 2 unless set; 0 lets errorPhrase arrive promptly)
  resetToolChoice?: boolean;                 // default true — a demanding toolChoice applies to the
                                             // FIRST step of a reply only; false = every step
  usageLimits?: { totalTokens?: number };    // end the session once it has spent this many tokens

  // ── pipeline only: three groups (`PipelineTuning`), refused on s2s / text ──
  turnTaking?: {
    minSilenceMs?: number;                   // pause (ms) that ENDS a turn once the text reads
                                             // complete (default 800) — lowered onto the default
    maxSilenceMs?: number;                   // assemblyAIStt(); pause that ends it REGARDLESS of
                                             // content (default 3500). Invalid beside an explicit `stt`.
    detection?: "auto" | "manual";           // "manual" is push-to-talk: the CLIENT ends each turn
    userTurnLimit?: { maxWords?: number; maxDurationMs?: number }; // cap ONE user turn. Default: none.
    preemptiveGeneration?: boolean;          // start the reply from a confident interim (default false)
    startSpeakingFloorMs?: number;           // earliest agent audio after a turn ends (default 0)
  };
  interruption?: "off" | {                   // "off": the caller never cuts the agent off
    minWords?: number;                       // interim words before speech interrupts (default 1)
    minDurationMs?: number;                  // sustained speech (ms) first (default 500; 0 disables)
    backoffMs?: number;                      // agent audio held after a real interruption (default 0)
    resumeFalseInterruption?: boolean;       // resume a reply if no user turn commits (default true)
  };
  silence?: {
    deadAirCoverMs?: number;                 // filler after this much silence IN a turn (default 2400; 0 off)
    nudge?: { afterMs: number; prompt?: string }; // speak up after this much USER silence
  };
  writes?: { verify?: boolean };             // check each declared write against the call first (default off)
  errorPhrase?: string;                      // spoken when a turn's LLM stream fails ("" disables)
  startFailurePhrase?: string;               // spoken when a provider fails to open ("" disables)
  inputGuardrails?: AgentGuardrail[];        // judge each committed caller utterance; a returned
                                             // string is spoken INSTEAD and the model is not asked
  outputGuardrails?: AgentGuardrail[];       // judge the reply before any of it is spoken
                                             // (costs streaming: nothing plays until it passes)

  // ── Observing the session ──────────────────────────────────────────────
  // NO syncState field: a slot reaches the client by declaring it
  // `sessionSlot(key, create, { view, sync: true })` (read it with
  // useAgentState; see UI.md); `agent()` collects those onto the def.
  events?: SessionEventHandlers;             // observe the session; "metrics.collected" is each
                                             // reply's latency/tokens: createMetricsCollector();
                                             // "error.reported" carries a SessionErrorCode (open:
                                             // switch with a default); "*" gets AnySessionEvent
  sessionContext?: (args) => SessionContext; // fetched once per connect, before the first model
                                             // call: extra instructions, history cut-off, refusal
  onSessionEnd?: (ctx) => unknown;           // after every hang-up / disconnect / idle close;
                                             // ctx.transcript is what was said, oldest first

  // ── Surfaces outside a session ─────────────────────────────────────────
  routes?: Record<string, RouteHandler>;     // JSON endpoints under /api, keyed "GET /path/:id";
                                             // wrap one in apiKeyRoute({ env }, handler) or
                                             // webhookRoute(...) to authenticate it
  clientInbox?: { sampleRate?: number };     // what a run pushes to a device over WS /inbox
});
```

> Unless `mode` says otherwise, the agent runs in **Pipeline mode** — see
> `PIPELINE-TUNING.md`. Declare any subset of `stt`/`llm`/`tts`; unset stages
> default to AssemblyAI. `llm` also accepts a model-id string: `"creator/model"`
> routes through the Vercel AI Gateway (`AI_GATEWAY_API_KEY`), a bare id through
> the AssemblyAI LLM Gateway (`ASSEMBLYAI_API_KEY`).

### A few fields, shown

A guardrail answers `true` to pass, or the sentence to speak instead:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Pharmacy Line",
  outputGuardrails: [
    (text) =>
      /\b\d+\s?(mg|ml|mcg)\b/i.test(text)
        ? "I can't give dosage information over the phone. Please check with your pharmacist."
        : true,
  ],
});
```

A `promptContext` FUNCTION reads session state once per model request, and is
appended under `system-prompt.md`, which stays the prompt:

```ts
import { agent, sessionSlot } from "@alexkroman1/aai";

const caller = sessionSlot("caller", { verified: false });

export default agent({
  name: "Bank Line",
  promptContext: (ctx) =>
    caller.get(ctx).verified
      ? "The caller is verified. You may discuss balances."
      : "The caller is NOT verified. Verify them before discussing anything.",
});
```

MCP servers are declared here and CONNECTED by the host (`withMcpTools` from
`@alexkroman1/aai-runtime`), because discovery is a network round trip. A server
that is down costs its own tools and nothing else:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Support",
  mcpServers: {
    docs: { url: "https://mcp.example.com/mcp", tokenEnv: "DOCS_MCP_TOKEN" },
  },
  requiredEnv: ["DOCS_MCP_TOKEN"],
});
```

`sessionContext` is bounded (1.5 s) and a throw, a timeout or `undefined` starts
the session without it; `onSessionEnd` is fire-and-forget and at-least-once, so
key any run it starts, and its `ctx.transcript` is every committed line of the
session (what an app that places calls records). A `routes` handler's return
value is the JSON body; `routeResponse(status, body, { headers })` picks another
status (and any headers — a `Location`, a `Retry-After`) and a thrown
`routeError(status, message)` answers `{ error: message }`.
`apiKeyRoute({ env: "CALLS_API_KEY" }, handler)` runs the handler only for a
request carrying that key (`Authorization: Bearer …` by default; `503` when the
variable is unset, `401` when the key is wrong).

## Text beside the prompt — `promptContext`

**The file is never imported.** When part of the prompt is computed — a menu, a
catalogue, today's date — put it in `promptContext`; the build appends it under
`system-prompt.md` after a blank line, and the file stays discovered:

```ts
import { agent } from "@alexkroman1/aai";

const MENU = ["Margherita — 12", "Marinara — 10"];

export default agent({ name: "Pizza", promptContext: `Menu:\n${MENU.join("\n")}` });
```

A string is serialized into the config like the prompt is; a function is
resolved per model request (per connection on S2S) from the session context
(`sessionId`, `env`, the slots), so per-caller state goes in the function form
shown above — it is the ONE prompt field `agent.ts` writes. A workflow app
refuses the field. `greeting` stays a field, deliberately: it is one sentence
with no structure to lose, and it crosses the wire to the browser beside `name`
and `page`. **A document goes in a file, a value stays in the call.**

**JSON imports need no attribute.** `resolveJsonModule` is on, so
`import data from "./knowledge.json"` is all it takes. Do NOT write
`assert { type: "json" }` — import assertions were replaced by import attributes
and TypeScript rejects them (`TS2880`). If you want to be explicit the modern
spelling is `with { type: "json" }`, but plain is fine.

### Opt-in prompt presets

`agent({ voicePresets: ["echoVerification", "natoAlphabet"] })` switches on
named behaviours instead of writing them. They compose, each is removable on its
own, and each is paid for on EVERY model request: `echoVerification` (~190
tokens — read critical values back and get a yes), `speechNormalization` (~920 —
money, dates, phone numbers and emails as spoken words, `"$758.08"` as "seven
fifty-eight dollars and eight cents") and `natoAlphabet` (~190 — "That's B as in
Bravo, 7, K as in Kilo, 2 — correct?"). `VOICE_PRESETS` holds the exact text.
The two spelling presets override the default "don't spell things back", so use
them where a wrong value costs more than a slow call; `speechNormalization` is
the PROMPT layer only, and for the agent's OWN data the speech renderers
(`spokenMoney`, `spokenDate`, … — "Speech goes both ways" in `TOOLS.md`) do it
in code for free.
