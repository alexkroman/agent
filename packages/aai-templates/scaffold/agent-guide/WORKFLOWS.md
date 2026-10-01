# Workflows — durable runs, steps and workflow apps

Part of the aai authoring guide. Start with the core guide (`AGENT_GUIDE.md`
in the SDK, `CLAUDE.md` in the scaffold); this file is the reference for
`workflow()`, `workflowApp()`, step code in `workflows/*.ts` and the page that
drives a run. Session tools that START a run are in `TOOLS.md`.

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
`requiredEnv` stay. `workflowApp()` is `agent({ mode: "workflow-app", … })` with
the discriminant already set — same definition object out, so `aai build`,
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
in `TOOLS.md`.

### Workflow bodies live in `workflows/`

A body is an ordinary exported async function of its input and a `WorkflowContext`.
There is no directive and no compile step of its own — the agent bundle compiles
`workflows/` like any other source file — and durability is a method call:

```ts
import type { WorkflowContext } from "@alexkroman1/aai";

export async function digestFlow(input: { url: string }, ctx: WorkflowContext) {
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

**Type the body's input from the SCHEMA, not by hand.** The example above writes
`input: { url: string }`, which is fine only while the workflow declares no
input schema. Once it does, a hand-written parameter is unchecked: `run` takes
its input as a function PARAMETER, so it is contravariant, and a body declaring
a wider shape — or the same shape with one field's optionality or default
wrong — is assignable and compiles. A `z.number().default(5)` against a body
that writes `input.limit ?? 3` is the sharp version: the schema guarantees
`limit` is there, the `??` is dead, and the two numbers disagree with nothing
to report it. `WorkflowInputOf<typeof theDef>` reads the declaration instead.

**Reaching for it needs one thing that is not obvious: ANNOTATE the def.** The
obvious spelling does not compile —

```text
error TS7022: 'digest' implicitly has type 'any' because it does not have a type
annotation and is referenced directly or indirectly in its own initializer.
```

— because `workflow()` infers its output from `run`, so `typeof digest` needs
the body's signature while the body's signature needs `typeof digest`. Naming
the schema in a `const` and annotating the def breaks the cycle:

```ts
import {
  type WorkflowContext,
  type WorkflowDef,
  type WorkflowInputOf,
  workflow,
} from "@alexkroman1/aai";
import { z } from "zod";

const digestInput = z.object({ url: z.string(), limit: z.number().default(5) });

// The annotation is what `typeof digest` resolves to, so it no longer depends
// on the body below it.
export const digest: WorkflowDef<typeof digestInput, { headline: string }> = workflow({
  description: "Summarize a page",
  input: digestInput,
  run: digestFlow,
});

