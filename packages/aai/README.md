# @alexkroman1/aai

The aai voice-agent SDK: everything an `agent.ts` file imports. The
self-hostable runtime the CLI and the managed platform run is
`@alexkroman1/aai-runtime`.

```sh
npm i @alexkroman1/aai zod
```

Most projects don't install this directly — `aai init` (from
[`@alexkroman1/aai-cli`](https://www.npmjs.com/package/@alexkroman1/aai-cli))
scaffolds a project with it wired up.

## The simple case stays simple

One mode of the SDK is a prompt, a voice and some keyterms over a single
socket — the whole agent:

```ts
import { agent, assemblyAIS2s } from "@alexkroman1/aai";

export default agent({
  name: "Support",
  systemPrompt: "Help callers with their orders.",
  s2s: assemblyAIS2s({ voice: "jane", keyterms: ["AssemblyAI"] }),
});
```

Everything below is what becomes available when your own code runs alongside
it. Nothing here is required to get a working agent.

| Capability | What it is | Where |
| --- | --- | --- |
| Tools | a file in `tools/` the model may call | [`tool()`](#tools-a-tool-is-a-file) |
| Builtins & code execution | opt-in model-callable tools, up to running real JS | [`builtinTools`](#built-in-tools-and-code-execution) |
| Typed session state | named, typed state tools read and write across turns | [`sessionSlot()`](#typed-session-state) |
| Turn-level durability | a dropped call resumes where it was | [resume](#every-session-can-resume) |
| Dialogs | conversation order enforced in code, not suggested in the prompt | [`dialog()`](#conversation-order-as-a-guarantee) |
| In-tool intelligence | a one-shot LLM call inside a tool, returning an exact shape | [`ctx.generate()`](#understanding-mid-turn) |
| Subagents | a second tool loop with its own tools and context window | [`ctx.delegate()`](#subagents) |
| Durable workflows | journaled runs that outlive the call | [`workflow()`](#work-that-outlives-the-call) |
| A custom product surface | a web UI over the session, showing only what you project | [`syncState`](#voice-in-screen-out) |
| Transports | the same agent on browser WebSocket, Twilio and Telnyx | [phone](#one-agent-every-line) |
| Engineering lifecycle | isolated tool tests, build-time checks, deploy or self-host | [testing](#testing-a-tool) |
| Behavioral evals | drive a real session and assert what the agent did | [`describeEval`](#behavioral-evals) |

## Defining an agent

`agent.ts` — the definition, plus the slot that owns this session's state:

```ts
import { agent, sessionSlot } from "@alexkroman1/aai";

export const notesSlot = sessionSlot("notes", () => ({ items: [] as string[] }));

export default agent({
  name: "Notes",
  systemPrompt: "You take short notes for the caller.",
  // Show the slot to the browser client, read there with `useAgentState`.
  syncState: notesSlot.projection((notes) => ({ count: notes.items.length })),
});
```

- `agent()` — the agent definition; every field and default is documented
  on [`AgentDef`](https://alexkroman.github.io/agent/). With no provider
  fields it runs the default all-AssemblyAI STT → LLM → TTS pipeline,
  billed to one `ASSEMBLYAI_API_KEY`; `voice: "michael"` picks its TTS
  voice.
- `tool()` — a typed tool for the stateless case: Zod `inputSchema` and an
  `execute(args, ctx)` that runs server-side with `ctx.env` (secrets),
  `ctx.signal` (aborts on barge-in), `ctx.generate` (one-shot LLM calls),
  `ctx.delegate` (subagents), `ctx.workflows` (start and find durable runs)
  and `ctx.send` (push events to the browser client).
- `sessionSlot()` — a typed named slot owning a session's state. `slot.tool()`
  reads it (the value is deeply frozen) and `slot.updateTool()` writes it
  synchronously. There is no `ctx.state` and no `ctx.db`.
- `dialog()` / `procedure()` — a flow the model is gated by, and a flow your
  own code drives.
- `subagent()` — a second tool loop to delegate to.
- `workflow()` / `workflowApp()` — a durable run, and a form-shaped agent whose
  front door is a workflow rather than a microphone.
- `assemblyAIPipeline()` — the same default pipeline as an explicit spread
  (`...assemblyAIPipeline({ region: "eu" })`), for when you want the three
  stages visible in the config or an EU region across STT and the gateway.

`agent()` takes one object. `AgentDef` is the reference for what each field
MEANS — every field and default is documented there — and `AgentParams` is the
reference for which combinations are LEGAL. A fuller configuration, with the
fields the example above leaves out:

```ts
import { agent, sessionSlot } from "@alexkroman1/aai";

const cart = sessionSlot("cart", () => ({ items: [] as string[] }));

export default agent({
  name: "Storefront",
  systemPrompt: "You help callers order from the catalog. Confirm before charging.",
  greeting: "Storefront here — what are you after?",
  voice: "michael",
  // Server-side helpers the model may call, on top of your own tool files.
  builtinTools: ["calculate"],
  // Tool-calling steps per reply, and how long a pause ends the caller's turn.
  maxSteps: 6,
  minTurnSilenceMs: 1200,
  // What the browser client renders with `useAgentState`.
  syncState: cart.projection((c) => ({ count: c.items.length })),
  // Observe-only hooks over the session event stream.
  events: {
    "tool.called": (event) => {
      console.log("called", event.toolName);
    },
  },
});
```

## Tools: a tool is a FILE

An agent's value is the actions it takes, and every one of them lives in a
system only your code can reach. A tool is a file in `tools/`, named by its own
filename — `agent()` takes no `tools` field and nothing registers it:

```ts no-check
// tools/add_note.ts — `no-check`: `../agent.ts` is a file in YOUR project.
import { z } from "zod";
import { notesSlot } from "../agent.ts";

export default notesSlot.updateTool({
  description: "Save a note for the caller",
  inputSchema: z.object({ text: z.string() }),
  // `updateTool` hands the body a mutable draft, stored when it returns.
  execute: ({ text }, notes) => {
    notes.items.push(text);
    return { saved: notes.items.length };
  },
});
```

Secrets stay out of the code, and in-flight work stops the moment the caller
interrupts — **pass `ctx.signal` to anything slow**:

```ts
import { requireEnv, tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Get current weather for a city",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }, ctx) => {
    const key = requireEnv(ctx, "WEATHER_KEY");
    const resp = await fetch(`https://api.example.com/weather?q=${city}&key=${key}`, {
      // Aborts on barge-in, reset, session stop, or this call's timeout.
      signal: ctx.signal,
    });
    return await resp.json();
  },
});
```

## Built-in tools and code execution

`builtinTools` opts the model into server-side helpers it can call —
`web_search`, `visit_webpage`, `get_page_design`, `fetch_json`, `think`,
`remember`/`recall`, `calculate`, and `run_code`, where the model writes
JavaScript and runs it in the agent's sandbox. Models are unreliable at mental
arithmetic; real execution is what makes the number right on a call where the
caller is about to act on it.

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Analyst",
  systemPrompt: "Use run_code for ANY math, counting, or data processing.",
  builtinTools: ["web_search", "run_code"],
});
```

Omitting `builtinTools` enables none of them. The network-facing builtins take
model-controlled URLs, so they are SSRF-screened outside a container and cap
what comes back; `run_code` needs the platform sandbox and refuses outside one.

## Typed session state

Long calls accumulate facts — the order number, what's been verified, what's in
the cart. Without structured state the agent re-derives them from the transcript
every turn. `sessionSlot()` is one declaration in a shared module, and the only
way to keep state across a session's tool calls:

```ts
import { sessionSlot } from "@alexkroman1/aai";
import { z } from "zod";

export const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));

// `slot.tool()` READS — what the body is handed is frozen.
export const listCart = cartSlot.tool({
  description: "List what's in the cart",
  execute: (_args, cart) => ({ items: cart.items }),
});

// `slot.updateTool()` WRITES — mutate the draft; it is stored when the body
// returns, so a write is SYNCHRONOUS and may not `await`.
export const addItem = cartSlot.updateTool({
  description: "Add an item to the cart",
  inputSchema: z.object({ item: z.string() }),
  execute: ({ item }, cart) => {
    cart.items.push(item);
    return { count: cart.items.length };
  },
});
```

Slots hold plain data (a `Map`, `Set`, `Date` or class instance is refused with
the field named). On the platform they are stored for you — a crash or a
redeploy no longer loses them, and there is nothing to enable. Under `aai dev`
they live in memory unless you set a `DATABASE_URL`; the code is the same
either way.

## Every session can resume

Connections drop, and five minutes of identity verification plus a half-built
order shouldn't restart. A client reconnecting with `?sessionId=<id>` rejoins
the same session: the event log is restored, slot values are rehydrated, and
the greeting is suppressed because the caller has already heard it. A resume
that finds nothing is treated as a new session and greets, rather than sitting
connected and silent. Background work is found again by key — on a later turn,
or on the next call:

```ts
import { tool, workflow } from "@alexkroman1/aai";
import { z } from "zod";

export const research = workflow({
  description: "Research a topic",
  input: z.object({ topic: z.string() }),
  run: async (input) => ({ topic: input.topic, findings: [] as string[] }),
});

export default tool({
  description: "Check on research from earlier",
  execute: async (_args, ctx) => {
    // The run outlived the call — find it by the key it was started with.
    const [run] = await ctx.workflows.find(research, ctx.sessionId);
    if (!run) return { status: "none started" };
    return run.status === "completed" ? run.output : { status: run.status };
  },
});
```

## Conversation order as a guarantee

"Verify before disclosing" in a system prompt is advice. `dialog()` makes it a
rule: a tool declared with `when` simply does not run outside those states, and
the model gets back a `ToolFailure` naming what has to happen first. The
position is a slot underneath, so it survives a reconnect.

```ts
import { dialog } from "@alexkroman1/aai";
import { z } from "zod";

export const claim = dialog("claim", {
  initial: "verifying",
  states: {
    verifying: {
      instruction: "Verify the caller's policy number before quoting anything.",
      on: { VERIFIED: "quoting" },
    },
    quoting: {
      instruction: "Quote the excess. Do not re-verify.",
      on: { QUOTED: "done" },
    },
    done: { final: true },
  },
});

// Cannot run before the caller is verified; advances the dialog when it does.
export const quoteClaim = claim.tool({
  when: "quoting",
  send: { type: "QUOTED" },
  description: "Quote the premium for an excess",
  inputSchema: z.object({ excess: z.number() }),
  execute: ({ excess }) => ({ premium: excess * 2 }),
});
```

States and events are inferred from the spec, so a misspelled `send` is a
compile error. `procedure()` is the sibling for a flow YOU drive with no model
in the loop — an XState machine with branches, retries and a bounded budget,
run with `await procedure(machine).run(input)`.

## Understanding mid-turn

Agents constantly need small acts of understanding inside a turn: pull the order
out of a rambling sentence, classify an intent, grade a retrieved document.
`ctx.generate()` is one LLM call, host-side, with a guaranteed shape back:

```ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Start an order from what the caller just said",
  inputSchema: z.object({ utterance: z.string() }),
  execute: async ({ utterance }, ctx) => {
    const parsed = await ctx.generate({
      prompt: `Extract the order from: "${utterance}"`,
      schema: z.object({ sku: z.string(), qty: z.number() }),
    });
    // `object` is typed by the schema: { sku: string; qty: number }.
    return parsed.object;
  },
});
```

It defaults to the agent's own `llm`; pass an `llm` descriptor or a model-id
string to use any provider whose key is in the agent's secrets — which is also
how an S2S agent reaches a model.

## Subagents

Complex requests take an unknown number of lookups the caller never needs to
hear. Run inline they bloat the conversation and slow every later turn;
delegated, the legwork happens off to the side — in parallel when there are
several angles — and the call carries only the answer. A subagent is a second
tool loop with its own system prompt, model, tools and context window:

```ts
import { subagent, tool } from "@alexkroman1/aai";
import { z } from "zod";

const researcher = subagent({
  name: "researcher",
  systemPrompt:
    "Research the task with the tools you have. IMPORTANT: your final message " +
    "is the only thing the caller sees — end with a self-contained summary.",
  builtinTools: ["web_search", "visit_webpage"],
  maxSteps: 6,
});

export default tool({
  description: "Research a question in depth",
  inputSchema: z.object({ question: z.string() }),
  execute: async ({ question }, ctx) => {
    const { text, toolCalls } = await ctx.delegate(researcher, { task: question });
    return { answer: text, lookups: toolCalls.length };
  },
});
```

You receive its FINAL message, and its context is isolated — so tell it to
summarize, and write `task` as a complete brief. Delegation is one level deep.

## Work that outlives the call

No caller holds four minutes while a report generates. A tool starts a durable
run and answers the turn; the run is journaled, so it survives a restart, a
redeploy and an idle sandbox. With `notify` the agent speaks the result when it
lands — an ordinary interruptible turn, only if the caller is still on the line.
If they've hung up, the run completes anyway and the next call finds it by `key`.

```ts
import { tool, workflow, type WorkflowCtx } from "@alexkroman1/aai";
import { z } from "zod";

// workflows/research.ts — an ordinary async function of its input and a ctx.
export async function researchFlow({ topic }: { topic: string }, ctx: WorkflowCtx) {
  // `ctx.step` runs once and journals what it returned; a replay never re-runs
  // it. The body itself makes no undurable decision — no Date.now(), no fetch.
  const findings = await ctx.step("gather", () => gather(topic));
  // Suspended, not blocked: the container may exit here and resume when due.
  // Ten minutes and six hours work the same way.
  await ctx.sleep("settle", 10 * 60 * 1000);
  return findings;
}

declare function gather(topic: string): Promise<{ topic: string; points: string[] }>;

export const research = workflow({
  description: "Research a topic and report back",
  input: z.object({ topic: z.string() }),
  run: researchFlow,
});

// tools/research_topic.ts — promise made, and kept.
export default tool({
  description: "Research a topic in the background",
  inputSchema: z.object({ topic: z.string() }),
  execute: async ({ topic }, ctx) => {
    await ctx.workflows.start(research, { topic }, {
      key: ctx.sessionId,
      notify: "Tell the caller what it found.",
    });
    return { started: true };
  },
});
```

Declare the workflow on the agent (`agent({ workflows: { research } })`) and
`ctx.workflows` can `start`, `find`, `get`, `wakeUp` and `stream` its runs.
When the product IS the form rather than the call, `workflowApp()` is an agent
whose front door is a workflow — no session, no LLM loop, and every voice knob
a compile error.

## Voice in, screen out

The caller talks while a cart, form or itinerary updates on screen — voice for
input, screen for confirmation. That is how an order gets placed without reading
sixteen digits aloud. `syncState` takes a PROJECTION, not a flag, so you choose
what the browser is allowed to see:

```ts
import { agent, sessionSlot } from "@alexkroman1/aai";

// shared.ts — compose the projection once and import it at both ends.
export const cartSlot = sessionSlot("cart", () => ({
  cart: [] as string[],
  staffPin: "",
}));

// `staffPin` never reaches the browser.
export const cartProjection = cartSlot.projection((s) => ({ cart: s.cart }));

export default agent({ name: "Storefront", syncState: cartProjection });
```

```tsx
import { sessionSlot } from "@alexkroman1/aai";
import { client, useAgentState } from "@alexkroman1/aai-ui";

// client.tsx — in a project this is `import { cartProjection } from "./shared.ts"`,
// the same value the agent declared, so the two ends cannot name different views.
const cartProjection = sessionSlot("cart", () => ({ cart: [] as string[] })).projection(
  (s) => ({ cart: s.cart }),
);

function App() {
  // The projection types the state AND supplies the frame rendered before the
  // first push — no type argument, no `?? EMPTY`.
  const view = useAgentState(cartProjection);
  return (
    <ul>
      {view.cart.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

client({ component: App });
```

The projection runs after every tool call and is sent only when the result
changed. `ctx.send(event, data)` is the push channel for everything that isn't
state; `@alexkroman1/aai-ui` has the hooks and components.

## One agent, every line

A deployed voice agent already serves carrier media streams — there is nothing
to switch on and nothing in `agent.ts` changes. Point a number's voice webhook
at the agent and answer with a media stream:

```text
wss://<your-agent-url>/phone?carrier=twilio
wss://<your-agent-url>/phone?carrier=telnyx
```

Twilio and Telnyx are the carriers this build decodes; both speak 8 kHz mu-law,
which the bridge transcodes in both directions, so the same turn-taking,
barge-in, tools and slots run on a call as in the browser. A phone call is a
transport, not a mode — what you tested in the web demo is what callers get.

## Session modes and providers

**Pipeline mode** (default) streams STT partials into a server-side LLM
loop and speaks the reply through a TTS provider. Swap any stage with a
factory from the provider subpaths — set any subset of `stt`, `llm`, `tts`;
the unset stages keep the AssemblyAI default:

| Subpath | Factories |
| --- | --- |
| `@alexkroman1/aai/stt` | `assemblyAIStt`, `deepgramStt`, `elevenLabsStt`, `sonioxStt` |
| `@alexkroman1/aai/llm` | `assemblyAILlm`, `anthropicLlm`, `openaiLlm`, `googleLlm`, `mistralLlm`, `xaiLlm`, `groqLlm`, `openrouterLlm`, `gatewayLlm` |
| `@alexkroman1/aai/tts` | `assemblyAITts`, `cartesiaTts`, `rimeTts` |

Factories return pure descriptors — serializable data, not SDK clients.
Credentials are resolved server-side from the agent's env (each factory's
docs name the env var), so no provider SDK or secret ever enters the agent
bundle. `llm` also accepts a model-id string: `"creator/model"` routes
through the Vercel AI Gateway, a bare id through the AssemblyAI LLM
Gateway — `agent({ name: "...", llm: "claude-sonnet-4-6" })` swaps just the
model.

**S2S mode** is the explicit opt-in to a speech-to-speech service, where
STT, the LLM loop, and TTS all run service-side over one socket:
`s2s: assemblyAIS2s()` (root export) or `openaiS2s()` from
`@alexkroman1/aai/s2s`.

## Testing a tool

A complex agent is a living codebase — dozens of tools, an evolving prompt,
several people editing it. A tool is a file, so `agent.ts`'s default export
carries no tools; `deployedAgent` gives you the definition a deployed agent
runs, and each tool is then callable in isolation with no session, no model and
no network:

```ts no-check
// `no-check`: `./agent.ts` and `./tools/` are files in YOUR project, not here.
import { createToolContext, deployedAgent, runTool } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";
import authored from "./agent.ts";

const agentDef = deployedAgent(authored, {
  tools: import.meta.glob("./tools/*.ts", { eager: true }),
});

test("saves a note", async () => {
  expect(await runTool(agentDef, "add_note", { text: "milk" }, createToolContext())).toEqual({
    saved: 1,
  });
});
```

`createToolContext()` builds a full `ToolContext` with inert defaults and a
recording `ctx.send`; `stubGenerate`, `stubDelegate`, `stubGateway` and
`stubUploads` drive what a tool's collaborators answer. `aai build` runs the
suite and type-checks the project before it bundles.

## Behavioral evals

A prompt tweak that improves tone can quietly degrade tool discipline, and
nobody hand-tests forty scenarios per edit. `describeEval` (from
`@alexkroman1/aai-runtime/eval/vitest`, run by `aai eval`) drives a real
session and asserts what the agent DID — which tools it called, in what order,
and what it said:

```ts
import { agent } from "@alexkroman1/aai";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";

const agentDef = agent({ name: "Support", systemPrompt: "Look orders up before answering." });

describeEval(agentDef, (test) => {
  test(
    "looks the order up first",
    async ({ session }) => {
      const turn = await session.say("where is order W1234?");
      expect(turn.toolCalls.map((c) => c.name)).toContain("look_up");
      expect(turn.text).toMatch(/shipped/i);
    },
    // What a scripted model answers when there is no provider key — the eval
    // still proves the agent boots, tools resolve, and a reply comes back.
    { stubReply: "Order W1234 shipped yesterday." },
  );
});
```

With a provider key the same file drives a live model; without one it runs
scripted, so it is free and deterministic in CI.

## Other subpaths

Each subpath is named by WHO READS IT — reach for one when the right-hand
column describes what you are doing.

| Subpath | Reach for it when |
| --- | --- |
| `/testing`, `/testing/vitest` | testing your own tools — `createToolContext`, `deployedAgent`, `runTool` |
| `/stt`, `/llm`, `/tts`, `/s2s` | picking a provider for a pipeline stage (the table above) |
| `/step`, `/step-errors`, `/step-files` | writing a step inside a workflow — `stepFetch`, `stepEnv`, `mapConcurrent`, `stepGenerate`, `readUploadToFile` |
| `/workflow-api` | calling a deployed agent from a page, a script or a cron job — `createAgentClient` |
| `/tools` | calling `fetchJson`, `visitWebpage` or `webSearch` from your own tool code |
| `/channels` | posting a result somewhere — `slackChannel`, `sendToChannel` |
| `/html` | reading a page or a feed — `htmlToText`, `pageMetadata`, `parseFeed` |
| `/utils` | small helpers written inside a tool body — `toolFailure`, `errorMessage`, `pushCapped`, `withLock` |
| `/ffmpeg` | running ffmpeg from a step — `runFfmpeg`, `probeMedia`, `transcodeToWav` |
| `/protocol`, `/manifest`, `/slugify`, `/workspace-files`, `/internal` | framework internals used by the CLI and the platform; not a public API and not covered by semver |

## Documentation

Full API reference: <https://alexkroman.github.io/agent/>

The complete authoring guide — every `agent()` field, the workflow rules, the
UI hooks, the voice-prompt rules — ships beside this file as
[`AGENT_GUIDE.md`](./AGENT_GUIDE.md).
