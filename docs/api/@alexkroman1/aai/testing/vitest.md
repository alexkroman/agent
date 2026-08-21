# testing/vitest

The vitest-coupled half of the test helpers (`@alexkroman1/aai/testing/vitest`).

`sdk/testing.ts` is framework-agnostic on purpose — it returns fakes rather
than installing them, so it carries no test-runner dependency and a project
using another runner can still build a `ToolContext`. That is the right
default and it is not free: `stubGateway` (`@alexkroman1/aai/testing`)
hands back a `fetch`
implementation, and the INSTALLATION of it was then written out by hand in
every workflow template, four times, each with the same paragraph explaining
why the SDK had not done it.

So the coupling gets its own subpath instead of leaking into the main one.
`vitest` is an OPTIONAL peer dependency: importing this module is what pulls
it, importing `@alexkroman1/aai/testing` is not, and a project that never
writes a test resolves neither.

## Functions

### installStubGateway()

```ts
function installStubGateway(replies: string | readonly string[], opts?: StubGatewayOptions): StubGatewayCall[];
```

Install a fake LLM gateway as the global `fetch`, and return its call log.

The calls array is what a spec asserts on, and it is live — a reference taken
before the code under test runs holds every call made after.

**Lifetime is the caller's**, as it is for any `vi.stubGlobal`. This repo does
not set `unstubGlobals`, so a stub outlives its test unless the next one
replaces it; installing per test (which is the shape every caller wants
anyway) makes that moot, and `vi.unstubAllGlobals()` is the explicit undo.

#### Parameters

##### replies

`string` \| readonly `string`[]

Completion contents, in order; the last repeats — see
  `stubGateway` in `@alexkroman1/aai/testing`, which this installs.

##### opts?

[`StubGatewayOptions`](../testing.md#stubgatewayoptions)

#### Returns

[`StubGatewayCall`](../testing.md#stubgatewaycall)[]

#### Example

```ts no-check
// `no-check`: the step under test is in another file, which is the point.
import { installStubGateway } from "@alexkroman1/aai/testing/vitest";
import { expect, test } from "vitest";
import { summarize } from "./workflows/digest.ts";

test("summarize sends the article", async () => {
  const calls = installStubGateway('{"headline":"Otters use tools"}');
  await summarize("Otters use tools.");
  expect(calls[0]?.prompt).toContain("Otters use tools.");
});
```
