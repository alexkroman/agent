# Testing and evals

Part of the aai authoring guide (start with the core guide). A TEST asserts the
agent's shape and its tools' logic (`pnpm test`); an EVAL drives a real session
and asserts what the agent did (`pnpm eval`). Testing a workflow BODY — the
replay engine, crashes, signals — is "Testing a workflow body" in
`WORKFLOWS.md`.

**A test file imports testing names from two doors, and only those two:**

| Import from                               | For                                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@alexkroman1/aai-runtime/testing`        | everything that installs nothing — `createToolContext`, `expectToolOk`, `expectSlotContract`, `fireEvent`, the stubs, `runWorkflow` |
| `@alexkroman1/aai-runtime/testing/vitest` | everything that installs or restores (`installStubGateway`, `installStubWorld`, …), `describeAgent` and the eval suites             |

`vitest.config.ts` is the one exception: it imports `defineAgentTestConfig` from
`@alexkroman1/aai/testing/vite`. (The helpers are declared in
`@alexkroman1/aai/testing` and `/testing/vitest`, which still work; the two
runtime doors re-export them as the same declarations beside the runtime's own.)

## Specs: `agent.test.ts`

Co-locate tests as `agent.test.ts` (the `custom-pipeline-agent` template is a
reference). **When the project has one, it is yours to maintain**: it asserts
the agent's shape — name, providers, tool names — so rewriting the agent without
updating it leaves a test asserting an agent that no longer exists. When a test
fails after your change, decide which side is stale: updating the test to match
the new agent is a normal fix, not a workaround. Do not delete a test to make it
pass.

**A spec that needs the agent as DEPLOYED imports one module:**

```ts
import agentDef from "virtual:aai/agent";
```

That is `agent.ts` with its `tools/` directory discovered and its
`system-prompt.md` applied — the same lowering `aai build` does, so a spec
measures the agent that ships rather than the raw default export (which has no
tools and the framework's default prompt). `vitest.config.ts` registers the
plugin that serves it; a scaffolded project already has it. For a runner that is
not vitest, `deployedAgent` on `@alexkroman1/aai-runtime/testing` is the same
thing written out.

**Open the suite with `describeAgent(agentDef, (run) => …)`**: a `describe`
named after the agent whose first case is "is deployable" (`expectDeployable`; a
config the platform refuses is a spec measuring nothing), handed the agent's
typed runner. **A tool is reached by its DEF, never by its name string.**
`run(toolDef, args, ctx?)` is typed end to end: handed the def, the arguments
are checked and the result is what `execute` returns — no `as` cast — and the
def is resolved in the agent's table by identity, so a dialog gate or a roster
still refuses it as it would the model. The def is the tool file's default
export (`import placeOrder from "./tools/place_order.ts"`); for a roster tool it
is the speaker's `tools` entry (`billing.tools.lookup_invoice` — keep the map in
a named const so it stays typed); for a tool the roster minted (`handoff`,
`delegate`) it is `toolOf(agentDef, HANDOFF_TOOL_NAME)`; for a builtin it is
`builtinTool("workflow_cancel")` from `@alexkroman1/aai/tools`, which no
`toolRunner` runs (the runtime merges builtins in at session start) but every
eval reader takes. A string in the tool position is a compile error. **Unwrap a
result that may be a refusal with `expectToolOk(result)`**, which subtracts the
`ToolFailure` arm (and a gated tool's envelope) and throws quoting the refusal;
`expectDialogRefused(result)` asserts a gate HELD. Do not copy an `ok<T>()`
helper into a spec, and do not claim a result's type — `expectToolOk<T>(…)`
takes no claim; the def already types it.

```ts no-check
import agentDef from "virtual:aai/agent";
import { expectToolOk } from "@alexkroman1/aai-runtime/testing";
import { describeAgent } from "@alexkroman1/aai-runtime/testing/vitest";
import { expect, test } from "vitest";
import placeOrder from "./tools/place_order.ts";

