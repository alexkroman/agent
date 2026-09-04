# aai

Voice agent development kit. An agent is a directory of TypeScript files —
talk to it in your browser, put it on a phone number, publish it to the
managed platform with one command, or self-host the same runtime.

What makes it a **voice** kit rather than a chat framework with a microphone
bolted on: the parts of a spoken conversation that are hard — turn-taking,
barge-in, recovering from a false interruption, dead air, what the caller
actually *heard* — are handled by the runtime with measured defaults, and
each one is a field on `agent()` for when you disagree.

## Quickstart

```sh
npx @alexkroman1/aai-cli@latest init my-agent
cd my-agent
npx aai dev        # local dev server + browser voice client
npx aai publish    # ship it to the managed platform
```

Requires Node.js 24+. `aai init` scaffolds a project from a template
(`aai templates` lists all 22 — `--template pizza-ordering`) and writes a
`.env` for your `ASSEMBLYAI_API_KEY`: the one key the default pipeline needs
for speech-to-text, the LLM gateway, and text-to-speech alike.

## The filesystem is the authoring interface

```text
my-agent/
  agent.ts            # the agent definition — required
  system-prompt.md    # the system prompt — discovered, not imported
  tools/              # one file per tool; the filename IS the tool name
    get_weather.ts
  workflows/          # durable bodies for work that outlives a turn (optional)
  client.tsx          # custom browser UI (optional, React)
  shared.ts           # types and session state shared by agent.ts and client.tsx
  agent.test.ts       # ordinary vitest — `aai test`
  .env                # local secrets; `aai publish` syncs them as agent secrets
```

Nothing registers anything. A file in `tools/` is a tool because it is in
`tools/`, and `system-prompt.md` is the system prompt because it exists.

## A minimal example

`agent.ts` — no provider fields means the default all-AssemblyAI
STT → LLM → TTS pipeline, billed to one key:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Weather Line",
  greeting: "Weather line — which city are you asking about?",
  voice: "michael",
});
```

`system-prompt.md`:

```md
You help callers plan around the weather. Answer in one or two sentences —
this is a phone call, not a paragraph.
```

`tools/get_weather.ts` — the model calls this `get_weather`:

```ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Get current weather for a city",
  inputSchema: z.object({ city: z.string().describe("City name") }),
  execute: async ({ city }) => {
    const res = await fetch(
      `https://wttr.in/${encodeURIComponent(city)}?format=j1`,
    );
    return await res.json();
  },
});
```

`aai dev` serves that with a browser voice client and rebuilds on save.
That is a working agent.

## The voice problems you'd otherwise solve yourself

All of this is on by default unless the table says otherwise — and where
there is something to tune, the knob is named, on `agent()` or on the
provider descriptor. The numbers are measured, not guessed; each constant's
own doc carries the run behind it:

| Problem | What the runtime does | Field (default) |
| --- | --- | --- |
| A cough or a backchannel cuts the agent off mid-sentence | A barge-in needs real words and sustained speech before it abandons a reply | `minBargeInWords` (2), `interruptionMinDurationMs` (500) |
| Room noise trips a barge-in, and the agent never finishes the thought | An interruption that never commits a user turn is a *false* one, and the reply resumes from the last words the caller heard | `resumeFalseInterruption` (true) |
| A tool chain runs long and the caller hears silence | A turn that sends nothing to the voice for this long speaks a short filler — kept out of history, so the model never sees it | `deadAirCoverMs` (5000) |
| An LLM provider blips and the agent just goes quiet | The turn hands the conversation back out loud instead of dying silently | `errorPhrase` |
| The caller stops talking and waits for the agent to lead | The agent proactively takes a turn after a set silence, capped at 3 nudges | `silenceTimeoutMs` (off) |
| A pause mid-sentence gets transcribed as the end of the turn | Endpointing is two knobs, not one: when the end-of-turn check runs, and when to force-end regardless | `assemblyAIStt({ minTurnSilenceMs, maxTurnSilenceMs })` (1600 / 3500) |
| Someone else in the room ends up in the transcript | Voice Focus is pinned above the service default, because the interferer that matters is background *speech* | `assemblyAIStt({ voiceFocus, voiceFocusThreshold })` (`near-field` / 0.9) |
| One network hiccup turns the rest of a reply into stutter | Playback is a jitter buffer with hysteresis, and gaps are concealed by looping the decayed tail rather than zero-filled | (client-side; underruns reported per turn) |
| A whole reply lands in the socket at once on a slow link | The server paces audio out at a bounded lead, and discards held audio on a barge-in | (server-side) |

### An interrupted reply records what the caller HEARD

Text-to-speech runs behind the text, so when a caller interrupts, whatever
is still in the provider's buffer was never audible. Recording the full
generated reply tells the model it delivered information the caller never
got — and the model then never repeats it.

So history stores the words the caller is estimated to have actually heard,
marked `[interrupted]`; a reply cut before anything was audible records
nothing at all. Where the voice provider reports word timings the cursor
sits at the last word whose audio wholly elapsed, and where it doesn't the
estimate is clamped to a real speech rate and snapped to a word boundary.
The same cursor anchors the resume prompt, so a resumed reply can never
quote words the record denies.

### Resolving what a caller SAID

Tool arguments don't arrive as ids over a phone line — they arrive as
"cancel my second order", "the blue medium one", "eight six four two".
`resolveOne` picks one candidate, or fails in the one shape a model can
recover from on its own turn: a message listing the candidates.

```ts
import { isToolFailure, resolveOne, tool } from "@alexkroman1/aai";
import { z } from "zod";