export async function digestFlow(input: WorkflowInputOf<typeof digest>, ctx: WorkflowContext) {
  // `limit` is `number`, not `number | undefined` — the default already ran.
  return await ctx.step("summarize", () => ({ headline: `${input.url} (${input.limit})` }));
}
```

Declaring an `output` schema is what makes the annotation cheap: with one, the
output type is stated once, in the schema, and checked where the run completes.

Two of that family are on `@alexkroman1/aai` — `WorkflowInputOf` for a body's
parameter and `WorkflowRunOf` for a `*_status` tool's snapshot. The third,
`WorkflowOutputOf`, is on `@alexkroman1/aai/workflow-api` only, because its
reader is a `client.tsx` parameterizing `useWorkflowRun<…>`; a status tool wants
`WorkflowRunOf`, which composes the output in already.

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
import type { WorkflowContext } from "@alexkroman1/aai";

declare function charge(amount: number, idempotencyKey: string, jitter: number): Promise<void>;

export async function chargeFlow(input: { amount: number }, ctx: WorkflowContext) {
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
- **Racing two independent waits WORKS** (the run suspends once, on the
  earliest), but a deadline ON a wait is `timeoutMs`: it CLOSES the hook before
  the body continues, so a late signal cannot change a window already timed out.
- **`ctx.workflows.wakeUp(runId, { correlationIds: [id] })`** ends a sleep early,
  which is how a "send it now" tool cuts a scheduled wait short. Naming no ids
  wakes every outstanding SLEEP and deliberately not a `waitFor` deadline, so
  cutting a schedule short cannot also close an approval window.
- **A SUSPEND is not free, so `ctx.sleep` is not a `setTimeout`.** A wait costs
  a journal write to record it, a queued delivery to bring the run back, and a
  fresh WALK of the body — measured on a deployed agent at roughly a second of
  overhead around the sleep itself, on top of whatever you asked for. A sleep
  shorter than the round trip that records it never suspends AT ALL —
  `ctx.sleep("beat", 100)` is as free as `0` — while anything longer pays the
  whole cost.

  So a sub-second pause is not what this is for. For a short backoff inside a
  step, use an ordinary timer (`sleep` from `@alexkroman1/aai/internal`) — a step
  body may not call `ctx.sleep` anyway, and the engine refuses one that does. Use
  `ctx.sleep` for a wait you want to SURVIVE the process, which is the thing a
  timer cannot do. A body that polls in a loop pays the suspend per iteration,
  which is the strongest argument for the next section: park on the callback.

#### A third-party callback is an OPTIMIZATION over a reconciling read

The webhook route is how a payment provider, a transcription service or an
approval mailer resumes a run, and `meeting-recap-agent` is the worked example —
it hands AssemblyAI a `webhook_url` and parks on the delivery instead of polling
for twenty minutes. Five things about that shape, every one a trap somebody has
already paid for:

- **Mint it with `stepWebhookUrl(token)`, from inside the step that hands it
  over.** That is the step-side half of `ctx.workflows.publicWebhookUrl` — the
  tool-side one needs a `ToolContext`, which a step is not handed. It THROWS when
  the deployment cannot mint one, which a step should catch and treat as "no
  callback": a run must not fail over a missing optimization. And note
  `requireStepEnv("AAI_PUBLIC_BASE_URL")` is NOT a substitute — the public base
  URL is a boot parameter of the deployment, not one of the agent's own secrets,
  so that read is `undefined` in production precisely where the value exists.
- **Return the callback FACT from the step, and branch on that.** Whether a
  callback was registered decides whether the body parks, and a body may only
  branch on values that came out of the journal. Mint inside the step's function
  — it runs once, on first execution, never on a replay — and answer
  `{ id, callback }`.
- **Keep the poll as the TIMEOUT arm.** A webhook is one HTTP POST from a third
  party with no delivery guarantee you control: the sender gives up after its own
  retry budget, a deployment may not know its public URL, and a delivery that
  lands before your body reaches its wait is answered `404` and dropped. So read
  the state before you park and again after, give the wait a `timeoutMs`, and let
  an unanswered window fall through to the read.
- **Wait for the EDGE, not the answer.** Treat the payload as "something
  happened, go look" and get the fact from the far side's own API under your own
  credential. That is what makes an unauthenticated callback route safe: a forged
  delivery on a guessed token costs one extra read and changes no outcome. The
  route authorizes on the TOKEN and reads no other header, so a sender's own
  auth-header option is ignored.
- **One token, ONE `waitFor` per run.** A token is claimed for the life of its
  run and given back when the run goes terminal, so a second `ctx.waitFor` on the
  same token — a wait written inside a loop — THROWS. A throw is not a suspend,
  so a body with a `catch` will treat it as a failed run and start compensating.
  Park once, outside the loop.
- **You cannot test it under `aai dev` without a tunnel.** `publicUrl` there is
  `http://localhost:<backend port>`, which no third party can reach — so the
  delivery never arrives and the run silently takes the fallback.
  `aai dev --tunnel` is what makes it reachable.

### Testing a workflow body

Steps are ordinary exported functions, so a spec imports and calls them. The
BODY needs an engine, and there are two, for two different questions.