describeAgent(agentDef, (run) => {
  test("places the order", async () => {
    const order = expectToolOk(await run(placeOrder, { item: "pizza" }));
    expect(order.id).toBe("ord_1");
  });
});
```

`expectDeployable(agentDef)` on its own returns a `DeployedConfig` (`name`,
`systemPrompt`, `mode`, `builtinTools`, …) to assert on. **A slot's contract is
one call**: `expectSlotContract(slot, { write, caps })` asserts the projected
default agrees with the view, that two sessions never share a value (`write`
proves it through one of them) and that each cap keeps the NEWEST entries.

**A hand-built `ctx` is `createToolContext()`** — every field inert, `send`
recorded on `ctx.sent`, a real slot store, a fresh `sessionId` per call,
`turn: 0` and `now: Date.now` unless pinned
(`createToolContext({ turn: 3, now: () => 1_700_000_000_000 })` makes "on the
third turn" and an opening-hours check exact). Its `generate` and `delegate`
take a SCRIPT (`{ reply }` for every call, `{ routes }` keyed by system prompt
or subagent name) and hand the fake back on `ctx.model` and `ctx.desk`, whose
`calls` a spec asserts on.

**An `events` handler is driven with `fireEvent`**:
`await fireEvent(agentDef, sessionEvent("userTranscript.committed", { text }), ctx)`
dispatches the typed handler then `"*"`, the way the session does — except that
a throw propagates and an async handler is awaited, since the spec is reading
the outcome. `sessionEvent(type, fields, meta?)` builds the event with its
envelope, and a field the event does not have is a compile error.

```ts
import { createToolContext } from "@alexkroman1/aai-runtime/testing";
import { expect, test } from "vitest";

test("the tool asks the model once", async () => {
  const ctx = createToolContext({
    generate: { reply: "A short summary." },
    delegate: { reply: "The researcher's answer." },
  });
  await ctx.generate({ prompt: "Summarize the call." });
  expect(ctx.model.calls).toHaveLength(1);
  expect(ctx.desk.calls).toHaveLength(0);
});
```

The other doubles a tool body needs are on the same door — `stubDelegate` for a
subagent, `endSessionCalls(ctx)` for a hang-up, `stubStepFetch`/`stubSpeech`/
`stubUploads`/`stubPlaceCall` for step I/O — and each topic file names the one
its feature needs. **A fake that fills a process-wide slot is INSTALLED** from
`@alexkroman1/aai-runtime/testing/vitest`, which arms it for one test and
restores it afterwards: `installStubGateway(replies)` answers a step's model
calls (`stepGenerate`, `stepGenerateJson`) and returns the calls it saw. Call it
by its own name — do not alias it to `stubGateway`, which is the non-installing
builder it wraps. **It also seeds `ASSEMBLYAI_API_KEY`** for the test, so a spec
never writes `vi.stubEnv` for it; the one spec whose subject is the missing-key
refusal passes `apiKey: false`, which ensures there is NO key for that test even
when the shell exports one. A workflow that calls a model AND fetches a page AND
transcribes installs them all at once:
`installStubWorld({ model, pages, transcribe, speech, uploads: { files, writable } })`
composes the seams in the one order that works and hands back every fake's call
log (`world.model`, `world.provider`, `world.reported`, …).

## Evals: `agent.eval.test.ts`

Run `pnpm eval` when you change what the agent DOES. Cases live in
`agent.eval.test.ts` (the `quickstart-agent` template ships one), and everything
an eval's harness needs — `describeEval`, the readers and claims,
`evalSimulation`, and stubs like `stubGatewayRoute` — is on
`@alexkroman1/aai-runtime/testing/vitest`:

```ts
import { agent } from "@alexkroman1/aai";
import { describeEval, expectCalled } from "@alexkroman1/aai-runtime/testing/vitest";
import { expect } from "vitest";

// In an eval this is `import agentDef from "virtual:aai/agent"`.
const agentDef = agent({ name: "Orders" });