type Order = { id: string; total: string };
const pending: Order[] = [
  { id: "W004", total: "$120.00" },
  { id: "W071", total: "$38.50" },
];

export default tool({
  description: "Cancel one of the caller's pending orders",
  inputSchema: z.object({ spoken: z.string().describe("What the caller said") }),
  execute: ({ spoken }) => {
    const order = resolveOne(pending, spoken, {
      label: "pending order",
      describe: (o) => `${o.id} for ${o.total}`,
      score: (o, text) => (text.includes(o.id.toLowerCase()) ? 1 : 0),
    });
    // Ambiguous, or nothing matched → the model asks, instead of cancelling
    // the wrong order and apologizing.
    if (isToolFailure(order)) return order;
    return { cancelled: order.id };
  },
});
```

A position wins outright — a caller who counts is unambiguous even when
nothing else is — and a scoring tie *fails* rather than guessing.
`spokenDigits` and `spokenOrdinal` are exported for narrowing by your own
vocabulary first.

## Swap any stage — or use one socket

Set any subset of `stt`, `llm`, `tts`; the stages you leave unset stay on
the AssemblyAI default. `llm` also takes a bare model id, so
`agent({ name: "…", llm: "claude-sonnet-4-6" })` swaps just the model.

| Subpath | Factories |
| --- | --- |
| `@alexkroman1/aai/stt` | `assemblyAIStt`, `deepgramStt`, `elevenLabsStt`, `sonioxStt` |
| `@alexkroman1/aai/llm` | `assemblyAILlm`, `anthropicLlm`, `openAILlm`, `googleLlm`, `mistralLlm`, `xAILlm`, `groqLlm`, `openRouterLlm`, `gatewayLlm` |
| `@alexkroman1/aai/tts` | `assemblyAITts`, `cartesiaTts`, `rimeTts` |

Factories return pure descriptors — serializable data, not SDK clients — so
no provider SDK and no secret ever enters the agent bundle; credentials
resolve server-side from the agent's own env.

Speech-to-speech is an explicit opt-in, never something you reach by
omission: `s2s: assemblyAIS2s()`, or `openAIS2s()` from
`@alexkroman1/aai/s2s`. There the transcription, the model loop and the
voice all run service-side over one socket.

## Two front doors: `agent()` and `workflowApp()`

Not every product is a microphone. Sometimes the audio arrives as a file and
the job takes minutes — a recording to transcribe, a call to redact, an
archive to summarize. Declare that with `workflowApp()` and you get an
ordinary web page over the same runtime, with no session, no live audio and no
model loop:

```ts no-check
import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import { transcribeFlow } from "./workflows/transcribe.ts";

export const transcribe = workflow({
  description: "Transcribe a recording by splitting it into chunks the API accepts",
  // An upload id, not the bytes — a run's input is journaled and replayed.
  input: z.object({ recording: z.string().describe("A linear-PCM WAV recording") }),
  // The one line that makes the form take a file: `<WorkflowFields>` renders a
  // picker, and `useWorkflowSubmit` stores the file before starting the run.
  uploads: ["recording"],
  run: transcribeFlow,
});