**"What did the body ask for?"** — `createWorkflowContext` from
`@alexkroman1/aai/testing`. It runs the steps and records the names, the retry
policies and the sleeps, over one walk with no journal. Nothing replays, so a
spec built on it must not claim to test durability.

```ts no-check
import { createWorkflowContext } from "@alexkroman1/aai/testing";

const ctx = createWorkflowContext({ runSteps: false });
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
import { stepEnv, stepGenerate } from "@alexkroman1/aai/step";
import { orFail } from "@alexkroman1/aai/step-errors";

async function summarize(text: string) {
  // The agent's env by name — the same values a tool reads from `ctx.env`.
  // `requireStepEnv` fails naming the key; `stepEnv` returns undefined.
  const style = stepEnv("DIGEST_STYLE") ?? "plain";

  // One model call, on the agent's own ASSEMBLYAI_API_KEY and default model.
  return await orFail(stepGenerate)(`${style} summary of:\n\n${text}`, {
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
deploy. Use `orFail(stepGenerateJson)` with a Zod `schema` if you need a shape.

### From a step, wrap the call in `orFail`

`orFail` (`@alexkroman1/aai/step-errors`) wraps any `/step` call that can fail
remotely, classifying its failure, and **inside a step the wrapped call is the
one to use**:

```ts
import { stepFetch, stepGenerateJson, stepTranscribeSubmit } from "@alexkroman1/aai/step";
import { orFail } from "@alexkroman1/aai/step-errors";
import { z } from "zod";

const Reply = z.object({ headline: z.string() });

