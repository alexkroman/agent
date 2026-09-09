---
title: Evals
description: A test settles what your code does. An eval drives a real session and settles what the agent did.
---

A [test](/agent/build/testing/) settles what your code does. An eval settles
what the agent did: whether the *model* reached for the right tool, with the
arguments the caller actually said, and answered with what came back.

```sh
aai eval          # agent.eval.test.ts
```

An eval is an ordinary vitest file. Everything in it is real — your prompt, your
tools, the session's own event stream — except the microphone and the speaker.

A [background job](/agent/more/background-jobs/) has no session, so it is
covered separately, in [Workflow evals](/agent/build/workflow-evals/).

## Your first eval

```ts
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import agentDef from "virtual:aai/agent";
import { expect } from "vitest";

describeEval(agentDef, (test) => {
  test(
    "looks the order up before answering",
    async ({ session }) => {
      // `say()` hands back THAT turn — the reply, its tool calls, its events.
      const turn = await session.say("Where is order W1234?");

      expect(turn.toolCalls.map((call) => call.name)).toContain("look_up_order");
      expect(turn.text).toMatch(/shipped/i);
      expect(turn.completed).toBe(true);
    },
    // What a scripted model answers with when there is no key — see below.
    {
      stubReply: [
        { tool: "look_up_order", args: { order_id: "W1234" } },
        "Order W1234 shipped yesterday.",
      ],
    },
  );
});
```

`describeEval` opens a session for the case and closes it afterwards, so the
body is its assertions and nothing else.

**Import the agent from `virtual:aai/agent`, not from `./agent.ts`.** That is
the agent as `aai build` lowers it, with `tools/` discovered and
`system-prompt.md` applied. Get it wrong and the suite says so: a `stubReply`
naming a tool the agent does not declare fails at declaration, listing the
tools it does declare.

## What a turn hands back

| | |
| --- | --- |
| `turn.text` | The committed reply, joined — what the caller was told |
| `turn.toolCalls` | This turn's calls, in call order, each with its result |
| `turn.completed` | The reply ended on its own terms rather than being cancelled |
| `turn.events` | This turn's events, from the utterance to the terminator |
| `turn.errors` | The `error.reported` events this turn carried |

The session answers the same questions over the whole conversation:
`session.events()`, `session.toolCalls()`, and `session.said()` — which includes
the greeting, since the agent's opening line is a real turn. `session.id` is
what a tool reads as `ctx.sessionId`.

**Prefer the turn.** A claim about one reply should not be able to pass because
of a different one.

## Live model, or scripted

`describeEval` picks the model for you, and prints which it picked on every run.

| | Live | Scripted |
| --- | --- | --- |
| **You get it when** | a provider key is in the environment | there is no key |
| **Replies come from** | the real model | the case's `stubReply` |
| **A case costs** | tokens, and a few seconds | nothing |
| **A green run proves** | the agent chose the right tool and said the right thing, this once | the agent boots, `tools/` resolves, and a tool the script names really runs |

A scripted run is a wiring check. The agent is real, so a green one proves it
still starts and still has its tools — and it says nothing about what the agent
*chose*, because you wrote the choice.

A live run does speak to the choice, but it is a noisy instrument. One failure
is a question, not a verdict.

### Writing a stubReply

A bare string is a line the agent says. An array is a sequence — one entry per
model call, `{ tool, args }` for a call, the last line repeating:

```ts
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import agentDef from "virtual:aai/agent";
import { expect } from "vitest";

describeEval(agentDef, (test) => {
  test(
    "answers in its own voice",
    async ({ session }) => {
      const turn = await session.say("What is the capital of France?");
      expect(turn.text).toMatch(/paris/i);
    },
    { stubReply: "Paris is the capital of France." },
  );

  test(
    "refuses a size the kitchen does not make",
    async ({ session }) => {
      const turn = await session.say("Can I get a five foot pizza?");
      expect(turn.text).not.toMatch(/\bfive foot\b/i);
    },
    // No script can honestly stand in for a judgement, so skip this one
    // rather than let it pass against a reply you wrote yourself.
    { live: true },
  );
});
```

Choose a `stubReply` the case's own assertions still hold against. The point of
a scripted run is that the case really executes, and a stub the case then fails
against measures nothing.

### Cases that only make sense in one mode

| Marker | Skipped when | Reach for it when |
| --- | --- | --- |
| `{ live: true }` | scripted | no script can satisfy the claim: a tool the model has to choose for itself, a refusal, a judgement |
| `{ scripted: true }` | live | a competent model will not take the path — usually watching a guard refuse, since something has to call the gated tool before you can see it say no |