export default workflowApp({
  name: "Transcription Desk",
  workflows: { transcribe },
  // Checked at deploy time, so a missing key is named up front rather than
  // discovered by the run's second step.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});
```

The fields it *doesn't* take are the point: `systemPrompt`, `maxSteps`,
`syncState`, the provider stages and every voice knob are compile errors
here, not fields that quietly do nothing. Same definition type out, so
`aai dev`, `aai build` and `aai publish` treat it like any other agent — and
`<Form>`, `<WorkflowFields>`, `useWorkflowRun()` and `useWorkflowProgress()`
render the submit-and-watch page against a schema you already wrote.

The two compose. A voice agent starts a run from a tool
(`ctx.workflows.start(def, input)`) and answers the turn immediately, which is
the shape you want whenever the honest answer is "that'll take a few minutes".

## Durable, at two levels

Voice makes durability structural rather than a nice-to-have. A caller's
phone drops, a sandbox is evicted for idleness, you publish mid-conversation —
and none of that is supposed to cost the caller their place.

Two mechanisms, and the line between them is deliberate: **a conversation is
durable by its state, a background run is durable by its journal.** A live
turn is *not* a journaled step, and shouldn't be — replay only works when
re-running a step reproduces its result, and the product of a turn is audio
that already reached an ear. You can't re-speak it, a resumed half-sentence is
worse than a fresh one, and a step's arguments cross a queue, which no
sub-second turn budget survives. So what a dropped call restores is the
conversation's *state*, not the turn that was in flight. Work that genuinely
should be replayable gets handed to a workflow, which is what the `notify`
seam at the end of this section is for.

**A conversation is durable.** A session's state lives in a `sessionSlot` —
one declaration owning its key, its default, its reads, its writes, and its
projection to the browser:

```ts
import { sessionSlot } from "@alexkroman1/aai";

export const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
```

A tool reads it with `cartSlot.tool()` and writes it with
`cartSlot.updateTool()`, whose body is handed a mutable draft and stored the
moment it returns — synchronous, so a read-modify-write is atomic with no
lock. That matters because the model runs a step's tool calls
*concurrently*. Reads are handed a deeply frozen value, so mutating one is a
compile error rather than a write that silently goes nowhere.

Enable storage (`aai storage enable`, or a `DATABASE_URL` locally) and the
same code becomes durable: a crash, a redeploy, or a caller redialing into a
replacement process no longer loses the cart. That asymmetry is why it
matters — a client can replay the transcript, and nothing can replay state
back. Persistence is reliable across crashes and best-effort across
redeploys.

**A workflow run is durable in a stronger sense.** Bodies live in
`workflows/`, and the build transforms that directory into journaled steps.
An hour of audio is the case that makes the difference concrete — it is far
too long for one provider request, so it becomes a segment per step:

```ts
import {
  mapConcurrent,
  multipartBody,
  requireStepEnv,
  stepFetch,
  stepReadUpload,
  stepReport,
} from "@alexkroman1/aai/step";

type Segment = { index: number; start: number; end: number };

export async function transcribeFlow(input: { recording: string }) {
  "use workflow";

  const segments = await planSegments(input.recording);
  // Four at a time, each its own step: a rate limit or a dropped connection
  // costs one segment, and a resumed run re-does only what never finished.
  const parts = await mapConcurrent(segments, 4, (segment) =>
    transcribeSegment(input.recording, segment),
  );
  // Pure and deterministic, so it is safe in a body that replays.
  return { text: parts.map((part) => part.text).join(" ") };
}

async function planSegments(uploadId: string): Promise<Segment[]> {
  "use step";
  // Read the header alone — the bytes never travel in the run's input, and a
  // resumed step re-reads only its own window.
  const { info } = await stepReadUpload(uploadId, { end: 64 * 1024 });
  await stepReport(`Planning ${info.name} — ${info.size} bytes.`);
  return [{ index: 0, start: 44, end: info.size }];
}

async function transcribeSegment(uploadId: string, segment: Segment) {
  "use step";
  await stepReport(`Transcribing segment ${segment.index + 1}.`);
  const audio = await stepReadUpload(uploadId, { start: segment.start, end: segment.end });
  const part = multipartBody({
    name: "audio",
    filename: `segment-${segment.index}.wav`,
    type: "audio/wav",
    bytes: audio.bytes,
  });
  // `stepFetch`, not `fetch`: it pins HTTP/1.1, so a fan-out hitting a capacity
  // limit gets a readable status instead of a stream reset carrying none.
  const res = await stepFetch("https://sync.assemblyai.com/transcribe", {
    method: "POST",
    headers: { authorization: requireStepEnv("ASSEMBLYAI_API_KEY"), ...part.headers },
    body: part.body,
  });
  const body = (await res.json()) as { text?: string };
  return { index: segment.index, text: body.text ?? "" };
}
```

What "durable" buys, concretely: the body **replays from the top** on every
resume and each completed step returns its journaled result unchanged, so a
sixty-segment run survives the process it started in — restart it at segment
41 and the first forty are not re-billed. `sleep("6 hours")` suspends rather
than blocks, so the container is free to exit and the run resumes when it
comes due. A step that throws is retried (`RetryableError` versus
`FatalError` is yours to decide, `isTransientStatus()` sorts the usual HTTP
cases, and `retryAfter()` carries a provider's own `Retry-After` instead of a
backoff you invented). A run can wait on a third-party callback through a
webhook whose public URL the SDK mints, and `wake` sends a sleeping run on
early rather than making you choose between waiting and cancelling. The
`stepReport()` lines above are retained with the run instead of streamed
live-only, so a page that reloads mid-transcription — or opens tomorrow —
reads the whole log, and the same line lands in the server log with its
attempt number attached.

The constraints are the other half of the same deal, and they follow from
replay: no `Date.now()`, no `Math.random()`, no `fetch` in a body — those
belong in a step — and a step's arguments and return value cross a queue, so
they must be JSON-shaped and small. Put bytes in an upload and pass the id.

**And a run can come back to the phone call.**
`ctx.workflows.start(def, input, { notify })` makes the session that started
the run take an unprompted, interruptible turn when it lands, which is how an
agent keeps the "I'll let you know" it just promised rather than leaving the
caller to ask again.

## A phone call is an ordinary session

`createServer` serves `WS /phone` by default, so `aai dev`, a self-hosted
server and every published agent answer Twilio Media Streams and Telnyx
media streaming with no per-agent configuration. Nothing below the carrier
bridge knows a call is a phone call — it speaks the same client protocol the
browser does, so barge-in, history and every knob above behave identically.

## The browser client is optional, and replaceable

Every agent gets a voice UI for free. Add a `client.tsx` and you get the
same shell with your own panel, or the whole page:

```tsx
import { client, useAgentState } from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";

type CartView = { items: string[]; total: string };
const EMPTY: CartView = { items: [], total: "$0.00" };

function CartPanel() {
  // Server state, projected by the agent's `syncState` after every tool call.
  const cart = useAgentState<CartView>(EMPTY);
  return (
    <ul>
      {cart.items.map((item) => (
        <li key={item}>{item}</li>
      ))}
      <li>
        <strong>{cart.total}</strong>
      </li>
    </ul>
  );
}

client({ sidebar: CartPanel });
```

`useSession()` exposes connection state and the transcript,
`useUserTranscript()` distinguishes "speech detected" from "first word back"
(a live caption is a beat late if you collapse them), `useToolResult(name,
cb)` renders a card per tool call, and `useEvent(name, cb)` receives whatever
a tool pushed with `ctx.send`. For a non-React client,
`createSessionCore()` is the same session as a plain store.

## Test it like code

Tools are plain functions, so `aai test` is vitest.
`@alexkroman1/aai/testing` supplies the collaborators: `createToolContext()`
builds a `ToolContext` with inert defaults and a recording `ctx.send`,
`stubGenerate` and `stubGateway` drive the model calls a tool makes, and
`withDiscoveredTools()` gives a spec the same tool table a published agent
runs — so a test reaches a tool by the name the model calls it by.

## Packages

| Package | What it is |
| --- | --- |
| [`@alexkroman1/aai`](./packages/aai/README.md) | The SDK: `agent()`, `tool()`, `sessionSlot()`, provider factories |
| [`@alexkroman1/aai-ui`](./packages/aai-ui/README.md) | Browser client: React components, hooks, and the framework-agnostic session core |
| [`@alexkroman1/aai-runtime`](./packages/aai-runtime/README.md) | The host runtime: `createRuntime()`, `createAgentServer()`, the thing that runs an `agent.ts` |
| [`@alexkroman1/aai-cli`](./packages/aai-cli/README.md) | The `aai` CLI: init, dev, test, build, publish, secret, storage |

## Self-hosting

Agents don't require the managed platform: `@alexkroman1/aai-runtime`
exposes the same engine `aai dev` runs. Define an agent with `agent()`,
build a runtime with `createRuntime()`, and serve voice sessions from your
own Node process with `createServer()` — or wire `runtime.startSession(ws)`
into an existing WebSocket stack. See
[examples/self-hosted-server](./examples/self-hosted-server) for a runnable
~70-line setup.

## Documentation

- [API reference](https://alexkroman.github.io/agent/) — generated docs
  for the published SDK packages
- [scaffold/CLAUDE.md](./packages/aai-templates/scaffold/CLAUDE.md)
  — the full authoring guide, for humans and agents building voice agents
  (it ships inside the SDK as `AGENT_GUIDE.md`)
- [CLAUDE.md](./CLAUDE.md) — for humans and agents working on the aai
  framework itself