export async function digest(url: string, audioUrl: string) {
  const page = await (await orFail(stepFetch)(url)).text(); // a 404 stops, a 503 retries
  const reply = await orFail(stepGenerateJson)(page, { schema: Reply });
  const job = await orFail(stepTranscribeSubmit)(audioUrl);
  return { headline: reply.headline, transcriptId: job.id };
}
```

It covers `stepGenerate`, `stepGenerateJson`, `stepFetch`, `stepTranscribeSync`,
`stepTranscribeUpload` / `Submit` / `Poll` and `sendToChannel` (`/channels`) —
and any call of your own that throws a `Response` or an error carrying
`retryable`. Around `stepFetch` it also turns a NON-2XX RESPONSE into a throw:
`stepFetch` resolves with a `404` rather than raising it.

The whole of what `orFail` adds is `throwStepError`, and that is worth having
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

**Why the split exists, since the wrapped call is what you usually want:**
importing from here is the OPT-IN, and `/step` is not written only for a step:
`mapConcurrent` bounds a rate-limited call anywhere, `stepFetch` is an
ordinary HTTP client, and your specs drive exported steps directly. None of
those callers has a retry budget to burn, so none should meet a vocabulary whose
whole subject is one. A step pays nothing for the extra import line.

### Media, big files, and transcription from a step

Three more subpaths a `workflows/*.ts` module can reach, all with the same
bundling rule as `/step` — import them there, never through the root barrel:

- **`@alexkroman1/aai/step`** — `stepTranscribeSync(bytes)` for a short
  recording, or `stepTranscribeUpload` → `stepTranscribeSubmit` →
  `stepTranscribePoll` for a long one, plus `Transcript`, `TranscribeError` and
  the `TRANSCRIBE_*` limits. (There is no `/transcribe` subpath; transcription
  lives on `/step` with the other step primitives.) Wrap each in `orFail`
  as above: a provider refusal — a container it will not read, a
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

`call-audit-workflow` is the worked example for all three at once.

### Posting somewhere — `@alexkroman1/aai/channels`

A run that finishes while nobody is on the line needs somewhere to put the
result. `slackChannel({ webhookUrl })` (or `textbeltChannel({ key, to })`, an
SMS) names a destination and `orFail(sendToChannel)(channel, message)` posts to
it:

```ts no-check
import { type ChannelMessage, sendToChannel, slackChannel } from "@alexkroman1/aai/channels";
import { requireStepEnv } from "@alexkroman1/aai/step";
import { orFail } from "@alexkroman1/aai/step-errors";

export async function announce(headline: string, points: string[]) {
  const message: ChannelMessage = {
    text: headline,
    sections: points.map((point) => ({ body: point })),
  };
  return await orFail(sendToChannel)(slackChannel({ webhookUrl: requireStepEnv("SLACK_WEBHOOK_URL") }), message);
}
```

The webhook URL is a secret like any other — declare it in `requiredEnv` and set
it with `aai secret put`. A channel's credential is its DESTINATION and is
passed in, so no channel reads an env var of its own. `ChannelMessage` is
rendered per platform, so the same message is legal on a channel kind added
later; `isSlackWebhookUrl` / `isSlackWorkflowTriggerUrl` validate a pasted URL
before a run depends on it, and `explainChannelFailure` turns a refusal into a
sentence a person can act on. `podcast-digest-workflow` is the worked example.

### Reaching a device after the call

A run reaches a device holding `WS /inbox?client=<id>` open: a tool passes
`sessionClientId(ctx)` to the run, and a step's `stepNotifyClient` throws a
retryable error until the device acks. Test: `stubClientInbox`.
`?client=` also makes a device one conversation across connects (self-hosted):
`sessionContext`, `onSessionEnd`, `stepClientTranscript`; its id is the only
key.
A page is a device too: `mountClient({ client: "auto" })` keeps a per-browser
id; `useInbox({ onNotice })` holds the inbox (busy mid-call) and plays notices;
`useClientId()`/`useSessionId()` read the ids. Also: `useTapToTalk`,
`useConversationLog`, `useRoute`, `createStoredValue`.

### A step's HTTP: use `stepFetch`, not `fetch`

Any outbound request from a step goes through `stepFetch` (also
`@alexkroman1/aai/step`). Not a style preference: `fetch` is the wrong call
from a step, for a reason the call site does not show:

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
connection, sharing one flow-control window: fine for small JSON, pathological
for `mapConcurrent` over large bodies (8 concurrent 17.66 MB uploads: `fetch`
landed 14 of 16 at p50 8094ms, HTTP/1.1 16 of 16 at p50 3037ms).

**The two it lost matter more than the latency.** On
HTTP/2 a capacity limit arrives as a _stream reset_ — `NGHTTP2_ENHANCE_YOUR_CALM`
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
generated PDF — needs two things a first draft reaches for and misses.
Both are on `@alexkroman1/aai/step`, and `spoken-summary-workflow` shows the
whole round trip.

```ts
import { stepSpeak, stepWriteUpload } from "@alexkroman1/aai/step";

export async function narrate(script: string) {
  const spoken = await stepSpeak(script, { voice: "jane" });
  const stored = await stepWriteUpload(spoken.audio, { name: "summary.wav", type: "audio/wav" });
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
rather than typing an id, because a wrong one is refused _after_ the socket
opens and produces silence rather than an error. The `AssemblyAITtsVoice` type
gives you autocomplete over it and nothing more: it accepts any string, so that
a voice the service adds after this release still compiles.

**`stepWriteUpload` is `stepReadUpload`'s other direction, and you need it.** A
run's output is read back as JSON, so audio cannot travel in one — the same rule
that keeps an uploaded recording's bytes out of a run's INPUT, arriving at the
other end of the run. Store the bytes, return the **id**, and let the page fetch
it with `api.download(id)`. A step that wants the record rather than the bytes
reads it with `stepUploadInfo(id)`, which answers an `UploadInfo` — the name,
the size stored so far, and whether that is all of it.

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

A workflow app's `client.tsx` mounts with `mountPage()` rather than
`mountClient()` — there is no session to build, so no socket, no audio graph
and no microphone request. Everything else is the same file, React and
Tailwind included.

```tsx no-check
import { createWorkflowApi, mountPage, useWorkflowRun } from "@alexkroman1/aai-ui";
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

mountPage({ name: "Link Digest", component: App });
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
