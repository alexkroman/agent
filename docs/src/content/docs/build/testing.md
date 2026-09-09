---
title: Testing
description: Tools are plain functions. aai test is vitest.
---

`aai test` runs `agent.test.ts` with vitest. Nothing about testing an agent is
special — a tool is a function, so you call it and assert on what comes back.

```sh
aai test          # agent.test.ts
aai test --all    # every spec in the project
```

If the project has other spec files that `aai test` did not run, it fails and
names them, so a green run never hides an untested file.

## Reaching a tool by the name the model uses

`toolRunner` gives you the same tool table a published agent runs, so a spec
calls a tool by the name the model calls it by:

```ts no-check
import { createToolContext, toolRunner } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

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

`createToolContext()` gives the tool a fake `ctx`: nothing it does escapes
the test. Pass overrides for whatever the tool actually uses — `ctx.generate`
and `ctx.delegate` reject until you do, naming themselves, so a tool that makes
a model call tells you rather than silently passing.

## Checking the agent itself

`expectDeployable` checks that an agent is actually shippable, and names what
is missing when it is not:

```ts no-check
import { expectDeployable } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";
import agentDef from "./agent.ts";

test("is deployable", () => {
  expect(() => expectDeployable(agentDef)).not.toThrow();
});
```

`aai build` runs your whole suite before it bundles. `aai publish` only
type-checks — run `aai build` first if you want the tests to gate a ship.

## Session state in a spec

Each `createToolContext()` gets its own detached slot store, so two contexts
are two callers:

```ts no-check
import { createToolContext, toolRunner } from "@alexkroman1/aai/testing";
import { expect } from "vitest";
import agentDef from "./agent.ts";

const run = toolRunner(agentDef);

const alice = createToolContext();
const bob = createToolContext();

await run("add_to_cart", { sku: "A1", qty: 1 }, alice);
expect(await run("list_cart", {}, bob)).toEqual([]);
```

## Driving the model

Tools that call `ctx.generate` take a stub rather than a live key:

```ts
import { createToolContext, stubGenerate } from "@alexkroman1/aai/testing";

// A bare string answers every call. Pass a table keyed by system prompt when
// the tool makes more than one. `calls` records what it was asked.
const { generate, calls } = stubGenerate("A short summary.");
const ctx = createToolContext({ generate });
```

Note the bare string. A record without an `object` key is read as a *route
table*, so `stubGenerate({ text: "…" })` type-checks and then rejects every
call at runtime.

The full set — `stubGateway`, guardrails, workflow contexts, upload fixtures,
run snapshots — is in the [SDK reference](/agent/reference/) under
`@alexkroman1/aai/testing`.

## Next

- [Run it locally](/agent/deploy/local/) — `aai dev`, then a plain Node process
- [Publish](/agent/deploy/publish/) — ship it, and where your secrets go
