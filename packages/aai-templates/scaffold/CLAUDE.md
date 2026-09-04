# aai Voice Agent

You are helping build a voice agent using the **aai** framework.

## Workflow

The fast loop: edit → `pnpm dev` (browser, talk to it) →
`pnpm test` (logic) → `pnpm build` (validate bundle).

1. **Iterate in `pnpm dev`** — browser UI, and `pnpm dev -- --watch` to
   rebuild and restart on every save. Speak to the agent to verify behavior
   end-to-end. This is the primary feedback loop. Watching is OPT-IN because a
   restart ends in-flight voice sessions, which is right while you are editing
   and wrong while something is driving the agent for twenty minutes;
   `AAI_DEV_WATCH=1` is the same switch for a process supervisor.
2. **Run `pnpm test` after logic changes** — vitest. Co-locate tests as
   `agent.test.ts` (see `pipeline-simple` template for a reference).
   **When the project has an `agent.test.ts` (the default `simple`
   template and several others ship one), it is yours to maintain.** It
   asserts the agent's shape — name, providers, tool names —
   so rewriting the agent without updating it leaves a test asserting an
   agent that no longer exists. When a test fails after your change, decide
   which side is stale: updating the test to match the new agent is a normal
   fix, not a workaround. Do not delete a test to make it pass.

   **A spec that needs the agent as DEPLOYED imports one module:**

   ```ts
   import agentDef from "virtual:aai/agent";
   ```

   That is `agent.ts` with its `tools/` directory discovered and its
   `system-prompt.md` applied — the same lowering `aai build` does, so a spec
   measures the agent that ships rather than the raw default export (which has
   no tools and the framework's default prompt). `vitest.config.ts` registers
   the plugin that serves it; a scaffolded project already has it. For a runner
   that is not vitest, `deployedAgent` on `@alexkroman1/aai/testing` is the same
   thing written out.
3. **Run `pnpm eval` when you change what the agent DOES** — a test asserts
   the agent's shape; an eval drives a real session and asserts what it did.
   Cases live in `agent.eval.test.ts` (the `simple` template ships one):

   ```ts no-check
   import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
   import { expect } from "vitest";
   import agentDef from "./agent.ts";

   describeEval(agentDef, (test) => {
     test(
       "looks the order up before answering",
       async ({ session }) => {
         // `say()` returns THAT turn — the reply, its tool calls, its events.
         const turn = await session.say("where is order W1234?");
         expect(turn.toolCalls.map((c) => c.name)).toContain("look_up");
         expect(turn.text).toMatch(/shipped/i);
       },
       // What a SCRIPTED model answers with when there is no key (below).
       { stubReply: "Order W1234 shipped yesterday." },
     );
   });
   ```

   Everything is real except the microphone and the speaker: your tools run,
   your prompt runs, the session's own event stream is what you assert over.
   Two things to know before reading a green run:

   - **With a provider key it uses a LIVE model** — it spends tokens, and it is
     a noisy instrument. One failure is a question, not a verdict; re-run before
     believing either answer.
   - **Without one it uses a SCRIPTED model** answering each case's `stubReply`,
     and says so. That still proves the agent boots, the tools resolve and the
     session reaches a reply — it proves nothing about what the agent SAYS. Give
     a case `{ live: true }` instead when no script could honestly stand in
     (a tool the model has to choose for itself, a refusal, a judgement).

   No eval can see anything below the audio boundary — when the agent decides
   you stopped talking, barge-in, two sentences merging into one turn. Those
   need `pnpm dev` and your own voice.
4. **Run `pnpm build` before declaring done** — bundles `agent.ts`,
   type-checks, validates the manifest, and runs the WHOLE spec suite first.
   Catches issues `dev` won't.
5. **Make small, focused changes** — verify each one before stacking the
   next.
6. **Look at templates before writing custom code** — the CLI ships working
   examples inside its own package, at
   `node_modules/@alexkroman1/aai-cli/dist/templates/`. Read them directly;
   `aai init --template <name>` scaffolds a fresh project from one. Closest
   matches: `simple`, `pipeline-simple`, `web-researcher`, `solo-rpg`,
   `pizza-ordering`, `retail` (the most complex — 15 tools over a
   relational store, with a `syncState`-driven UI). Four are ports of agents you
   may already know from LangChain/LangGraph, and each says in its own source
   what had to change: `travel-concierge` (their customer-support bot —
   specialist desks, and every booking staged for a spoken confirmation before
   it applies), `support-line` (self-RAG/CRAG — retrieve, grade what came back,
   rewrite the question, and refuse to speak an answer it cannot ground),
   `plan-and-execute` (plan then work the plan — one step per tool call, so the
   caller can redirect between them), and `redline` (the reflection agent — write,
   critique, revise, which is too slow for a phone and so is a PAGE over a
   durable run rather than a voice agent). When reading SDK
   types under
   `node_modules/@alexkroman1/aai*/dist/`, note the built entry points
   re-export with source specifiers (`"./sdk/constants.ts"`,
   `"./components/button.tsx"`) — rewrite `.ts`/`.tsx` to `.d.ts` to find
   the shipped file.

## CLI

```sh
npx @alexkroman1/aai-cli init             # Scaffold a new agent
npx @alexkroman1/aai-cli templates        # List available templates
npx @alexkroman1/aai-cli dev              # Start local dev server
npx @alexkroman1/aai-cli test             # Run agent.test.ts via vitest
npx @alexkroman1/aai-cli test --all       # ...or every spec in the project
npx @alexkroman1/aai-cli eval             # Run agent.eval.test.ts against a model
npx @alexkroman1/aai-cli build            # Bundle and validate
npx @alexkroman1/aai-cli deploy           # Deploy to production
npx @alexkroman1/aai-cli delete           # Remove deployed agent
npx @alexkroman1/aai-cli secret put NAME  # Set a secret
npx @alexkroman1/aai-cli secret delete NAME
npx @alexkroman1/aai-cli secret list
```

The scaffold's `package.json` exposes `dev`, `build`, `test`, `eval` and
`deploy` as `pnpm <name>` shortcuts. Other commands (`init`, `templates`,
`delete`, `secret`) are CLI-only.

**`aai test` targets `agent.test.ts` and nothing else**, which `--all` widens.
What matters is that a narrowed run does not report itself as a pass: when the
project holds spec files the run did not cover, it FAILS and names them rather
than printing a green line that says nothing about `tools/*.test.ts`. `pnpm
test` (the scaffold's own script) already runs the whole suite, and so does the
gate in front of `aai build`.

## Running it yourself (`npm start`)

`server.mjs` serves this agent from a plain Node process — no platform
account, nothing managed. It is the deployment counterpart of `aai dev`:

```sh
npm start                          # http://127.0.0.1:3000
PORT=8080 HOST=0.0.0.0 npm start   # bind every interface, e.g. in a container
```

`npm start` **builds first** (that is the `prestart` script) and then serves
the result: `server.mjs` boots `.aai/worker.mjs`, the same artifact
`aai publish` uploads. It serves your own `client.tsx` build when there is one
and falls back to `defaultClientDir()` (`@alexkroman1/aai-ui/client-dir`), the
prebuilt default UI shipped inside the package — the only export of `aai-ui`
that runs on Node rather than in the browser.

The build is what makes `tools/` work — a tool is registered by existing, and
the enumeration happens where the bundle is assembled, so a server that loaded
`agent.ts` directly would run an agent with none of its tools. The same build
produces your `client.tsx`, so a custom UI is served with no extra step.

Secrets work the same as everywhere else: `ctx.env` holds the keys declared
in `.env` (or `.env.example`), and a real environment variable of that name
wins — so `docker run -e MY_API_KEY=…` needs no `.env` in the image.

One thing to know: it binds **loopback by default**, because this server has
no request authentication of its own; set `HOST=0.0.0.0` only behind your own
proxy or auth.

Deleting `server.mjs` costs nothing: `aai dev`, `aai publish` and the managed
platform never read it. `run_code` is the one feature that does not follow —
it needs the platform's sandbox and refuses outside one.

## Project structure

```text
my-agent/
  agent.ts            # Agent definition (required)
  agent.test.ts       # Unit tests (optional)
  agent.eval.test.ts  # Behaviour evals, run by `pnpm eval` (optional)
  client.tsx          # Custom UI (optional, React)
  shared.ts           # Types shared between agent.ts and client.tsx
  system-prompt.md    # The system prompt — discovered, not imported
  tools/              # One file per tool — this is how a tool is declared
  workflows/          # Durable workflow bodies (optional — see "Workflow apps")
  package.json
  tsconfig.json
  .env                # Local dev secrets (gitignored)
```

## `agent()` API

```ts no-check
import { agent } from "@alexkroman1/aai";

export default agent({
  name: string;                              // required — display name
  systemPrompt?: string;                     // usually ABSENT — write system-prompt.md
                                             // instead; declare it only to COMPOSE one.
                                             // There is no `system` alias — one name.
  greeting?: string;                         // default: "Hey there..."
  voice?: string;                            // TTS voice for the default pipeline, e.g. "michael"
                                             // (shorthand for tts: assemblyAITts({ voice });
                                             // invalid with an explicit `tts` or with `s2s`)
  stt?: SttProvider;                         // pipeline stage overrides — set any subset;
  llm?: LlmProvider | string;                // unset stages default to AssemblyAI
  tts?: TtsProvider;                         // (llm also takes a model-id string)
  s2s?: S2sProvider;                         // explicit opt-in to speech-to-speech mode
                                             // all four types are on "@alexkroman1/aai",
                                             // and on their own stage subpath
  sttPrompt?: string;                        // STT guidance for jargon/acronyms
  builtinTools?: BuiltinTool[];              // see built-in tools table
                                             // (there is no `tools` field — a tool is a FILE;
                                             //  see "A file in tools/ IS a tool")
  maxSteps?: number;                         // default: 10 — max tool calls per turn
  temperature?: number;                      // sampling temperature for the agent's OWN model calls
                                             // (pipeline and text). Unset = the model's default; some
                                             // models ignore it and warn. S2S REFUSES it — the model
                                             // runs in the provider's service and never sees this.
  toolChoice?: ToolChoice;                   // "auto" (default) | "required" | "none"
                                             // | { type: "tool", toolName }
  idleTimeoutMs?: number;                    // disconnect after inactivity (ms)
  silenceTimeoutMs?: number;                 // pipeline only — assistant speaks up after this much user silence (ms)
  silencePrompt?: string;                    // instruction injected on silence timeout (requires silenceTimeoutMs)
  minBargeInWords?: number;                  // pipeline only — words before user speech interrupts the reply (default 2)
  interruptionMinDurationMs?: number;        // pipeline only — sustained speech (ms) before an interim barge-in interrupts (default 500; 0 disables)
  deadAirCoverMs?: number;                   // pipeline only — speak a short filler after this much silence in a turn (default 5000; 0 disables)
  resumeFalseInterruption?: boolean;         // pipeline only — resume an interrupted reply if no user turn commits (default true)
  preemptiveGeneration?: boolean;            // pipeline only — start the reply from a high-confidence interim (default false; true opts in)
  syncState?: StateProjection;               // show a slot to the client: slot.projection(view)
                                             // (read it with useAgentState; see UI hooks)
  minTurnSilenceMs?: number;                 // pipeline only — pause (ms) that ENDS a user turn once the
                                             // text reads complete (default 560)
  maxTurnSilenceMs?: number;                 // pipeline only — pause (ms) that ends a turn REGARDLESS of
                                             // content (default 1600). The endpointing knob to reach for:
                                             // it bounds the utterances that never read as finished.
                                             // Both are shorthand for the same options on the default
                                             // assemblyAIStt() stage — invalid with an explicit `stt`.
  requiredEnv?: string[];                    // env vars this agent reads. A deploy CHECKS them, so a
                                             // missing key fails at `aai push` instead of mid-call.
                                             // Declare every key any tool or step reads.
  text?: true;                               // text-only agent: no STT, no TTS, `llm` is the one stage
  events?: SessionEventHandlers;             // observe the session (see "Watching the session")
});
```

> Unless `s2s` is set, the agent runs in **Pipeline mode** — see the section
> below. Declare any subset of `stt`/`llm`/`tts`; unset stages default to
> AssemblyAI. `llm` also accepts a model-id string: `"creator/model"` routes
> through the Vercel AI Gateway (`AI_GATEWAY_API_KEY`), a bare id through
> the AssemblyAI LLM Gateway (`ASSEMBLYAI_API_KEY`).

Minimal agent — a cascaded pipeline, which is what you should build unless
the user asks for the speech-to-speech API:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
});
```

No provider fields means the default all-AssemblyAI pipeline: all three
stages bill to the one key a published agent is guaranteed to have. Pick
its voice with the `voice` field — this is the normal way to choose a
voice:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  voice: "paul",
});
```