describeEval(agentDef, (test) => {
  test(
    "looks the order up before answering",
    async ({ session }) => {
      // `say()` returns THAT turn — the reply, its tool calls, its events.
      const turn = await session.say("where is order W1234?");
      expectCalled(turn, "look_up");
      expect(turn.text).toMatch(/shipped/i);
    },
    // What a SCRIPTED model answers with when there is no key (below).
    { stubReply: "Order W1234 shipped yesterday." },
  );
});
```

Everything is real except the microphone and the speaker: your tools, your
prompt, the session's own event stream. Before trusting a green run:

- **With a provider key it uses a LIVE model** — it spends tokens, and it is a
  noisy instrument. One failure is a question, not a verdict; re-run before
  believing either answer.
- **Without one it uses a SCRIPTED model** answering each case's `stubReply`,
  and says so. That still proves the agent boots, the tools resolve and the
  session reaches a reply — it proves nothing about what the agent SAYS. Give a
  case `{ live: true }` instead when no script could honestly stand in (a tool
  the model has to choose for itself, a refusal, a judgement).

**Who is calling** is a suite or case option (a case's `null` clears it):
`clientId`, `phone` and `call` are what `sessionClientId`, `sessionClientPhone`,
`sessionCall` and `sessionContext` see; a refused call reads as
`session.refused`. A tool's `endSession(ctx)` really hangs up
(`turn.endedSession`, `session.ended`); that turn awaits `onSessionEnd`. A
tool's `sendDtmf(ctx, keys)` presses really reach the session: `turn.dtmf` lists
the keys pressed that turn, whatever the tool is called. To test an agent that
places calls against an automated phone menu, declare the menu as data and walk
it — `walkPhoneTree(session, tree)` plays each prompt, follows the keys the
agent actually pressed (a wrong key replays the menu, as a real one does) and
answers `{ reached, path, turns, stopped }`:

```ts
import { agent } from "@alexkroman1/aai";
import { describeEval, walkPhoneTree } from "@alexkroman1/aai-runtime/testing/vitest";
import { expect } from "vitest";

// In an eval this is `import agentDef from "virtual:aai/agent"`.
const agentDef = agent({ name: "Caller", greeting: "" });

describeEval(agentDef, (test) => {
  test("presses through the menu to the pharmacist", async ({ session }) => {
    const walk = await walkPhoneTree(session, {
      name: "main",
      prompt: "For billing, press 1. For the pharmacy, press 2.",
      options: {
        "1": { name: "billing", prompt: "Billing, this is Sam." },
        "2": { name: "pharmacist", prompt: "Pharmacy, this is Dana. How can I help?" },
      },
    });
    expect(walk.reached).toBe("pharmacist");
    // A menu is not listening for words.
    for (const turn of walk.turns.slice(0, -1)) expect(turn.text).toBe("");
  });
});
```

The `outbound-call-agent` template walks a three-level tree this way.
`network: evalNetwork({ state, routes })` answers every tool, builtin and step
`fetch`, refusing the rest: `ctx.network`. `workflows` takes a client or
per-case factory: `ctx.workflowClient`. A failure prints the conversation.

**Read what a turn did through the DEF, not a schema you restate.**
`toolResultIn(turn.toolCalls, placeOrder)` is typed by the tool's `execute` and
throws naming what WAS called when the tool was not (exactly once;
`toolResultsIn` for several; `lastToolResultIn` for the settled last;
`toolArgsIn` for what the model asked). The def is the same one `run` takes — a
file's default export, a speaker's `tools` entry, `toolOf(agentDef, name)` for a
minted tool, `builtinTool(name)` for a builtin — and the readers take no name
string. `lastStateIn(session.events(), slot.projected)` is the frame the page
saw, typed by the projection and checked against its default keys, so a field
the view gained or lost fails here instead of being cast past;
`customEventsIn(events, "order.progress")` is typed by `ClientEventMap`. **An
agent that hands off to a run** declares its step HTTP on the suite —
`describeEval(agentDef, define, { steps: { routes, hold: "first" } })` — and the
harness installs the step fetch per case, parks the first answered request so
the run is observably in flight (`ctx.steps.held`, `release()`), and releases
and settles every run when the case ends. `evalRunOf(turn, def)` is the id of
the one run that turn started, read off the session's record of
`ctx.workflows.start` rather than parsed out of the tool's answer.

No eval can see anything below the audio boundary — when the agent decides you
stopped talking, barge-in, two sentences merging into one turn. Those need
`pnpm dev` and your own voice.
