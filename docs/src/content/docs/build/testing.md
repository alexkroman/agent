---
title: Testing
description: Tools are plain functions. aai test is vitest.
---

A test settles what your code does. An [eval](/agent/build/evals/) settles what
the agent did. This page is the first one.

`aai test` runs every non-eval spec in the project with vitest. Nothing about
testing an agent is special: a tool is a function, so you call it and assert on
what comes back.

```sh
aai test          # every spec in the project
aai test --only   # agent.test.ts alone, for the fast inner loop
```

`--only` names the spec files it skipped rather than reporting a green run over
them, so a pass never hides an untested file. Behaviour evals are a separate
command, `aai eval`, and neither run reaches them.

## Reaching a tool by the name the model uses

`toolRunner` gives you the same tool table a published agent runs, so a spec
calls a tool by the name the model calls it by:

```ts
import agentDef from "virtual:aai/agent";
import { createToolContext, toolRunner } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";

const run = toolRunner(agentDef);

describe("get_weather", () => {
  test("returns the current conditions", async () => {
    const ctx = createToolContext();
    const out = await run("get_weather", { city: "Denver" }, ctx);
    expect(out).toMatchObject({
      current_condition: expect.anything(),
    });
  });
});
```

**Import the agent from `virtual:aai/agent`, not from `./agent.ts`.**

The reason: a tool is a *file*, so `agent.ts`'s own default export carries no
tools at all. `tools/get_weather.ts` becomes the tool `get_weather` when
`aai build` lowers the project, and `virtual:aai/agent` is that lowered agent —
your `tools/` directory discovered, your `system-prompt.md` applied.

Hand a runner the authored def instead and it says so on the spot. A runner over
zero tools can only ever be this mistake.

:::note[Not running vitest?]
`virtual:aai/agent` is a Vite module. On another runner, lower the agent
yourself with
`deployedAgent(def, { tools: import.meta.glob("./tools/*.ts", { eager: true }) })`.
:::

`createToolContext()` gives the tool a fake `ctx`, and nothing it does escapes
the test. Pass overrides for whatever the tool actually uses. `ctx.generate` and
`ctx.delegate` reject until you do, naming themselves, so a tool that makes a
model call tells you rather than silently passing.

## Checking the agent itself

`expectDeployable` checks that an agent is actually shippable, and names what
is missing when it is not:

```ts
import agentDef from "virtual:aai/agent";
import { expectDeployable } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";

test("is deployable", () => {
  expect(() => expectDeployable(agentDef)).not.toThrow();
});
```

`aai build` runs your whole suite before it bundles. `aai publish` only
type-checks, so run `aai build` first if you want the tests to gate a ship.

## Session state in a spec

Each `createToolContext()` gets its own detached slot store, so two contexts
are two callers:

```ts
import agentDef from "virtual:aai/agent";
import { createToolContext, toolRunner } from "@alexkroman1/aai/testing";
import { expect } from "vitest";

const run = toolRunner(agentDef);

const alice = createToolContext();
const bob = createToolContext();

await run("add_to_cart", { sku: "A1", qty: 1 }, alice);
expect(await run("list_cart", {}, bob)).toEqual([]);
```

## Driving the model

Tools that call `ctx.generate` take a stub rather than a live key. What you pass
depends on what the tool reads back:

| Pass | For |
| --- | --- |
| a bare string | a text answer |
| `{ object: … }` | structured output. Add `text` when the tool reads both |
| a record keyed by system prompt | a tool that plays more than one model role |

```ts
import { createToolContext } from "@alexkroman1/aai/testing";

const ctx = createToolContext({ generate: "A short summary." });
// `ctx.model.calls` records what the model was asked.
// `ctx.desk` is the same thing for `ctx.delegate`.
```

:::caution[`{ text: "…" }` on its own is a compile error]
A record with no `object` key is read as the third row of that table — a route
table keyed by system prompt — so `{ text: "…" }` means "one route named
`text`", which is a system prompt no tool carries. Pass the bare string for a
text answer, or `{ text, object }` when the tool reads both.
:::

`scriptedToolContext({ generate, delegate })` is the same call under a name that
says both seams are scripted. It hands back `{ ctx, model, desk }` if you would
rather read the two fakes by name.

The full set — `stubGateway`, guardrails, workflow contexts, upload fixtures,
run snapshots — is in the [SDK reference](/agent/reference/) under
`@alexkroman1/aai/testing`.

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