Swap a single stage by declaring just that field — everything you leave
unset stays on the default. `llm` accepts the gateway model id as a plain
string:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  llm: "claude-sonnet-4-6",
});
```

`assemblyAIPipeline()` (from `@alexkroman1/aai`) is the explicit spelling of
the same default — spread it (`...assemblyAIPipeline({ region: "eu" })`) when
you want the three stages visible in the config or EU data residency across
STT and the LLM gateway. Speech-to-speech (S2S) mode is an explicit opt-in
via the `s2s` field — see below.

### `system-prompt.md` IS the system prompt

**Write the prompt in `system-prompt.md` beside `agent.ts`, and declare
nothing.** The build discovers the file, so there is no import line and no
field — the same rule `tools/` follows, applied to the one part of an agent
that is a DOCUMENT rather than a value:

```ts
// agent.ts — nothing about the prompt appears here
import { agent } from "@alexkroman1/aai";

export default agent({ name: "My Agent" });
```

Declare neither and the agent runs on `DEFAULT_SYSTEM_PROMPT`, exported from
`@alexkroman1/aai` so you can read what you are replacing — or compose against
it, rather than restating the voice rules at the bottom of this guide:

```ts
import { DEFAULT_SYSTEM_PROMPT, agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\nYou only ever discuss pizza.`,
});
```

```markdown
<!-- system-prompt.md -->
You are a concise, friendly assistant.

- Keep replies to one or two sentences.
- Never read a URL aloud.
```

Why the file rather than a string: a prompt is markdown — paragraphs, headings,
bulleted lists — and inline it becomes that document spelled as `\n\n` and `\n-`
escapes inside one string literal, with no wrapping, no preview, and a diff that
is one line no matter which bullet changed. Editing the prompt is the main loop
of building an agent, so it should land in the most reviewable place available,
not the least.

Three rules, each a build error naming the file:

- **A file nothing reads is an error.** If `system-prompt.md` exists and
  `agent.ts` declares a DIFFERENT `systemPrompt`, the build fails rather than
  ignoring the file — "I edited the prompt and nothing changed" is the failure
  this mechanism exists to prevent.
- **An empty file is an error**, not a silent fall-through to the framework
  default. Delete the file if that is what you want.
- **A `system-prompt/` directory is rejected.** One file, no concatenation
  order to guess.

**Composing a prompt is still legal, and it is the one case you write the import
for.** When part of the prompt is computed — a menu, a catalogue, today's date —
import the file and build the field; the build sees its own text inside your
prompt and leaves what you built alone:

```ts no-check
// `no-check`: the prompt file and the menu module are the project's, not this
// guide's — which is the point of the example.
/// <reference types="vite/client" />
import { agent } from "@alexkroman1/aai";
import systemPrompt from "./system-prompt.md?raw";
import { menuText } from "./menu.ts";

export default agent({ name: "Pizza", systemPrompt: `${systemPrompt}\n${menuText()}` });
```

`greeting` stays a field, deliberately: it is one sentence with no structure to
lose, and it crosses the wire to the browser beside `name` and `page`. **A
document goes in a file, a value stays in the call.**

**JSON imports need no attribute.** `resolveJsonModule` is on, so
`import data from "./knowledge.json"` is all it takes. Do NOT write
`assert { type: "json" }` — import assertions were replaced by import
attributes and TypeScript rejects them (`TS2880`). If you want to be
explicit the modern spelling is `with { type: "json" }`, but plain is fine.

## Workflow apps — `workflowApp()`

Not every agent's front door is a microphone. When the product is a FORM —
submit a job, watch it run, read the result — declare it with `workflowApp()`
instead of `agent()`:

```ts no-check
import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import { digestFlow } from "./workflows/digest.ts";

export const digest = workflow({
  description: "Summarize a link and file the digest",
  input: z.object({ url: z.url().describe("The link to digest") }),
  run: digestFlow,
});

export default workflowApp({
  name: "Link Digest",
  workflows: { digest },
});
```

That is the whole declaration, and the fields it does NOT take are the point:
a workflow app has no session and no LLM loop, so `systemPrompt`, `tools`,
`maxSteps`, `syncState`, `stt`/`llm`/`tts`/`s2s` and every voice knob
are **compile errors** here, not fields that quietly do nothing. `greeting` and
`requiredEnv` stay. `workflowApp()` is `agent({ …, page: "static" })` with the
discriminant already set — same definition object out, so `aai build`,
`aai dev` and `aai publish` treat it like any other agent.

Reach for it when the user asks for something that outlives a request: an
overnight job, an upload that takes minutes, anything waiting on a third-party
callback. Reach for `agent()` when someone is on the line — a voice agent can
also START a workflow from a tool (`ctx.workflows.start(def, input)`) and
answer the turn, which is the other shape.

**Runs are DURABLE on the platform with no setup.** A deployed app's runs live
on the platform's own database, so they survive a restart, a redeploy and an
idle sandbox. There is nothing to enable.

Under `aai dev` without a `DATABASE_URL` they live in the process that started
them — you can submit the form, watch the run and read its result, and
everything in flight is lost when that process goes away. That is the honest
tradeoff, and it is what
lets you build a workflow app before provisioning anything.

**A workflow UPLOAD is durable with no setup either**, and this paragraph used
to say the opposite. An upload's record is a platform row and its bytes are
platform storage, so `api.upload`, `<FileField>` and the file-taking form
hooks outlive the sandbox exactly as the runs reading them do — a deployed app
needs no database of its own for either half. Under `aai dev` they are as
temporary as the runs above: the bytes go to a per-process temporary directory
that a restart abandons. There is no `ctx.db` at all — see "Persisting data"
below.

### Workflow bodies live in `workflows/`

A body is an ordinary exported async function of its input and a `WorkflowCtx`.
There is no directive and no compile step of its own — the agent bundle compiles
`workflows/` like any other source file — and durability is a method call:

```ts
import type { WorkflowCtx } from "@alexkroman1/aai";

export async function digestFlow(input: { url: string }, ctx: WorkflowCtx) {
  const digest = await ctx.step("summarize", () => summarize(input.url));

  // Suspended, not blocked: the container is free to exit here and the run
  // resumes when it comes due. Six hours works the same as ten seconds.
  //
  // The first argument NAMES the wait, exactly as a step's name does, and for
  // the same reason: it is the wait's identity in the journal.
  await ctx.sleep("settle", 10_000);

  const filedAt = await ctx.step("file", () => file(digest));
  return { ...digest, filedAt };
}

async function summarize(url: string) {
  // The whole Node runtime is available in a step: fetch, a model call, a
  // database. Not in the body.
  return { url, headline: `What ${new URL(url).hostname} says`, points: [] };
}

async function file(_digest: { url: string }) {
  return new Date().toISOString();
}
```

`ctx.step(name, fn)` runs `fn` once, journals what it returned, and on every
later replay returns the journaled value without running it again. The step
functions themselves are ordinary functions — which is also what lets a spec call
one directly, with no engine in the path.

Three rules, and all three fail silently if broken — nothing scans a body for
them:

- **The body replays from the top on every resume**, so it holds no live handle
  and makes no undurable decision — no `Date.now()`, no `Math.random()`, no
  `crypto.randomUUID()`, no `fetch`. The three commonest have methods of their
  own (`ctx.now()`, `ctx.random()`, `ctx.uuid()` — see below); anything else goes
  inside a `ctx.step`, whose result is journaled and returned unchanged on
  replay.
- **A step's arguments and return value cross a queue**, so they must be
  JSON-shaped and small. Put bytes in storage and pass the key.
- **A step gets no tool context.** There is no `ctx.db` and no `ctx.generate`
  inside one — see below for how it reaches the agent's env and a model anyway.
  A step reaches a database the way a tool does: its own client, its own
  credential from `requireStepEnv`.

**A step's NAME is its identity in the journal**, so write a string literal and
keep it stable: renaming one makes an in-flight run re-run that step. A single
call site inside a loop or a `mapConcurrent` fan-out is exactly what the scheme
is for — each reach gets its own entry — but two DIFFERENT call sites should not
share a name: the journal keys an entry by `(name, occurrence)`, so two sites
alias onto one counter and read each other's journaled results. Nothing detects
it.

**Per-step retries are an argument, not a property.** Pass
`{ maxAttempts }` where a step deserves more patience than the default three:

```ts no-check
const digest = await ctx.step("summarize", () => summarize(input.url), {
  maxAttempts: 6,
});
```

**And a step body can read which attempt it is on**, so a step may degrade rather
than fail — a smaller model on the last try beats a failed run:

```ts
import { stepInfo } from "@alexkroman1/aai/step";

declare function callModel(url: string, model: string): Promise<string>;

export async function summarize(url: string) {
  const step = stepInfo();
  // `undefined` outside a run — a spec calling this directly — which reads as
  // "not retrying", the same branch a first attempt takes.
  const model = step?.isLastAttempt === true ? "small" : "large";
  return await callModel(url, model);
}
```

Read `isLastAttempt` rather than comparing `attempt` against a number you have
written down: the ceiling lives at the `ctx.step` call site, and a body that
restates it degrades early on every run once the two disagree — silently, since
it still returns an answer. `stubStepInfo` from `@alexkroman1/aai/testing` is how
a test reaches the retry branch.

### A clock, a random number and a uuid: `ctx.now`, `ctx.random`, `ctx.uuid`

The three undurable reads a body most often wants, each journaled — read once at
the first reach, and the same value on every later walk:

```ts
import type { WorkflowCtx } from "@alexkroman1/aai";

declare function charge(amount: number, idempotencyKey: string, jitter: number): Promise<void>;

export async function chargeFlow(input: { amount: number }, ctx: WorkflowCtx) {
  const startedAt = await ctx.now(); // epoch ms, decided once
  const idempotencyKey = await ctx.uuid(); // still the same id after a crash
  const jitter = await ctx.random(); // one float in [0, 1), journaled per call

  await ctx.step("charge", () => charge(input.amount, idempotencyKey, jitter));
  return { elapsedMs: (await ctx.now()) - startedAt };
}
```

`ctx.uuid()` is what an idempotency key for a downstream API wants: minted once,
and the same value after a resume, so a retried request is recognisably the same
request rather than a second one. `ctx.random()` draws one float per CALL, so a
loop is correct as written; a BULK draw belongs in a step
(`ctx.step("jitter", () => Array.from({ length: 1000 }, Math.random))`), which is
one journal entry instead of a thousand.

Two rules:

- **Call them from the BODY, never inside a `ctx.step`** — the engine refuses one
  there and the message names the fix. Inside a step there is nothing to fix: a
  step's internals are not replayed, only its result, so a plain `Date.now()` in
  a step body is already durable and is what to write.
- **A `ctx.uuid()` is not a hook TOKEN.** `ctx.waitFor`'s token has to be
  DERIVED from the run's own input, because whoever signals is usually a tool and
  a tool cannot see the body's local variables. See below.

### Waiting: `ctx.sleep` and `ctx.waitFor`

Both SUSPEND the run — the body stops, the container is free, and the engine
brings the run back — so a long wait costs nothing while it runs.

**How long a wait really survives is a property of the run STORE.** On the
platform it is durable with no setup, and a self-hosted deployment with a
`DATABASE_URL` is durable too — the wait outlives the body, the worker and the
process. Under `aai dev` without a `DATABASE_URL` the store is memory, so a wait
lives only as long as the dev server. The boot line reports which one is in play.

```ts no-check
// A label, then a duration in milliseconds or an absolute Date.
await ctx.sleep("review-window", 6 * 60 * 60 * 1000, { correlationId: "review" });

// Until somebody outside the run answers, via `ctx.workflows.signal(token, …)`
// from a tool, or by a delivery to `publicWebhookUrl` — both hops reach the
// same waitpoint.
const approval = await ctx.waitFor<{ approved: boolean }>(approvalToken(input.id), {
  timeoutMs: 120_000,
});
if (approval === undefined) return { published: false, reason: "nobody approved" };
```

Five things worth knowing:

- **A wait's NAME is its identity, exactly like a step's.** A sleep's `label` and
  a `waitFor`'s token are what the journal keys the wait on
  (`sleep!<label>#<occurrence>`, `hook!<token>#<occurrence>`), so make a label a
  string literal, give two call sites two labels, and let a loop reuse one — the
  occurrence count separates the iterations. This is what makes a wait behind an
  `if` safe: the body can reach a different NUMBER of waits on two walks and each
  one still finds its own record.
- **A hook's token must be DERIVED, not random.** Whoever signals is usually a
  tool, and a tool cannot see the body's local variables — so export one function
  that computes the token from the run's own input and import it in both places.
  Derive it from something that identifies the RUN rather than the caller: a
  token is held for the life of its run, so two runs deriving the same one is the
  second one failing.
- **`timeoutMs` resolves `undefined` when the window closes unanswered.** A
  closing window is an outcome to branch on, not a failure, and the engine closes
  the hook as it shuts so a late answer cannot change what already happened.
- **Racing the two WORKS, and is still not how to put a deadline on a wait.** A
  wait no longer unwinds the stack — it hands back a promise that never settles
  — so the body reaches every wait a `race` or an `all` puts in front of it and
  the run suspends once, on the earliest deadline among them. Reach for a race
  when the two waits are genuinely independent (a review window beside a retry
  backoff). For a deadline ON a wait, use `timeoutMs`: it is journaled WITH the
  hook, so one decision fixes the window, and its timeout arm CLOSES the hook
  before the body continues — a race has no such moment, and a signal landing
  just after it would make the next replay answer a window this one timed out.
- **`ctx.workflows.wakeUp(runId, { correlationIds: [id] })`** ends a sleep early,
  which is how a "send it now" tool cuts a scheduled wait short. Naming no ids
  wakes every outstanding SLEEP and deliberately not a `waitFor` deadline, so
  cutting a schedule short cannot also close an approval window.
- **A SUSPEND is not free, so `ctx.sleep` is not a `setTimeout`.** A wait costs
  a journal write to record it, a queued delivery to bring the run back, and a
  fresh WALK of the body — measured on a deployed agent at roughly a second of
  overhead around the sleep itself, on top of whatever you asked for. There is a
  cliff at the bottom of the range worth knowing about: a sleep shorter
  than the round trip that records it never suspends AT ALL — `ctx.sleep("beat",
  100)` and `ctx.sleep("beat", 0)` are both simply free — while anything longer
  pays the whole cost. Measured, `nap(100)` and `nap(0)` came back within 30 ms
  of each other on a run whose total was 2.1 s.

  So a sub-second pause is not what this is for. For a short backoff inside a
  step, use an ordinary timer (`sleep` from `@alexkroman1/aai/internal`) — a step
  body may not call `ctx.sleep` anyway, and the engine refuses one that does. Use
  `ctx.sleep` for a wait you want to SURVIVE the process, which is the thing a
  timer cannot do. A body that polls in a loop pays the suspend per iteration,
  which is the strongest argument for the next section: park on the callback.

#### A third-party callback is an OPTIMIZATION over a reconciling read

The webhook route is how a payment provider, a transcription service or an
approval mailer resumes a run, and `recap-workflow` is the worked example — it
hands AssemblyAI a `webhook_url` and parks on the delivery instead of polling
for twenty minutes. Five things about that shape, and every one of them is a
trap somebody has already paid for:

- **Mint it with `stepWebhookUrl(token)`, from inside the step that hands it
  over.** That is the step-side half of `ctx.workflows.publicWebhookUrl` — the
  tool-side one needs a `ToolContext`, and a workflow body and its steps are
  handed none, so a workflow app with no tools has only this one. It THROWS when
  the deployment cannot mint one, which a step should catch and treat as "no
  callback": a run must not fail over a missing optimization. And note
  `requireStepEnv("AAI_PUBLIC_BASE_URL")` is NOT a substitute — the public base
  URL is a boot parameter of the deployment, not one of the agent's own secrets,
  so that read is `undefined` in production precisely where the value exists.
- **Return the callback FACT from the step, and branch on that.** Whether a
  callback was registered decides whether the body parks, and a body may only
  branch on values that came out of the journal. Mint inside the step's function
  — it runs once, on first execution, never on a replay — and answer
  `{ id, callback }`. A body that re-minted on every walk could flip the branch
  under a redeploy and then look for a `waitFor` the journal never recorded.
- **Keep the poll as the TIMEOUT arm.** A webhook is one HTTP POST from a third
  party with no delivery guarantee you control: the sender gives up after its own
  retry budget, a deployment may not know its public URL, and a delivery that
  lands before your body reaches its wait is answered `404` and dropped. So read
  the state before you park and again after, give the wait a `timeoutMs`, and let
  an unanswered window fall through to the read. A run that hangs forever on a
  dropped delivery is strictly worse than one that polls.
- **Wait for the EDGE, not the answer.** Treat the payload as "something
  happened, go look" and get the fact from the far side's own API under your own
  credential. That is what makes an unauthenticated callback route safe: a forged
  delivery on a guessed token costs one extra read and changes no outcome. It
  holds by construction, where a shared secret holds only until somebody has to
  rotate it — and the route authorizes on the TOKEN and reads no other header, so
  a sender's own auth-header option would be sent and ignored.
- **One token, ONE `waitFor` per run.** A token is claimed for the life of its
  run and given back when the run goes terminal, so a second `ctx.waitFor` on the
  same token — a wait written inside a loop — THROWS. A throw is not a suspend,
  so a body with a `catch` will treat it as a failed run and start compensating.
  Park once, outside the loop.
- **You cannot test it under `aai dev` without a tunnel.** `publicUrl` there is
  `http://localhost:<backend port>`, which no third party can reach — so the
  delivery never arrives, the run silently takes the fallback, and the webhook
  half of your code is exercised by nothing. `PUBLIC_URL=https://<your tunnel>
  pnpm dev` is what makes it reachable. Until you set it, treat local runs as
  coverage of the backstop only.

### Testing a workflow body

Steps are ordinary exported functions, so a spec imports and calls them. The
BODY needs an engine, and there are two, for two different questions.

**"What did the body ask for?"** — `createWorkflowCtx` from
`@alexkroman1/aai/testing`. It runs the steps and records the names, the retry
policies and the sleeps, over one walk with no journal. Nothing replays, so a
spec built on it must not claim to test durability.

```ts no-check
import { createWorkflowCtx } from "@alexkroman1/aai/testing";

const ctx = createWorkflowCtx({ runSteps: false });
await digestFlow({ url: "https://example.com/a" }, ctx);

expect(ctx.steps.map((s) => s.name)).toEqual(["fetchArticle", "summarize", "file"]);
expect(ctx.steps.find((s) => s.name === "summarize")?.maxAttempts).toBe(6);
expect(ctx.slept).toEqual([{ until: 10_000 }]);
```

**"Is the run actually durable?"** — `runWorkflow` from
`@alexkroman1/aai-runtime/testing`. It starts the declared workflow on the real
replay engine over an in-memory journal, one delivery at a time, with a
suspension RECORDED rather than waited out. So a body that sleeps six hours
costs a spec nothing, and the run really suspends, really resumes off its
journal, and really survives a restart.

```ts no-check
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
import { digest } from "./agent.ts";

// Parks on the wait instead of blocking, with the work before it journaled.
const run = await runWorkflow(digest, { url: "https://example.com/a" }, {
  name: "digest",
});
expect(run.status).toBe("running");
expect(run.wakeAt).toBeGreaterThan(Date.now());
expect(run.steps.map((s) => s.name)).toEqual(["fetchArticle", "summarize"]);

// Ends the wait the way `ctx.workflows.wakeUp` does, and the body continues.
await run.advanceSleep();
expect(run.status).toBe("completed");
expect(run.deliveries).toBe(2);
```

Three more things it can do, each the thing a durable body is written for:

- `run.signal(token, payload)` answers a `ctx.waitFor`, so an approval gate is
  testable without a second process.
- `{ crashAt: "summarize" }` kills the first delivery that reaches that step,
  before its body runs — a worker that died mid-run. `await run.restart()` then
  boots a fresh engine over the same journal, and only the step that never
  settled runs again.
- `{ journal }` shares one store between runs, so a spec can assert what a
  second run sees.

Stub the steps' collaborators at the seams they really use — a step's HTTP goes
through the published `stepFetch` slot, so a model call and a page fetch are BOTH
answered there. `stubGatewayRoute` composes the two:

```ts no-check
import { stubGatewayRoute } from "@alexkroman1/aai/testing";
import { installStubStepFetch } from "@alexkroman1/aai/testing/vitest";

const model = stubGatewayRoute('{"headline":"H","points":["a"]}');
installStubStepFetch((request) => model.route(request) ?? { body: PAGE_HTML });
```

### A step's env, and calling a model from one

A step has no `ctx`, so the two things tool code takes for granted come from
`@alexkroman1/aai/step` instead. Import them from THERE and not from
`@alexkroman1/aai` — a `workflows/*.ts` module is bundled separately, and the
root barrel would drag the whole SDK into that bundle.

```ts
import { stepEnv } from "@alexkroman1/aai/step";
import { stepGenerateClassified } from "@alexkroman1/aai/step-errors";

async function summarize(text: string) {
  // The agent's env by name — the same values a tool reads from `ctx.env`.
  // `requireStepEnv` fails naming the key; `stepEnv` returns undefined.
  const style = stepEnv("DIGEST_STYLE") ?? "plain";

  // One model call, on the agent's own ASSEMBLYAI_API_KEY and default model.
  return await stepGenerateClassified(`${style} summary of:\n\n${text}`, {
    system: "Reply with two sentences and nothing else.",
  });
}
```

Two things to know. **The env is what `.env` and `aai secret put` declare** —
not your shell, even under `aai dev`, so that a step reads the same values
before and after a deploy. List what you read in `requiredEnv` and a deploy
checks it for you. And **`stepGenerate` is not `ctx.generate`**: it is one
request to the AssemblyAI LLM Gateway, with no tools and no structured output,
because bundling the AI SDK into a step artifact costs megabytes on every
deploy. Use `stepGenerateJsonClassified` with a Zod `schema` if you need a shape.

### From a step, reach for the `Classified` call

`@alexkroman1/aai/step-errors` publishes a wrapper for every `/step` call that
can fail against a remote service, and **inside a step the wrapper is the one to
use**:

| Raw, on `@alexkroman1/aai/step` | Use this instead, on `@alexkroman1/aai/step-errors` |
| --- | --- |
| `stepGenerate` | `stepGenerateClassified` |
| `stepGenerateJson` | `stepGenerateJsonClassified` |
| `stepFetch` | `stepFetchOk` |
| `stepTranscribeSync` | `stepTranscribeSyncClassified` |
| `stepTranscribeUpload` / `Submit` / `Poll` | the matching `*Classified` |
| `sendToChannel` (`/channels`) | `sendToChannelClassified` |

`stepFetchOk` is the one that is not spelled `*Classified`, and the name is the
difference: the others turn an already-thrown failure into a classified one,
while this also turns a NON-2XX RESPONSE into a throw — `stepFetch` resolves
with a `404` rather than raising it. Two changes, so two names.

The whole of what a wrapper adds is `throwStepError`, and that is worth having
because the engine's retry policy is decided by WHICH error a step throws. Raw,
every failure looks the same to it: a bad API key is retried until the attempts
run out, and a rate limit backs off for the engine's default one second while
the delay the gateway itself named sits unread on the error. Classified, a
terminal failure raises `FatalError` and stops, and a transient one raises
`RetryableError` carrying the far side's own `Retry-After`. That matters most
where this SDK encourages a fan-out, because N steps hit a rate limit together
and a second later all N ask again.

**Reach for the raw call when the failure is not simply a failure** — a `404`
that means "already deleted", a `4xx` whose body decides which advice to print.
Then classify it yourself: `throwStepError(err)`, `throwFatalStepError(err)` to
stop outright, `toStepError(cause, message)` to build the error without throwing,
or `throwFfmpegStepError(err)` for a media failure, whose default runs the other
way (only a `timeout` or an `aborted` is worth another attempt).

**Why the split exists, since the wrapper is what you usually want:** this is
importing from here is the OPT-IN, and `/step` is not written only for a step —
`mapConcurrent` bounds a rate-limited call anywhere, `stepFetch` is an ordinary
HTTP client, and your specs drive exported steps directly. None of those callers
has a retry budget to burn, so none should meet a vocabulary whose whole subject
is one. A step pays nothing for the extra import line.

### Media, big files, and transcription from a step

Three more subpaths a `workflows/*.ts` module can reach, all with the same
bundling rule as `/step` — import them there, never through the root barrel:

- **`@alexkroman1/aai/step`** — `stepTranscribeSync(bytes)` for a short
  recording, or `stepTranscribeUpload` → `stepTranscribeSubmit` →
  `stepTranscribePoll` for a long one, plus `Transcript`, `TranscribeError` and
  the `TRANSCRIBE_*` limits. (There is no `/transcribe` subpath; transcription
  lives on `/step` with the other step primitives.) Use the `Classified`
  wrappers above: a provider refusal — a container it will not read, a
  recording with no speech — arrives
  with `retryable: false`, and unclassified a step re-uploads the same bytes
  until its attempts run out.
- **`@alexkroman1/aai/ffmpeg`** — `transcodeToWav(bytes, { sampleRate })`,
  `runFfmpeg(args)`, `probeMedia(source)` for duration and stream info, and
  `FfmpegError`/`isFfmpegError`. Under `aai dev` it needs ffmpeg on your PATH;
  a `missing-binary` failure says so and carries the install line.
- **`@alexkroman1/aai/step-files`** — for a recording too big to hold in memory.
  `readUploadToFile(uploadId, path)` streams an upload to disk,
  `writeUploadFromFile(path)` streams one back, and `withTempDir(work)` gives
  both a directory that is cleaned up even when the step throws.

```ts no-check
import { probeMedia, runFfmpeg } from "@alexkroman1/aai/ffmpeg";
import { throwFfmpegStepError } from "@alexkroman1/aai/step-errors";
import { readUploadToFile, withTempDir } from "@alexkroman1/aai/step-files";

export async function measure(uploadId: string) {
  return await withTempDir(async (dir) => {
    const path = `${dir}/input`;
    // Read the upload ONCE. A five-step version reads it five times, and on a
    // 700 MB recording that is the expensive part by an order of magnitude.
    await readUploadToFile(uploadId, path);
    const media = await probeMedia(path).catch(throwFfmpegStepError);
    return { durationMs: media.durationMs };
  });
}
```

`call-audit` is the worked example for all three at once.

### Posting somewhere — `@alexkroman1/aai/channels`

A run that finishes while nobody is on the line needs somewhere to put the
result. `slackChannel({ webhookUrl })` names a destination and
`sendToChannelClassified(channel, message)` posts to it:

```ts no-check
import { type ChannelMessage, slackChannel } from "@alexkroman1/aai/channels";
import { requireStepEnv } from "@alexkroman1/aai/step";
import { sendToChannelClassified } from "@alexkroman1/aai/step-errors";

export async function announce(headline: string, points: string[]) {
  const message: ChannelMessage = {
    text: headline,
    sections: points.map((point) => ({ text: point })),
  };
  return await sendToChannelClassified(slackChannel({ webhookUrl: requireStepEnv("SLACK_WEBHOOK_URL") }), message);
}
```

The webhook URL is a secret like any other — declare it in `requiredEnv` and set
it with `aai secret put`. A channel's credential is its DESTINATION and is
passed in, which is why no channel reads an env var of its own. `ChannelMessage`
is rendered per platform, so the same message is legal on a channel kind added
later; `isSlackWebhookUrl` / `isSlackWorkflowTriggerUrl` validate a pasted URL
before a run depends on it, and `explainChannelFailure` turns a refusal into a sentence
a person can act on. `podcast-digest` is the worked example.

### A step's HTTP: use `stepFetch`, not `fetch`

Any outbound request from a step goes through `stepFetch` (also
`@alexkroman1/aai/step`). It is not a style preference — `fetch` is the wrong
call to make from a step, for a reason nothing at the call site shows:

```ts no-check
import { multipartBody, stepFetch, StepTransportError } from "@alexkroman1/aai/step";

async function transcribeChunk(key: string, bytes: Uint8Array, index: number) {
  // Multipart as BYTES. Never a `FormData` — see below.
  const part = multipartBody({
    name: "audio",
    filename: `chunk-${index}.wav`,
    type: "audio/wav",
    bytes,
  });

  const response = await stepFetch("https://sync.assemblyai.com/transcribe", {
    method: "POST",
    headers: { Authorization: key, ...part.headers },
    body: part.body,
    // Nothing here has a deadline of its own, and a hung request inside a step
    // is a run that never finishes rather than one that retries.
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw stepFailure(response);
  return await response.json();
}
```

**`fetch` speaks HTTP/2, and a fan-out is the worst case for that.** Node's
global `fetch` offers `h2` in ALPN and the far side decides; a server that takes
it gets every concurrent request from your process multiplexed onto ONE TCP
connection, sharing one flow-control window. That is fine for small JSON calls
and pathological for `mapConcurrent` over large bodies. Measured on 8 concurrent
17.66 MB uploads: `fetch` landed 14 of 16 at p50 8094ms, HTTP/1.1 landed 16 of
16 at p50 3037ms.

**And the two it lost are the reason this matters more than the latency.** On
HTTP/2 a capacity limit arrives as a *stream reset* — `NGHTTP2_ENHANCE_YOUR_CALM`
— and a stream error carries no HTTP status, so `isTransientStatus` and
`retryAfter` cannot see it. Every sibling in the batch then retries in lockstep
into the same reset, exhausts the step's attempts, and fails the run with
`TypeError: fetch failed`, whose real cause is two `cause` hops down where
nothing prints it. Over HTTP/1.1 the identical limit arrives as `503` with
`retry-after`, which your retry policy already reads.

Three rules come with it:

- **Bodies are BYTES or a string.** Never hand a `FormData`, `Blob`, `File`,
  `Headers` or `Request` to a step's fetch: those are branded objects, checked
  against the classes of whichever undici the fetch came from, and a foreign one
  is silently stringified — `Content-Type: text/plain` with the 17-byte body
  `[object FormData]`, answered `415`. `multipartBody()` is how a file becomes
  bytes.
- **A connection failure is a `StepTransportError`**, distinct from a response
  with a bad status because only the first is unclassifiable. It names its whole
  `cause` chain, and `err.codes` is what to branch on (`ECONNRESET`,
  `ETIMEDOUT`, …).
- **Test it with `stubStepFetch`** (`@alexkroman1/aai/testing`), not
  `vi.stubGlobal("fetch", …)`. The global stub passes — an unpublished slot falls
  back to it — while asserting a path production does not take, and it cannot see
  the request body as bytes.

`stepGenerate` already goes through this, so a step that only calls a model gets
it for free.

### A step can SPEAK, and store the file it made

A workflow whose answer is a FILE — a summary read aloud, a rendered image, a
generated PDF — needs two things a first draft reaches for and does not find.
Both are on `@alexkroman1/aai/step`, and `spoken-summary` is the template that
shows the whole round trip.

```ts
import { stepSpeak, writeUpload } from "@alexkroman1/aai/step";

export async function narrate(script: string) {
  const spoken = await stepSpeak(script, { voice: "jane" });
  const stored = await writeUpload(spoken.audio, { name: "summary.wav", type: "audio/wav" });
  return { audio: stored.id, durationMs: spoken.durationMs };
}
```

**`stepSpeak` is `stepGenerate` for the voice.** A step is handed no
`ToolContext`, so the provider stack your `agent()` declares is not in scope —
and the session TTS surface would not help anyway: it is an event stream wired
into a live pipeline's playback, and a step has no turn to be part of and has to
return a value. So this is the smaller thing: text in, the whole utterance out
as a WAV, on the same `ASSEMBLYAI_API_KEY` everything else uses. Voices come
from `ASSEMBLYAI_TTS_VOICES` (`@alexkroman1/aai`, or `/tts`) — read that list
rather than typing an id, because a wrong one is refused *after* the socket
opens and produces silence rather than an error. The `AssemblyAITtsVoice` type
gives you autocomplete over it and nothing more: it accepts any string, so that
a voice the service adds after this release still compiles.

**`writeUpload` is `readUpload`'s other direction, and you need it.** A run's
output is read back as JSON, so audio cannot travel in one — the same rule that
keeps an uploaded recording's bytes out of a run's INPUT, arriving at the other
end of the run. Store the bytes, return the **id**, and let the page fetch it
with `api.download(id)`.

Three rules come with it:

- **Speak and store in ONE step.** A step is journaled by its return value, so
  an id is replayed on a resume and bytes are not. Split in two, the audio
  crosses the queue between them every time the run resumes.
- **A retried step writes a SECOND upload** and abandons the first — the store
  cannot know two calls meant one file. That is the price of the step being
  retryable at all, and it is the right trade.
- **Name and TYPE what you store.** The byte route serves the `type` it was
  given, and a browser will not play inline a file it was handed as
  `application/octet-stream`.

On the page, `api.download(id)` answers a `Blob`, not a URL — the byte route
takes the same bearer every other route does, and neither `<audio src>` nor
`<a href>` can send one, so a page built on a URL works in `aai dev` and 401s
once the agent has a token. `URL.createObjectURL(blob)` is what those elements
take; revoke it when the id changes.

Test both with `stubSpeech()` and `stubUploads(files, { writable: true })`
(`@alexkroman1/aai/testing`). The write half is opt-in on purpose: a store that
silently accepted writes could not fail a spec whose step stored a file nobody
meant it to.

### A builtin's failure is its RESULT, so narrow it

`webSearch`, `visitWebpage` and `fetchJson` (`@alexkroman1/aai/tools`) answer
`T | ToolFailure` — they do not throw on an HTTP failure, a bot challenge or an
oversized body, because a tool usually wants to hand the model something useful
rather than fail the turn:

```ts no-check
import { webSearch } from "@alexkroman1/aai/tools";
import { isToolFailure } from "@alexkroman1/aai/utils";

const found = await webSearch<{ results?: { url?: string }[] }>({ query, maxResults: 4 });
// NOT `(found.results ?? [])` — a REFUSED search would then read as an empty web.
if (isToolFailure(found)) return `That search failed: ${found.error}`;
return (found.results ?? []).map((one) => one.url);
```

**`?? []` is the mistake, and it is a quiet one.** Both shipped templates that
search wrote it, and one of them had a `catch` for this exact failure — which
never ran, because a `catch` cannot see a returned value. DuckDuckGo refuses
often enough that the empty answer is routine, and to the model "no results" and
"the search was blocked" are different facts: told the first, it concludes the
pages do not exist and tries again with different words until its budget is gone.

An UNTYPED call (`await fetchJson(url)`) stays loose and needs no narrowing —
naming a shape is what asks the compiler to make you handle the failure.

### The page

A workflow app's `client.tsx` mounts with `page()` rather than `client()` —
there is no session to build, so no socket, no audio graph and no microphone
request. Everything else is the same file, React and Tailwind included.

```tsx no-check
import { createWorkflowApi, page, useWorkflowRun } from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";
import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import { useState } from "react";
import type { digest } from "./agent.ts";

// Hoisted: a client built in render is a new object every render.
const api = createWorkflowApi();

export function App() {
  const [runId, setRunId] = useState<string>();
  // The generic is what makes `run.output` typed rather than `unknown`.
  const { run, polling } = useWorkflowRun<WorkflowOutputOf<typeof digest>>(runId, { api });

  return (
    <main>
      <button
        type="button"
        onClick={async () => setRunId(await api.start("digest", { url: "https://example.com" }))}
      >
        Digest
      </button>
      {polling && <p>Working. You can close this tab — the run continues.</p>}
      {run?.status === "completed" && <h2>{run.output.headline}</h2>}
    </main>
  );
}

page({ name: "Link Digest", component: App });
```

`api.start()` resolves as soon as the RUN EXISTS, not when it finishes — that
is the whole mechanism. The `runId` is the entire client state, so it survives
a reload, a different device, or `curl`. Note the workflow is named by the key
it has in `workflows` above (`"digest"`); nothing else records that string, so
a rename there is a 400 here rather than a compile error.

The same routes are scriptable, which is the other half of having an API:

```text
GET    /workflows                 → the declared workflows, with input schemas
POST   /workflows/runs            → { runId }   body: { workflow, input?, key?, wait? }
GET    /workflows/runs/:id        → a run snapshot
DELETE /workflows/runs/:id        → cancel
GET    /workflows/runs/:id/events → SSE
```

## Pipeline mode

Pipeline mode is the default: omitting `stt`/`llm`/`tts` (and `s2s`) gives
you the all-AssemblyAI pipeline, and any stage you do declare replaces just
that stage — the rest keep the default.

**S2S mode is an explicit opt-in.** Setting `s2s: assemblyAIS2s()` (imported
from `@alexkroman1/aai`, next to `agent()`) selects AssemblyAI's
speech-to-speech Voice Agent API: STT, the LLM loop, and TTS run
service-side in one socket. Fewer moving parts, but you cannot choose the
model or swap a provider. There is no way to reach S2S by omission — only
the `s2s` field selects it, and it is mutually exclusive with the
`stt`/`llm`/`tts` triple.

```ts
import { agent, assemblyAIS2s } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  s2s: assemblyAIS2s(),
});
```

The descriptor takes three optional knobs, all forwarded only when set:

```ts
import { agent, assemblyAIS2s } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  sttPrompt: "Callers spell order numbers one character at a time.",
  s2s: assemblyAIS2s({
    voice: "michael",
    languages: ["en"],
    keyterms: ["Acme Rewards", "SKU"],
  }),
});
```

- `voice` — the agent's voice. Unset uses the service default.
- `languages` — **leave it unset for multilingual calls**: unset means
  "detect per turn", so pinning `["en"]` on a line that takes other
  languages disables detection for every caller. Pin it when the line
  really is monolingual — on a benchmark run that plus a transcription
  prompt took a caller's spelled first name from 1 of 6 attempts correct
  to 6 of 6.
- `keyterms` — product names and proper nouns to bias transcription
  toward. Use `sttPrompt` (above, and honoured in **both** modes) for
  prose guidance and `keyterms` for a term list.

**Prefer pipeline mode** — the default — unless the user specifically
asks for the speech-to-speech API. Nearly every template ships this way, and
it is what AssemblyAI Build defaults to. The host runs the LLM loop locally
(Vercel AI SDK) with your chosen STT, LLM, and TTS. You want explicit
providers when:

- you want a specific LLM (Anthropic, OpenAI, Gemini, Mistral, xAI, Groq,
  hundreds of models via OpenRouter, or 25+ models via the AssemblyAI
  LLM Gateway)
- you want a specific STT model, or a non-AssemblyAI TTS provider (for the
  default pipeline's voice, use the `voice` field instead)
- you need to swap providers without changing agent code

**The rule:** declare only the stages you're changing — any subset of
`stt`, `llm`, `tts`; each unset stage runs on the AssemblyAI default.
Combining `s2s` with any pipeline provider or pipeline-only tuning field is
a compile error naming the rule, as is `voice` alongside an explicit `tts`
descriptor (the descriptor owns its own voice). A raw config that skips
`agent()` is still checked at parse time.

```ts
import { agent } from "@alexkroman1/aai";
import { assemblyAIStt } from "@alexkroman1/aai/stt";
import { anthropicLlm } from "@alexkroman1/aai/llm";
import { cartesiaTts } from "@alexkroman1/aai/tts";

export default agent({
  name: "My Agent",
  stt: assemblyAIStt({ model: "universal-3-5-pro" }),
  llm: anthropicLlm({ model: "claude-haiku-4-5" }),
  tts: cartesiaTts(),
});
```

Tools, the database, `ctx`, and the UI all behave identically across modes.
Only the audio + LLM transport differs.

**Four front doors, each one field on `agent()`.** Omit them all for PIPELINE
(voice, cascaded STT → LLM → TTS) — the default, and the mode this guide
assumes. `s2s:` selects speech-to-speech. **`text: true` selects a text-only
agent**: no STT, no TTS, `llm` is the one stage, and the host runs it with
`createTextAgent` from `@alexkroman1/aai-runtime`. `workflowApp()` (see
"Workflow apps") builds a form with no session at all. Setting a field from the
wrong arm is a compile error naming the rule, so the modes cannot be mixed by
accident. Every pipeline agent must declare a real TTS provider — that is a
statement about pipeline mode, not about the SDK.

### Answering a phone call

A deployed voice agent already serves carrier media streams — there is nothing
to switch on. `createServer` mounts `WS /phone` whenever the agent is a voice
agent (`telephony` defaults to `true`, and to `false` for a `page: "static"`
workflow app, which has no stages to put on a call). Point the carrier at it
with a `carrier` query parameter naming who is dialling:

```text
wss://<your-agent-url>/phone?carrier=twilio
wss://<your-agent-url>/phone?carrier=telnyx
```

Twilio and Telnyx are the two carriers this build decodes (`CARRIER_CODECS`);
an unknown `carrier` is declined at the upgrade. Both speak 8 kHz mu-law, which
the bridge transcodes in both directions, so the agent, its tools and its slots
behave exactly as they do in the browser — a phone call is a transport, not a
mode. Nothing about `agent.ts` changes to support one.

Turn the route off with `telephony: false` on `createServer`. If you are
embedding the runtime yourself rather than deploying, the pieces are
`createTelephonyBridge`, `startTelephonySession`, `TELEPHONY_PATH` and
`carrierByName`, all on `@alexkroman1/aai-runtime`.

**Silence nudge (pipeline only):** set `silenceTimeoutMs` to make the
assistant proactively take a turn after that much user silence (e.g.
"Are you still there?"). Customize the injected instruction with
`silencePrompt`. The nudge never appears as a user transcript, and the
assistant stops nudging after 3 consecutive unanswered nudges until the
user speaks again.

**Voice-UX tuning (pipeline only):** `minBargeInWords` controls how many
words of user speech interrupt the assistant mid-reply (default 2, so
one-word backchannels like "yeah" don't cut it off);
`interruptionMinDurationMs` adds a sustained-speech gate on top (default
500 ms; `0` disables; interim transcripts only — committed turns always
land). End-of-turn detection (how long a pause ends the user's turn)
belongs to the STT provider: `assemblyAIStt({ minTurnSilenceMs })` (default
1600 ms) / `deepgramStt({ endpointing })` (default 1500 ms), so mid-utterance
pauses don't split a request.
`deadAirCoverMs` is how long a turn may go silent before the transport speaks
a short filler, so a long tool chain doesn't sound like a dropped call. It is
measured silence, not a guess about the turn's shape, so a reply that arrives
promptly pays nothing; `0` disables it. The wording is not yours to set — the
filler must be purely declarative and never a request for patience, or the
caller answers it and the answer barges in.
`resumeFalseInterruption` (default `true`) resumes an interrupted reply when
a barge-in turns out to be noise — no user turn ever commits. The wait is not
configurable: the resume fires once the transcript stream goes quiet with no
final, so it can never race a real turn the STT is still endpointing.
`preemptiveGeneration` (default **`false`**) starts generating the reply as
soon as transcription is confident the caller has finished, and uses that
already-running answer if the committed transcript matches. It can shorten the
pause before the agent speaks, and it is off by default because the measurement
came back negative: over a tau2-bench retail run, 16 speculations started, 14
were adopted at a p50 head start of 0.44s, and 5 of those 14 (36%) were poisoned
after adoption by a tool call — discarded whole, each having burned p50 0.69s
first. Net **+8ms per caller turn**, for 44% of its LLM requests thrown away.
What bounds the downside either way is that a speculation never speaks, calls a
tool, or enters history until the real turn adopts it, so the worst case is a
wasted request and a turn that behaves exactly as it would with the flag off.
Set `preemptiveGeneration: true` to opt in — worth trying on a text-heavy agent,
since 36% poisoned is a tool-calling agent's number, and pointless on a
tool-heavy one, where a speculation that reaches a tool call is thrown away.

## Providers

Provider SDKs are **optional peer dependencies**. Install only the SDKs
for the providers you actually use.

### STT — `@alexkroman1/aai/stt`

| Factory         | Default model          | Env var              |
| --------------- | ---------------------- | -------------------- |
| `assemblyAIStt` | `"universal-3-5-pro"`  | `ASSEMBLYAI_API_KEY` |
| `deepgramStt`   | `"nova-3"`             | `DEEPGRAM_API_KEY`   |
| `elevenLabsStt` | `"scribe_v2_realtime"` | `ELEVENLABS_API_KEY` |
| `sonioxStt`     | `"stt-rt-v3"`          | `SONIOX_API_KEY`     |

All STT factories accept `{ model?: string, ... }`. Bare calls
(`deepgramStt()`, `sonioxStt()`, etc.) use the default model. Language is spelled
`language` where the vendor takes one code (`deepgramStt`, `elevenLabsStt`) and
`languages` where it takes a list (`assemblyAIStt`, `sonioxStt`) — and only
`deepgramStt`'s unset value means English; the other three auto-detect.

`elevenLabsStt` carries the stage in its name because ElevenLabs is
better known for TTS: when that stage arrives, `elevenLabs` is the name it
should get.

`assemblyAIStt` accepts an optional `region: "eu"` for EU data residency —
it routes streaming transcription to AssemblyAI's EU endpoints. EU-region
API keys require it; the US endpoints reject them. Example:
`assemblyAIStt({ model: "universal-3-5-pro", region: "eu" })`.

### LLM — `@alexkroman1/aai/llm`

| Factory         | SDK package         | Env var                        |
| --------------- | ------------------- | ------------------------------ |
| `anthropicLlm`  | `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY`            |
| `openAILlm`     | `@ai-sdk/openai`    | `OPENAI_API_KEY`               |
| `googleLlm`     | `@ai-sdk/google`    | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `mistralLlm`    | `@ai-sdk/mistral`   | `MISTRAL_API_KEY`              |
| `xAILlm`        | `@ai-sdk/xai`       | `XAI_API_KEY`                  |
| `groqLlm`       | `@ai-sdk/groq`      | `GROQ_API_KEY`                 |
| `openRouterLlm` | `@ai-sdk/openai`    | `OPENROUTER_API_KEY`           |
| `gatewayLlm`    | `ai` (built in)     | `AI_GATEWAY_API_KEY`           |
| `assemblyAILlm` | `@ai-sdk/openai`    | `ASSEMBLYAI_API_KEY`           |

LLM factories require `{ model: string }` — the `ModelOptions` interface,
shared by all of them except `assemblyAILlm`. Example:
`anthropicLlm({ model: "claude-haiku-4-5" })`. The argument is required
because a third-party vendor's catalog is not this SDK's to default from;
`assemblyAILlm()` is the one bare call, since it has a default model.

`openRouterLlm` routes through [OpenRouter](https://openrouter.ai) — an
OpenAI-compatible endpoint fronting hundreds of models addressed as
`"creator/model"`, e.g.
`openRouterLlm({ model: "meta-llama/llama-3.3-70b-instruct" })`. It needs
no extra SDK install (it reuses the `@ai-sdk/openai` client).

`gatewayLlm` routes through the [Vercel AI
Gateway](https://vercel.com/docs/ai-gateway) — one endpoint fronting
hundreds of models addressed as `"creator/model"`, e.g.
`gatewayLlm({ model: "zai/glm-4.6" })`. It needs no extra SDK install
(the gateway client ships inside the `ai` package).

`assemblyAILlm` routes through the [AssemblyAI LLM
Gateway](https://www.assemblyai.com/docs/llm-gateway) — an
OpenAI-compatible endpoint fronting 25+ models (Claude, GPT, Gemini,
etc.) with the same API key as AssemblyAI STT. A bare model-id string on
`llm` is shorthand for it, and unset stages keep the AssemblyAI default:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  llm: "claude-sonnet-4-6",
});
```

`assemblyAILlm({ model, region: "eu" })` is the explicit form; `region`
selects EU data residency.

Mixing providers works the same way — declare the stages you're changing:

```ts
import { agent } from "@alexkroman1/aai";
import { cartesiaTts } from "@alexkroman1/aai/tts";

export default agent({
  name: "My Agent",
  llm: "claude-sonnet-4-6",
  tts: cartesiaTts(),
});
```

### TTS — `@alexkroman1/aai/tts`

| Factory         | Default voice                            | Env var              |
| --------------- | ---------------------------------------- | -------------------- |
| `assemblyAITts` | `"jane"`                                 | `ASSEMBLYAI_API_KEY` |
| `cartesiaTts`   | `"f786b574-daa5-4673-aa0c-cbe3e8534c02"` | `CARTESIA_API_KEY`   |
| `rimeTts`       | `"cove"` (model `mistv2`)                | `RIME_API_KEY`       |

Bare calls (`assemblyAITts()`, `cartesiaTts()`, `rimeTts()`) use the defaults.
Override with `{ voice, model, language }`.

**AssemblyAI TTS** shares `ASSEMBLYAI_API_KEY` with AssemblyAI STT and the
LLM Gateway, so an all-AssemblyAI pipeline needs exactly one secret. On the
default pipeline, `agent({ voice: "michael" })` is the shorthand for
`tts: assemblyAITts({ voice: "michael" })` — same catalog, same rules. Each
voice speaks one language, and this is the whole catalog — **a voice not on
this list is rejected after the socket opens, which leaves the agent
connected, "ready", and permanently silent**, so pick one from here rather
than guessing a plausible name:

- **English, US accent**: `alba`, `anna`, `charles`, `eve`, `george`,
  `jane` (the default), `jean`, `mary`, `michael`
- **English, UK accent**: `paul`, `vera`
- **Native accent, code-switches with English**: `estelle` (fr),
  `giovanni` (it), `juergen` (de), `lola` (es), `rafael` (pt)

There is no separate age/gender/style axis — match the persona by picking a
name and accent, and put the delivery in the system prompt instead.

Set
`language` only alongside a voice that speaks it, as an ISO 639-1 code —
`"en"`, `"fr"`, `"de"`, `"it"`, `"pt"`, `"es"` are the six the catalog
covers, and the SDK translates each to the full name the service wants.
An unsupported code, and a code the declared voice does not speak, are both
build errors naming the voices that do speak it — including the one you get by
setting `language` alone, since the descriptor then fills in the default
English voice. (A voice this release's catalog does not list is passed through:
the catalog is the service's, so a voice it ships later still works.)

**Rime quirk:** language uses ISO 639-3 three-letter codes (e.g. `"eng"`
not `"en"`).

Set provider keys the same way as any secret: `.env` for local dev,
`aai secret put` for production.

## `tool()` API

```ts no-check
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

const myTool = tool({
  description: string;           // shown to LLM — decides when to call
  inputSchema?: z.ZodObject;     // Zod schema (omit for no-arg tools)
  execute(args, ctx): unknown;   // sync or async
});
```

`execute` may call `fetch` directly — tool code reaches external APIs the
same way in `aai dev` and deployed.

### `ctx` (ToolContext)

```ts no-check
ctx.env: Readonly<Partial<Record<string, string>>> // secrets from .env / aai secret put.
                                               // Partial: every read is `string | undefined`.
                                               // Use requireEnv(ctx, "KEY") to fail by NAME
                                               // instead of throwing a TypeError at the model.
ctx.workflows: WorkflowClient                  // start / signal / wake / find / stream a durable run
                                               // from a tool (see "Workflows")
ctx.slots: SlotStore                           // where sessionSlot() keeps this session's state —
                                               // reach for the slot, never this (see "Session state")
ctx.messages: readonly Message[]               // conversation history [{role, content}]
ctx.sessionId: string                          // unique session ID
ctx.send(event: string, data: unknown): void   // push custom event to browser client (silently dropped over 64 KB JSON)
ctx.generate(opts): Promise<{ text, object? }> // one-shot LLM call (host-side)
                                               // with a `schema`, `object` is REQUIRED and typed by it
ctx.delegate(sub, opts): Promise<DelegateResult> // run a subagent — a whole tool loop with its own
                                               // context window (see "Subagents")
ctx.signal: AbortSignal                        // aborts on barge-in, reset, session stop, or this call's timeout
```

**Pass `ctx.signal` to anything slow.** It is always present — no `?.`
needed — and forwarding it is what makes a tool stop work the caller has
already interrupted:

```ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export const lookup = tool({
  description: "Look up an order",
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }, ctx) => {
    const res = await fetch(`https://api.example.com/orders/${id}`, {
      signal: ctx.signal,
    });
    return await res.json();
  },
});
```

**Write the code first; let inference do the work.** The project runs `strict`,
so a variable declared empty and filled in the same scope widens from what you
put in it — `const items = []` followed by `items.push(pick)` infers `Pick[]`
with no annotation. Do NOT add type annotations defensively.

**Annotate the DECLARATION when the first write is somewhere the compiler
cannot follow** — inside a callback, or after the value has already been read.
The widening only tracks straight-line code in one scope, so in those cases the
declaration keeps its starting type:

```ts no-check
const items = [];                      // stays never[] if the only push is in a callback
let best = null;                       // stays null if the only assignment is in a callback
const [picks, set] = useState([]);     // never[] — useState's argument is read immediately

const items: Pick[] = [];              // ✅ annotate the DECLARATION
let best: Pick | null = null;          // ✅
const [picks, set] = useState<Pick[]>([]);  // ✅
```

Annotating the *use* instead does not help — the declaration is still wrong,
so the next push reports the next line, and you can burn a whole session
fixing one call site at a time.

### Session state

**A `sessionSlot` is the only way to keep state across a session's tool calls**,
and it is one declaration in a shared module:

```ts
// shared.ts — the one place the shape is written down.
import { sessionSlot } from "@alexkroman1/aai";

export type Incident = { id: string; status: "open" | "closed" };

export const incidentSlot = sessionSlot("incidents", () => ({ items: [] as Incident[] }));
```

```ts no-check
// tools/list_open.ts — `slot.tool` READS: the body is handed the value, typed.
import { incidentSlot } from "../shared.ts";

export default incidentSlot.tool({
  description: "List open incidents",
  // `i` infers as Incident, and `i.staus` would now be an error.
  execute: (_args, incidents) => incidents.items.filter((i) => i.status === "open"),
});
```

```ts no-check
// tools/open_incident.ts — `slot.updateTool` WRITES: mutate what you are handed.
import { incidentSlot } from "../shared.ts";
import { z } from "zod";

export default incidentSlot.updateTool({
  description: "Open an incident",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }, incidents) => {
    incidents.items.push({ id, status: "open" });
    return { open: incidents.items.length };
  },
});
```

Four rules, and each is an error rather than advice if you get it wrong:

- **`tool` reads, `updateTool` writes.** What a read is handed is FROZEN, so
  mutating it throws instead of quietly going nowhere.
- **A write is SYNCHRONOUS.** The value you mutate is stored the moment your body
  returns, so an `updateTool` body may not `await`. When you need a model call or
  a fetch first, do it in an ordinary `tool()` and then mutate:

  ```ts no-check
  execute: async (args, ctx) => {
    const priced = await ctx.generate({ prompt: `price ${args.sku}` });
    return cartSlot.update(ctx, (cart) => {
      cart.total = Number(priced.text);
      return { total: cart.total };
    });
  }
  ```

- **Hold plain data.** Objects, arrays, strings, numbers, booleans and null. A
  `Map`, a `Set`, a `Date` or a class instance is refused with the field named,
  because none of them survives being stored.
- **State is STORED on the platform**, so a crash or a redeploy no longer loses
  it — the platform keeps a session's slots on its own database and there is
  nothing to enable. Under `aai dev` it lives in memory for the life of the
  process unless you set a `DATABASE_URL` in `.env`. You write the same code
  either way; that is the reason for the rules above.

There is nothing to declare on `agent()` — the slot owns its own default. Use
`syncState: slot.projection(view)` to show state to a custom client.

**`verbatimModuleSyntax` applies to every type you import** — `ToolContext`,
`ToolDef`, `Message`, provider types. A plain
`import { ToolContext }` fails; use `import type { ToolContext }`, or
`import { agent, type ToolContext }` to combine with value imports.

`ctx.generate({ prompt, system?, llm?, schema?, temperature?, maxOutputTokens? })`
runs one LLM generation on the host. It defaults to the agent's pipeline
`llm`; pass an `llm` descriptor (from `@alexkroman1/aai/llm`) or a model-id
string to use another provider whose API key is in the agent's secrets —
that's also how S2S agents use it. Pass a Zod schema as `schema` for typed
structured output (`generateObject`-style): the result's `object` carries
the parsed, typed value. A plain JSON Schema object also works.

The option bag is `GenerateOptions` and the answer is `GenerateResult`
(`GenerateObjectResult<T>` with a `schema`), both exported from
`@alexkroman1/aai` — annotate a helper that wraps the call rather than
re-describing the shape. `GenerateFn` is the type of `ctx.generate` itself,
which is what a spec passes to `createToolContext({ generate })`.

### When the NEXT step is the hard part — `dialog()` and `procedure()`

Two declarations for flows, and the difference is who is driving.

**`dialog()` gates what the MODEL may do next.** A prompt asking the agent to
collect an address before taking payment is a suggestion; a dialog is a rule.
`dialog(key, spec)` takes `{ initial, states }`, each state carrying an
`instruction` the agent is given while it is there and an `on` map of the events
that leave it. It is a slot underneath, so the position is persisted with the
rest of the session and survives a reconnect.

```ts
import { dialog } from "@alexkroman1/aai";

export const checkout = dialog("checkout", {
  initial: "collecting",
  states: {
    collecting: {
      instruction: "Take the order. Confirm it back before charging anything.",
      on: { CONFIRMED: "paying" },
    },
    paying: {
      instruction: "Take payment with charge_card. Do not add items now.",
      on: { PAID: "done" },
    },
    done: { instruction: "Read back the order number and say goodbye." },
  },
});
```

A tool declared with `checkout.tool({...})` is REFUSED unless the dialog is in a
state that allows it, and the refusal reaches the model as a `ToolFailure` it
can recover from — the point being that the gate is enforced at EXECUTION
rather than hoped for in a prompt. The states and events are inferred from the
spec, so a misspelled `send` is a compile error. `dispatch-center` and
`solo-rpg` are the worked examples.

**`procedure()` runs a flow YOU drive, with no model in the loop.** Where a
dialog constrains a conversation, a procedure is an algorithm with branches,
retries and a bounded budget — a grading loop, a retrieval-and-check cycle —
expressed as a statechart rather than as a `while` with four early returns:

```ts no-check
import { procedure } from "@alexkroman1/aai";

const answer = procedure(ragMachine);
const result = await answer.run({ question }, { signal: ctx.signal });
```

`run` resolves with the machine's output, or throws `ProcedureNotFinishedError`
if it stops without reaching a final state — which is what makes "we ran out of
attempts" a state you declare and handle rather than an error. Options are
`ProcedureRunOptions`; the machine is an XState machine, and `xstate` is already
an SDK dependency. `support-line` is the worked example.

### Subagents (`ctx.delegate`)

`ctx.generate` is ONE prompt. When answering takes an unknown number of tool
calls whose intermediate results the conversation has no reason to carry,
delegate to a **subagent** instead: a second tool loop with its own system
prompt, model, tools and — the whole point — its own context window.

```ts
import { subagent, tool } from "@alexkroman1/aai";
import { z } from "zod";

const researcher = subagent({
  name: "researcher",
  // `systemPrompt`, the same field name `agent()` uses — a subagent is a
  // field-for-field smaller agent, so nothing about it is spelled differently.
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

Four rules, each of which is how a subagent disappoints when you skip it:

- **Tell it to summarize.** You receive its FINAL message. A subagent that
  signs off with "Done." has thrown away everything it read.
- **Write the task as a complete brief.** Its context is isolated — it has not
  heard the conversation. Anything it needs from the call goes in `task`, or in
  the optional `context` string.
- **Give it a budget.** `maxSteps` (default: the framework's) bounds the loop;
  past it the subagent is asked for its answer with its tools withheld, so a
  capped run still answers. In a voice session the tool timeout bounds the
  whole thing, so keep it small.
- **Say you are looking it up before you call.** A delegated run takes a
  moment, and a silent line is the worst thing on a phone call.

Runs are ordinary promises, so several fan out at once — this is the other
reason to reach for a subagent:

```ts no-check
const runs = await Promise.allSettled(
  angles.map((angle) => ctx.delegate(researcher, { task: angle })),
);
```

A subagent may name its own `llm` (a cheaper model for a narrower job) and its
own `tools` — an explicit map of `tool()` values, which is how you give one
run a strictly smaller surface than the agent has. **Delegation is one level
deep**: a subagent's own tools get a `ctx.delegate` that refuses.

In tests, `stubDelegate` from `@alexkroman1/aai/testing` fakes the capability,
routed by subagent name; `createToolContext()` defaults `delegate` to a
rejection so an unstubbed run cannot reach a real model.

### A tool that calls an API

```ts
// tools/get_weather.ts  →  the model calls this "get_weather"
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Get current weather for a city",
  inputSchema: z.object({
    city: z.string().describe("City name"),
  }),
  async execute({ city }, ctx) {
    const resp = await fetch(
      `https://api.example.com/weather?q=${city}&key=${ctx.env.WEATHER_KEY}`,
    );
    return resp.json();
  },
});
```

Nothing else. `agent.ts` does not import it, does not list it, and takes no
`tools` field at all — see "A file in `tools/` IS a tool" below.

**Calling the network builtins from your own tool code.** `web_search`,
`visit_webpage` and `fetch_json` are declared to the MODEL — the LLM calls
them, and they are not on `ctx`. When your own `execute` needs one, import
it:

```ts no-check
import { fetchJson, visitWebpage, webSearch } from "@alexkroman1/aai/tools";