:::note[Keep one case each mode can run]
A suite where every case ends up skipped fails rather than reporting green. The
scripted half is what proves `agent.ts` still boots and its tools still resolve,
and it is the one check a pipeline with no key can make for free.
:::

### Forcing a mode

- `AAI_EVAL_STUB=1` forces the scripted model. That is what a pipeline wants, so
  it cannot start spending tokens the day a key reaches its environment.
- `AAI_REQUIRE_EVAL=1` is the opposite instruction: a missing credential becomes
  a failure instead of a quiet downgrade to a wiring check.

## Reading what happened

`@alexkroman1/aai-runtime/eval` publishes the readers. Use them over a
hand-written `find`, because **they throw when they have nothing to read**, and
name what actually happened. A `find` that misses answers `undefined`, and a
case asserting against `undefined` passes quietly.

```ts
import { errorsIn, toolNames, toolResultIn } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import agentDef from "virtual:aai/agent";
import { expect } from "vitest";
import { z } from "zod";

describeEval(agentDef, (test) => {
  test(
    "charges what the menu quotes",
    async ({ session }) => {
      const turn = await session.say("A large pepperoni, please.");

      // One tool, and the right one: quoting a price without adding the
      // pizza, or adding it twice, are both real findings.
      expect(toolNames(turn.toolCalls)).toEqual(["add_pizza"]);

      // Parsed, so a result that stopped matching fails naming the field.
      const priced = z.object({ total: z.string() });
      const result = toolResultIn(turn.toolCalls, "add_pizza", priced);
      expect(result.total).toBe("$18.00");

      // Over the whole session: a failure prints the errors themselves.
      expect(errorsIn(session.events())).toEqual([]);
    },
    {
      stubReply: [
        { tool: "add_pizza", args: { size: "large", toppings: ["pepperoni"] } },
        "One large pepperoni — that's $18.00.",
      ],
    },
  );
});
```

| Reader | Answers |
| --- | --- |
| `toolNames(calls)` | The names called, in call order |
| `toolArgsIn(calls, name, schema)` | What one call was given |
| `toolResultIn(calls, name, schema)` | What one call answered — `toolResultsIn` for several |
| `saidIn(events)` / `errorsIn(events)` | The replies / what the runtime said went wrong |
| `lastStateIn(events, schema)` / `statesIn` | What `syncState` pushed to the page |
| `expectToolBeforeSpeech(turn)` | It acted before it spoke |
| `describeTurn(turn)` / `describeToolCalls(calls)` | A message for an assertion that fails |

The rest — `runCodeIn`, `customEventsIn`, `openEvalSession` for a harness of
your own — is in the [SDK reference](/agent/reference/) under
`@alexkroman1/aai-runtime/eval`.

## More than one turn

`sayAll` says each line once the reply to the previous one has ended, so a
recorded tool order is the agent's and not the harness's:

```ts
import { toolResultIn, turnCalling } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import agentDef from "virtual:aai/agent";
import { expect } from "vitest";
import { z } from "zod";

describeEval(agentDef, (test) => {
  test(
    "stages the cancellation before it commits one",
    async ({ session }) => {
      const turns = await session.sayAll(["I want to cancel W1234", "Yes, go ahead."]);

      // The turn it staged in, whichever that turned out to be.
      const staging = turnCalling(turns, "cancel_order");
      const staged = z.object({ state: z.string() });
      const result = toolResultIn(staging.toolCalls, "cancel_order", staged);
      expect(result.state).toBe("pending");
    },
    {
      stubReply: [
        "Just to confirm — cancel order W1234?",
        { tool: "cancel_order", args: { order_id: "W1234" } },
        "Cancelled.",
      ],
    },
  );
});
```

**Assert about the turn a thing happened in, never about turn number two.** How
many turns an agent takes to get somewhere is the model's business, and it
varies between runs. A case pinned to an index is a flake with a misleading
name. `turnCalling` finds the turn; `toolCallsInTurns` flattens them all.

## What an eval cannot see

**Anything below the audio boundary**: when the agent decides you stopped
talking, what happens when you interrupt it, two sentences merging into one
turn. Those are properties of the microphone and the speaker the harness
replaced, so no assertion written here can say anything about one. `aai dev` and
your own voice are what check that.

**And one run is not a verdict.** A model is probabilistic, so the same code, on
the same cases, does not always score the same. Re-run before believing either
answer, and prefer a harder case to a weaker assertion.

## Next

- [Workflow evals](/agent/build/workflow-evals/) — the same job for a background
  job
- [Run it locally](/agent/deploy/local/) — `aai dev`, and the half no eval reaches
- [Publish](/agent/deploy/publish/) — ship it, and where your secrets go
