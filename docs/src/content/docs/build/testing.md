---
title: Testing
description: Tools are plain functions. aai test is vitest.
---

A test settles what your code does. An [eval](/agent/build/evals/) settles what
the agent did. This page is the first one.

```sh
aai test
```

`aai test` runs every spec in the project with vitest — everything but the
evals, which have their own command. A tool is a plain function, so a spec
calls it and asserts on what comes back. No model, no session, no server.

## Your first test

`toolRunner` reaches a tool by the name the model calls it by:

```ts
import agentDef from "virtual:aai/agent";
import { toolRunner } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";

const run = toolRunner(agentDef);

test("get_weather answers for the city it was given", async () => {
  const out = await run("get_weather", { city: "Denver" });
  expect(out).toMatchObject({ city: "Denver" });
});
```

That is a complete spec. Put it in `agent.test.ts` and run `aai test`.

**Assert on what the tool returns, not on what the API it called returned.**
The scaffold's `get_weather` narrows wttr.in's response to
`{ city, tempF, conditions }` before handing it back, so those are the fields a
spec names — see [Tools](/agent/build/tools/).

## Import the agent from `virtual:aai/agent`

A tool is a *file*, so `agent.ts`'s own default export carries no tools at all.
`tools/get_weather.ts` becomes the tool `get_weather` when `aai build` lowers
the project, and `virtual:aai/agent` is that lowered agent — your `tools/`
directory discovered, your `system-prompt.md` applied.

Hand a runner the authored def instead and it says so on the spot: a runner
over zero tools can only ever be this mistake.

:::note[Not running vitest?]
`virtual:aai/agent` is a Vite module. On another runner, lower the agent
yourself with
`deployedAgent(def, { tools: import.meta.glob("./tools/*.ts", { eager: true }) })`.
:::

## Checking the agent is shippable

`expectDeployable` checks that an agent is actually deployable, and names what
is missing when it is not:

```ts
import agentDef from "virtual:aai/agent";
import { expectDeployable } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";

test("is deployable", () => {
  expect(() => expectDeployable(agentDef)).not.toThrow();
});
```

## Giving a tool a context

Each call above got a fresh `ctx` of its own. Pass one explicitly when a tool
needs something from it, or when two calls are supposed to share a session:

```ts
import agentDef from "virtual:aai/agent";
import { createToolContext, toolRunner } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";

const run = toolRunner(agentDef);

test("the cart belongs to one caller", async () => {
  const alice = createToolContext();
  const bob = createToolContext();

  await run("add_to_cart", { sku: "A1", qty: 1 }, alice);
  expect(await run("list_cart", bob)).toEqual([]);
});
```

`createToolContext()` is a fake `ctx`, and nothing it does escapes the test. It
gets its own detached slot store, so two contexts are two callers. Pass
overrides for whatever the tool actually uses. `ctx.generate` and `ctx.delegate`
reject until you do, naming themselves, so a tool that makes a model call tells
you rather than silently passing.

## Stubbing the model

Tools that call `ctx.generate` take a stub rather than a live key:

```ts
import { createToolContext } from "@alexkroman1/aai/testing";

const ctx = createToolContext({ generate: "A short summary." });
// `ctx.model.calls` records what the model was asked.
// `ctx.desk` is the same thing for `ctx.delegate`.
```

What you pass depends on what the tool reads back:

| Pass | For |
| --- | --- |
| a bare string | a text answer |
| `{ object: … }` | structured output. Add `text` when the tool reads both |
| a record keyed by system prompt | a tool that plays more than one model role |

:::caution[Don't wrap a text answer in `{ text: "…" }`]
It does not compile, but the compiler's advice is misleading: it reports that
`object` is missing and invites you to add one. Adding `object` is the wrong
fix if all you wanted was text. Pass the bare string instead, and reach for
`{ text, object }` only when the tool really reads both.
:::

`scriptedToolContext({ generate, delegate })` is the same call under a name that
says both seams are scripted. It hands back `{ ctx, model, desk }` if you would
rather read the two fakes by name.

The full set — `stubGateway`, guardrails, workflow contexts, upload fixtures,
run snapshots — is in the [SDK reference](/agent/reference/) under
`@alexkroman1/aai/testing`.

## Running the suite

```sh
aai test          # every spec in the project
aai test --only   # agent.test.ts alone, for the fast inner loop
```

`--only` names the spec files it skipped rather than reporting a green run over
them, so a pass never hides an untested file.

`aai build` runs your whole suite before it bundles. `aai publish` only
type-checks, so run `aai build` first if you want the tests to gate a ship.

Behaviour evals are a separate command, `aai eval`, and neither run above
reaches them.

## What a test cannot settle

Everything here runs your code without a model. That settles what a tool does
with the arguments it is given. It says nothing about whether the agent reached
for that tool, with the arguments the caller actually said.

For that there is a second command:

```sh
aai eval          # agent.eval.test.ts
```

An eval drives a real session — your prompt, your tools, the real event stream,
with only the microphone and the speaker faked — and asserts on what the agent
did. See [Evals](/agent/build/evals/).

## Next

- [Evals](/agent/build/evals/) — driving a real session, and what a green run means
- [Run it locally](/agent/deploy/local/) — `aai dev`, then a plain Node process
- [Publish](/agent/deploy/publish/) — ship it, and where your secrets go