execute: async ({ city }) => await fetchJson(`https://api.example.com/${city}`),
// Reading fields off the result needs no cast. Pass a shape when you want
// it checked: `await fetchJson<Forecast>(url)`.
```

Same implementations the builtins use, so you get URL screening, credential-
header stripping, size caps and timeouts rather than a bare `fetch`. Plain
`fetch` still works when you want none of that. There is no callable
`run_code`: it exists to run code the model wrote, and tool code that wants
to compute something can just compute it.

**But prefer the BUILTIN when the model should decide.** These two are not
interchangeable:

- If the agent's job is to search or browse — a research assistant, anything
  that follows a link the user mentions — declare
  `builtinTools: ["web_search", "visit_webpage"]` and let the model call
  them. It can then search several times with different queries, or read one
  specific page, as the conversation needs.
- Import from `/tools` when YOUR tool's own logic needs a fetch: a currency
  tool hitting one known API, a price checker with a fixed endpoint.

Wrapping `webSearch` in a single custom tool is the mistake to avoid — it
replaces "the model searches as needed" with one fixed query-and-summarize
pipeline, and no amount of prompting gets the flexibility back.

**`inputSchema` is a Zod object, or absent.** The field itself is
optional, but its VALUE must be a plain `z.object(...)` — so all of these
are type errors:

```ts no-check
inputSchema: z.undefined(),                // ✗ ZodUndefined
inputSchema: z.void(),                     // ✗
inputSchema: z.object({ q: z.string() }).optional(),  // ✗ ZodOptional
```

For a tool with no arguments write `tool({ description, execute })`, or
`inputSchema: z.object({})` if you prefer it explicit. To make an individual
argument optional, put `.optional()` on the FIELD, never on the object:
`z.object({ notes: z.string().optional() })`.

**Do not annotate `execute`'s return type.** Nothing needs it — the result
is serialized to the model either way — and it reliably breaks the moment
the tool also returns an error, because `Promise<DrugInfo>` does not accept
`{ error: "not found" }`. Every such annotation eventually costs a build
round to widen into a union. Let it infer.

### A file in `tools/` IS a tool — there is no registration step

**`tools/` is not a convention, it is the mechanism.** A file there is named for
the tool the model calls, default-exports it, and is picked up by the build. It
is not imported by `agent.ts` and not listed anywhere:

```ts
// tools/roll_dice.ts  →  the model calls this "roll_dice"
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Roll dice",
  inputSchema: z.object({ sides: z.number() }),
  execute({ sides }) {
    return Math.floor(Math.random() * sides) + 1;
  },
});
```

```ts
// agent.ts — nothing about tools appears here
import { agent } from "@alexkroman1/aai";

