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

A narrowed run does not report itself as a pass: if the project has spec files
the run did not cover, it fails and names them, rather than printing a green
line that says nothing about `tools/*.test.ts`.

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

`createToolContext()` builds a `ToolContext` with inert defaults — a recording
`ctx.send`, a detached slot store, a stub `ctx.generate`. Pass overrides for
whatever the tool under test actually uses.

## Checking the agent itself

`expectDeployable` asserts the three things every agent owes — the config
converts, the platform can name it, and every stage its mode needs is filled —
and fails naming the one that went:

```ts no-check
import { expectDeployable } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";
import agentDef from "./agent.ts";

test("is deployable", () => {
  expect(() => expectDeployable(agentDef)).not.toThrow();
});
```

`aai build` runs your tests before it bundles, so this is also what stops a
broken config reaching a deploy.

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

// One reply for every call, or a table keyed by the system prompt when the
// tool makes more than one. `calls` records what it was asked.
const { generate, calls } = stubGenerate({ text: "A short summary." });
const ctx = createToolContext({ generate });
```

The full set — `stubGateway`, guardrails, workflow contexts, upload fixtures,
run snapshots — is in the [SDK reference](/agent/reference/) under
`@alexkroman1/aai/testing`.