export default agent({ name: "Dice Agent" });
```

Three rules come with it, each a build error naming the file:

- **The file name is the tool name**, so it must be lowercase, start with a
  letter, and join words with `_` — `tools/incident_create.ts`, never
  `incident-create.ts`. Renaming the file renames the tool.
- **The export is the DEFAULT export**, and it must be a `tool()` (or a
  `slot.tool()` / `slot.updateTool()`). A file exporting something else is
  named at build time rather than becoming a tool that fails per turn.
- **`tools/` is flat.** A nested file is rejected, because a provider will not
  accept a tool name with a `/` in it and inventing a flattening rule would
  freeze a guess. This applies to a nested HELPER too, not just a nested tool —
  the build cannot tell them apart, so put shared helpers beside `agent.ts`
  rather than under `tools/`. The error names the file and both ways out.

A tool that closes over module-local state, or one built by your own wrapper,
still gets its own file — the file names the instance and the factory lives
beside it:

```ts no-check
// tools/to_hotel_assistant.ts
import { delegationTool } from "../routing.ts";

export default delegationTool("hotel");
```

Why discovery rather than a map: the map was 62 lines across the shipped
templates whose entire content was `snake_case_name: camelCaseImport`, and
forgetting one line was **silent** — the file compiled, every check passed, and
the tool simply never reached the model.

## Built-in tools

Enable via `builtinTools` in `agent()`. **When `builtinTools` is omitted, none
are enabled** — omitting the field and passing `[]` mean the same thing. Name
the ones you want; a built-in is something an agent asks for rather than
something it has to notice and switch off.

| Tool | Description | Params |
| --- | --- | --- |
| `web_search` | Search the web (DuckDuckGo) — no API key required | `query`, `maxResults?` (default 5) |
| `visit_webpage` | Fetch URL to plain text | `url` |
| `get_page_design` | Fetch URL's raw HTML + CSS (style blocks and linked stylesheets) to study/mimic a site's design | `url` |
| `fetch_json` | HTTP GET a JSON API | `url`, `headers?` |
| `run_code` | Execute JS in the agent's sandbox — same authority as the agent's own tool code, output is what it logs (5s timeout) | `code` |
| `think` | Private reasoning scratchpad, no side effects | `thought` |
| `remember` | Save a confirmed fact to session notes | `key`, `value` |
| `recall` | Read session notes saved with `remember` | `key?` |
| `calculate` | Safe arithmetic evaluator, no code execution | `expression` |

**Every builtin in this table is a tool the MODEL calls — not a function
your code can call.** Listing one in `builtinTools` adds it to the model's
tool set; it does not import anything into `agent.ts`. There is no
`fetch_json()` you can call from a tool's `execute`.

So the two ways to reach an API are genuinely different designs, and both
are valid:

- **Declare the builtin** (`builtinTools: ["fetch_json"]`) when the MODEL
  should decide the URL and read the JSON — general lookups you cannot
  enumerate ahead of time.
- **Write your own tool** whose `execute` calls `fetch` when YOU own the
  URL and the shape — a specific endpoint, auth, or a response you want to
  reshape before the model sees it.

The network builtins take model-controlled URLs, so they are SSRF-screened
when the runtime is not inside a container (private/loopback blocked). Your
own tool code has open egress either way.

## Calling an external API from your own tool code

`fetch` inside a tool's `execute` works directly — no declaration needed,
identical under `aai dev` and deployed. This is the right choice when your
code owns the URL.

Reaching for the `fetch_json` builtin instead is a different design, not a
shortcut for the same one: it hands URL choice to the model. You cannot
call it from `execute` — see the builtin table above.

## Small helpers — `@alexkroman1/aai/utils`

Zero-dependency helpers a tool body, a step or a client may reach for, so the
same three lines are not rewritten per template. Import from `/utils`, which is
safe from a `workflows/*.ts` module and from a browser bundle:

| Helper | For |
| --- | --- |
| `errorMessage(err)`, `errorDetail(err)` | Turning an unknown `catch` value into a sentence for the model or the log |
| `responseErrorMessage(res, label)` | The same for a non-2xx `Response`, preferring a JSON `error` field over the bare status |
| `safeJsonParse(text)` | A parse that answers `undefined` instead of throwing |
| `formatBytes`, `formatDuration`, `countWords`, `plural` | Narration. Each returns ONE fixed shape, so a step's progress line and the page rendering the same run cannot disagree — they did, one template printing `1:04:09` from its workflow and `64:09` from its page |
| `pushCapped(list, item, max)` | An append that keeps the last N, for a log a session accumulates |
| `isRecord(x)`, `omitUndefined(obj)` | The object guard and the spread-free way to drop undefined fields |
| `decodeHtmlEntities(text)` | Six entities, no dependency. Enough for a `client.tsx`; for a page or a feed see `/html` below |
| `createKeyedLock()` / `withLock(lock, key, work)` | Serializing async work per key |

**`createKeyedLock` is the one an agent most needs and least expects to.** The
LLM loop runs a step's tool calls CONCURRENTLY, so two tools mutating the same
external resource interleave at every `await`. A session-state mutation is NOT
that case — `slot.update`'s window is synchronous — so reach for the lock when
the thing being mutated is outside the session. `withLock` takes an optional
acquire deadline and throws `KeyedLockTimeoutError` when it runs out.

## Reading a page or a feed — `@alexkroman1/aai/html`

A step that fetches somebody else's markup gets a real parse rather than a
regex. Node-only (it pulls two parsers), so import it from `workflows/*.ts` or a
tool, never from `client.tsx`:

```ts
import { htmlToText, pageMetadata, parseFeed } from "@alexkroman1/aai/html";

declare const html: string;
declare const xml: string;

// A page, reduced to the prose worth putting in a prompt. `<script>` and
// `<style>` bodies never survive, and `maxChars` caps what crosses the wire.
const article = htmlToText(html, { maxChars: 20_000 });

// `og:title` when the page declares one, else its `<title>` element.
const { title, description, feedUrls } = pageMetadata(html);

// RSS, Atom and RDF alike. `published` is ISO whatever the feed wrote, and
// titles come back as TEXT — feeds wrap HTML in CDATA as a matter of course.
const feed = parseFeed(xml);
const episodes = feed?.items.filter((item) => item.enclosureUrl !== undefined) ?? [];
```

**Reach for this rather than writing the patterns.** Both are cheap to get
wrong in ways that only show up on real pages: `<[^>]+>` cuts a tag whose
attribute contains a `>`, `<script[^>]*>[\s\S]*?<\/script>` leaves the whole
script in your prompt when the page was truncated mid-tag, and
`indexOf("<title>")` finds an entry's title rather than a channel's. The
`link-digest` and `podcast-digest` templates each shipped a version of those
before this subpath existed.

## Persisting data — bring your own client

**There is no `ctx.db`.** It was a SQL handle on the tool context, backed first
by a Postgres the platform provisioned per app and later by a `DATABASE_URL` an
author set. The platform provisions no database, and no longer hands tool code
one either.

So a tool that needs to persist anything uses a client of its own:

```ts no-check
// tools/save_note.ts — a driver you added, a credential you set.
import { tool } from "@alexkroman1/aai";
import postgres from "postgres";
import { z } from "zod";

// Module scope, so one pool serves every call in this sandbox.
const sql = postgres(process.env.DATABASE_URL ?? "");

export default tool({
  description: "Save a note.",
  inputSchema: z.object({ body: z.string() }),
  execute: async ({ body }) => {
    await sql`insert into notes (body) values (${body})`;
    return "saved";
  },
});
```

Add the driver to your project's `package.json` and the URL with `aai secret put
DATABASE_URL …` (or in `.env` under `aai dev`). Nothing here is privileged — an
HTTP API, a provider SDK or a hosted KV works the same way.

**What the platform DOES persist for you**, with no setup:

- **`sessionSlot`** — this session's state, durable across a crash or a
  redeploy. Reach for it before reaching for a database; most agents need
  nothing else.
- **Durable workflow runs** — a run survives the sandbox recycling, every
  redeploy, and a multi-day `sleep()`.
- **Workflow uploads** — a file a form submitted, record and bytes both, so a
  resumed run reads the same recording the browser sent.

Those three cover almost everything an agent wants. A database is for data that
must outlive a session AND be queryable: a ledger, filed records, cross-session
saves.

## Custom UI — `client()`

File: `client.tsx` alongside `agent.ts`. Uses **React** (not Preact).
Always import `"@alexkroman1/aai-ui/styles.css"` first.

### Tier 1 — config only (default UI)

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { client } from "@alexkroman1/aai-ui";

client({ name: "My Agent" });
```

### Tier 1 with sidebar

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { client, useEvent } from "@alexkroman1/aai-ui";
import { useState } from "react";

function Sidebar() {
  const [items, setItems] = useState<string[]>([]);
  useEvent<{ item: string }>("new_item", (data) => {
    setItems((prev) => [...prev, data.item]);
  });
  return (
    <div className="p-4">
      {items.map((it, i) => <p key={i}>{it}</p>)}
    </div>
  );
}

client({ name: "My Agent", sidebar: Sidebar });
```

### Tier 2 — full custom component

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { client, useSession } from "@alexkroman1/aai-ui";

function MyApp() {
  const { messages, userTranscript, started, running, start, toggle, end } =
    useSession();
  return (
    <div>
      {messages.map((m, i) => <p key={i}>{m.content}</p>)}
      {userTranscript != null && <p>{userTranscript || "..."}</p>}
      {!started ? (
        <button onClick={start}>Start</button>
      ) : (
        <>
          <button onClick={toggle}>{running ? "Stop" : "Resume"}</button>
          <button onClick={end}>End</button>
        </>
      )}
    </div>
  );
}

client({ component: MyApp });
```

### `client()` config

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — | Header/start screen title (tier 1) |
| `component` | `ComponentType` | — | Custom root component (tier 2) |
| `sidebar` | `ComponentType` | — | Sidebar alongside default chat (tier 1) |
| `sidebarWidth` | `string` | `"18rem"` | CSS width of sidebar |
| `theme` | `ClientTheme` | — | `{ bg, primary, text, surface, border }` |
| `target` | `string \| HTMLElement` | `"#app"` | Mount target |
| `tools` | `ToolDisplayConfig` | — | Icon/label overrides per tool name |

**The two tiers are mostly exclusive.** `sidebar`, `sidebarWidth`, and
`tools` configure the default shell, so passing any of them alongside
`component` is a type error. `name` is the exception — it is allowed with a
custom component and becomes the page title, since there is no shell header
to put it in.

### `useSession()` return type

| Field | Type | Description |
| --- | --- | --- |
| `state` | `AgentState` | `"disconnected"` `"connecting"` `"ready"` `"listening"` `"thinking"` `"speaking"` `"error"` |
| `messages` | `ChatMessage[]` | `{ role, content }` |
| `toolCalls` | `ToolCallInfo[]` | `{ callId, name, args, status, result? }` |
| `customEvents` | `AgentCustomEvent[]` | `{ id, event, data }` from `ctx.send()` |
| `userTranscript` | `string \| null` | `null` = not speaking, `""` = speech detected, string = text |
| `agentTranscript` | `string \| null` | `null` = not speaking, string = streaming response |
| `error` | `SessionError \| null` | `{ code, message }` |
| `started` | `boolean` | Whether session started |
| `running` | `boolean` | Whether session active |

Methods: `start()`, `toggle()`, `end()`, `reset()`, `cancel()`,
`disconnect()`, `resetState()`.

- `end()` hangs up: it flips `started` back to `false` (a start-screen UI
  shows its Start control again) and the next `start()` is a brand-new
  session — fresh per-session tool state, greeting included. Use it for
  End/Hang up/New game buttons.
- `reset()` clears the conversation but keeps the call live (`started`
  stays `true`) — the control stays on Stop/Resume, and per-session tool
  state survives. Use it for a "clear chat" control, not for ending.

## UI hooks

**`useToolResult`** — fires once per completed tool call (deduplicates by
callId):

```ts no-check
useToolResult("tool_name", (result, toolCall) => { ... })          // one tool
useToolResult((toolName, result, toolCall) => { ... })             // all tools
useToolResult<ResultType>("tool_name", (result) => { ... })        // typed (optional)
```

`result` is the tool's return value, already JSON-parsed and untyped — read
fields off it directly (`result.price`). The type parameter is optional; add
it only when you want the shape checked.

**There is no global `JSX` namespace.** React 19 removed it, so
`JSX.Element` is `Cannot find namespace 'JSX'` (`TS2503`). Type a component's
return as `ReactNode` — `import type { ReactNode } from "react"` — which is
also what you want for anything that can be a string, an array, or null.

**`useAgentState`** — the agent's session state, pushed automatically:

```ts no-check
// shared.ts — the slot owns the shape; `agent()` has no `state` field.
export const cartSlot = sessionSlot("cart", () => ({ cart: [] as Item[], staffPin: "" }));

// Compose the projection HERE, once, and import it at both ends: staffPin stays
// server-side, and the agent and the client cannot name different views of it.
export const cartProjection = cartSlot.projection((s) => ({ cart: s.cart }));

// agent.ts
export default agent({ syncState: cartProjection });

// client.tsx — the projection types the state AND supplies the frame the client
// renders before the first push, so there is no type argument and no `?? EMPTY`.
const view = useAgentState(cartProjection);
return <Cart items={view.cart} />;
```

Passing the projection is the shape to copy. The other two overloads still
exist: `useAgentState<S>()` returns `S | null` (nullable — nothing is pushed
before the first tool call), and `useAgentState<S>(fallback)` returns `S` for a
frame you build yourself. Reach for `fallback` only when the slot's factory is
expensive to import into the browser — the projection overload calls it to build
the empty frame.

**Reach for this before wiring `useToolResult` into `useState`.** Without
it the pattern is: return a cart snapshot from every tool, declare a type
describing what those tools return, and mirror it into `useState` — three
things to keep in step, and the usual source of drift when you add a tool
and forget to return the snapshot from it.

`syncState` is a projection, not a flag, because state often holds things
that should not reach a browser (keys, PINs, scratch) or cannot be
serialized. Whatever it returns is exactly what the client receives. It runs
after every tool call and is sent only when the result changed.

**`useEvent`** — fires for custom events from `ctx.send()`:

```ts no-check
useEvent<DataType>("event_name", (data) => { ... })
```

Server: `ctx.send("order", { total: "$14.99" })` —
Client: `useEvent("order", (data) => ...)`.

**`useTheme`** — returns `{ bg, primary, text, surface, border }`.

**`useToolCallStart`** — fires when a tool call begins (status `"pending"`).

**Anti-pattern:** Do NOT use `useEffect` + `toolCalls` to build derived
state. Use `useToolResult` — it deduplicates. The `useEffect` pattern
re-processes every tool call on every render, causing duplicates.

## Components

Available from `@alexkroman1/aai-ui`:

| Component | Props | Description |
| --- | --- | --- |
| `StartScreen` | `children` (**required**)`, icon?, title?, subtitle?, buttonText?` | **Wrapper, never self-closing.** Shows the start card, then renders `children` — your whole app — once the session starts |
| `ChatView` | `icon?, title?` | Chat interface (header + messages + controls) |
| `SidebarLayout` | `sidebar, children, sidebarWidth?, sidebarPosition?` | Two-column layout |
| `MessageList` | — | Messages with auto-scroll, tool calls, transcript |
| `Controls` | — | Stop/Resume + New Conversation buttons |
| `Button` | — | Styled button |
| `UploadProgressBar` | `upload, onPause?, onResume?` | Bytes in flight, with pause/resume |

**Forms are declared, not written.** `<Form onSubmit>` collects typed values off
the DOM and hands them over once the browser's own validation passes; the field
components — `TextField`, `TextAreaField`, `NumberField`, `SelectField`,
`CheckboxField`, `FileField` and `SubmitButton` — are plain named inputs, and
`Field`/`FieldShell` are what a custom control wraps itself in to match them.
For a workflow app there is usually no field markup at all: `<WorkflowFields
workflow="name" />` fetches that workflow's input schema and renders a control
per field, so a page written against one workflow serves another.

```tsx no-check
import { Form, WorkflowFields } from "@alexkroman1/aai-ui";

<Form onSubmit={(values) => submit(values)} error={error}>
  <WorkflowFields workflow="digest" />
</Form>;
```

`transcription-workflow` is the all-declared version; `link-digest` writes its
form by hand, which is what the two are for.

The usual shape — note `StartScreen` **wraps** the app rather than sitting
beside it; writing `<StartScreen ... />` self-closing is a `TS2741:
Property 'children' is missing` build error:

```tsx
/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import { ChatView, client, StartScreen } from "@alexkroman1/aai-ui";

function PizzaApp() {
  return (
    <StartScreen title="Pizza Palace" subtitle="Voice-powered ordering">
      <ChatView />
    </StartScreen>
  );
}

client({ component: PizzaApp });
```

## Styling

- **Tailwind CSS v4** — compiled at bundle time, configured via CSS.
  Do NOT create `tailwind.config.js` — it will be ignored.
- Use Tailwind classes for layout, `useTheme()` for dynamic colors.
- Set theme: `client({ theme: { bg, primary, text, surface, border } })`.
- Override CSS custom properties for extra tokens:
  `--color-aai-*`, `--radius-aai`, `--font-aai`.
- Always import `"@alexkroman1/aai-ui/styles.css"` at the top of `client.tsx`.

### Design guidelines

A custom UI should look deliberate, not like boilerplate. When building or
restyling a `client.tsx`:

- **Color:** pick one primary brand color, 2-3 neutrals (white/grays/black
  variants), and at most 1-2 accents — 3-5 colors total. Avoid gradients
  unless asked. If you override an element's background color, also set its
  text color so contrast holds.
- **Typography:** at most 2 font families — one for headings, one for body.
  Body text 14px or larger with a relaxed line height (`leading-relaxed`).
- **Layout:** design mobile-first, then enhance with responsive prefixes
  (`md:`, `lg:`). Prefer flexbox (`flex items-center justify-between`);
  use grid only for genuinely two-dimensional layouts; avoid absolute
  positioning unless nothing else works.
- **Tailwind:** stay on the spacing scale (`p-4`, never `p-[16px]`), use
  `gap-*` between siblings rather than per-child margins, and wrap headings
  and key copy in `text-balance` or `text-pretty`.
- **Accessibility:** semantic elements (`main`, `header`, `button`), alt
  text on meaningful images, `sr-only` labels on icon-only buttons.
- **No filler:** no emojis as icons, no decorative gradient blobs or
  abstract placeholder shapes, no lorem-ipsum-looking content.

## Secrets

Never hardcode secrets in agent code.

- **Local dev:** `.env` in project root. Only declared keys available via
  `ctx.env`.
- **Production:** `npx @alexkroman1/aai-cli secret put NAME`
- **Access:** `ctx.env.MY_KEY` in tool execute functions.
- **AssemblyAI key:** `npx @alexkroman1/aai-cli login` links your account and
  stores the key globally — the only way the CLI authenticates. No `.env`
  entry needed. For CI, point `AAI_CONFIG_DIR` at a config dir holding a
  logged-in key (an exported `ASSEMBLYAI_API_KEY` does not authenticate).

## Voice rules for systemPrompt

- Short, punchy sentences — optimize for speech, not text
- Never mention "search results" or "sources" — speak as if knowledge is
  your own
- No visual formatting (bullets, bold) — use "First", "Next", "Finally"
- Lead with the most important information
- Keep answers to 1-3 sentences
- No exclamation points — calm, conversational tone
- No hedging ("It seems that", "I believe")
- Define personality, tone, and specialty
- Include when and how to use each tool

**Three helpers for the other direction — what the caller SAID.** Speech
arrives as words, so `@alexkroman1/aai` publishes the conversions a tool
otherwise re-derives: `spokenDigits("four one five")` gives `"415"` for an
order number or a phone number, `spokenOrdinal("the third one")` gives `3`, and
`resolveOne(candidates, spoken, opts)` picks the one item a phrase meant —
answering a `ToolFailure` the model can act on when nothing matches or several
do, which is the case a hand-written `.find()` gets wrong.

Patterns by agent type:

- **Code execution:** "You MUST use run_code for ANY math, counting, or
  data processing. NEVER do mental math."
- **Research:** "Search first. Never guess or rely on memory for factual
  questions."
- **FAQ/support:** "Base answers strictly on your knowledge — don't guess."
- **Game/interactive:** "You ARE the game. Keep descriptions to 2-4
  sentences. No visual formatting."

## Gotchas

Common mistakes when working in aai projects:

- **Tool execute must return a value.** A missing return = `undefined` in
  LLM context = the model thinks the tool failed.
- **Filter large API responses before returning them from tools.** Return
  values are injected into LLM context. Truncate, summarize, or extract
  only what the model needs.
- **Declare only the pipeline stages you're changing.** Unset stages of
  `stt` / `llm` / `tts` default to AssemblyAI (omit all three for the full
  default pipeline; `voice` picks its TTS voice). S2S needs an explicit
  `s2s: assemblyAIS2s()` and takes no pipeline fields.
- **Never hardcode secrets.** Use `ctx.env.MY_KEY`. `.env` for local dev,
  `aai secret put` for production.
- **Don't use `useEffect` + `toolCalls` to derive state.** Use
  `useToolResult` — it deduplicates by callId. The useEffect pattern
  re-fires on every render and produces duplicates.
- **Always import `"@alexkroman1/aai-ui/styles.css"` first** in
  `client.tsx`. Missing this = unstyled UI.
- **Don't create `tailwind.config.js`.** Tailwind v4 is configured via
  CSS; the config file is ignored.
- **Voice prompts ≠ chat prompts.** No bullets, no bold, no exclamation
  points. See "Voice rules" above.
- **`fetch` to private IPs is blocked** (SSRF protection). Use public URLs.
- **`run_code` only executes on the deployed platform.** It runs inside the
  platform's Modal/Deno sandbox; the self-hosted `aai dev` server has no
  sandbox, so there `run_code` refuses with an error result. Deploy to test
  it end-to-end, or use the `calculate` builtin for simple arithmetic in dev.
- **There is no `ctx.db`.** The platform provisions no database and hands tool
  code none, so a tool that persists brings its own client — see "Persisting
  data". Two consequences worth knowing before you do: a deployed agent reads a
  secret when its sandbox is BUILT, so a newly set `DATABASE_URL` reaches it on
  the next deploy rather than immediately; and a database you bring is shared by
  every session of the deployment, so key rows yourself if sessions must not see
  each other's data (or keep session-scoped data in a `sessionSlot`).
- **Rime language codes are ISO 639-3** (3-letter, e.g. `"eng"`), not
  ISO 639-1 (`"en"`).

## Constraints

- Tool `execute` return values go into LLM context, capped at 4000 chars
  (a truncation marker replaces the tail) — filter large API responses
- Tool code uses plain `fetch` with open egress; the keyless web builtins
  screen private/internal IPs (SSRF) when running outside a sandbox
- Agent code runs in a sandboxed worker — use `fetch` for HTTP, `ctx.env`
  for secrets
- Tool execution timeout: 30 seconds
- `maxSteps` limits tool calls per turn (default 10) — lower it for a
  latency-sensitive agent. On reaching the cap the agent spends one more LLM
  step with tools switched off, so it answers with what it has instead of
  going silent mid-chain
- Tool returns `undefined` if execute function has no return statement —
  always return a value
