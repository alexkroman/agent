# Tools, session state and conversation flow

Part of the aai authoring guide (start with the core guide, which has the
`tools/` directory rule and the minimal `tool()`). This file is the reference
for what a tool body can do: `ctx`, session state, `dialog()`/`procedure()`,
speakers and the roster, browser-run tools, the built-in tools, the helper
subpaths, persistence, and the speech helpers.

## `tool()` API

```ts no-check
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

const myTool = tool({
  description: string;           // shown to LLM — decides when to call
  inputSchema?: z.ZodObject;     // Zod schema (omit it for a no-argument tool)
  execute(args, ctx): unknown;   // sync or async
  ui?: { icon?, label? };        // how a page shows this tool's calls — served to the
                                 // client with the declaration, so no page-side map
  messages?: ToolMessagesInput;  // what to SAY while it runs (PIPELINE-TUNING.md)
});
```

`execute` may call `fetch` directly — tool code reaches external APIs the same
way in `aai dev` and deployed.

### `ctx` (ToolContext)

```ts no-check
ctx.env: Readonly<Partial<Record<string, string>>> // secrets from .env / aai secret put.
                                               // Partial: every read is `string | undefined`.
                                               // Use requireEnv(ctx, "KEY") to fail by NAME
                                               // instead of throwing a TypeError at the model.
ctx.workflows: WorkflowClient                  // start / signal / wake / find / stream a durable run
                                               // from a tool (see WORKFLOWS.md)
ctx.slots: SlotStore                           // where sessionSlot() keeps this session's state —
                                               // reach for the slot, never this (see "Session state")
ctx.messages: readonly Message[]               // conversation history [{role, content}]
ctx.sessionId: string                          // unique session ID
ctx.turn: number                               // user turns committed so far (1 during the first
                                               // reply) — "ask once, on turn three" is a compare,
                                               // not a counter kept in a slot
ctx.now(): number                              // epoch ms; ctx.random: a RandomSource. Both are
                                               // what Date.now()/Math.random() would answer, and
                                               // a spec pins them: createToolContext({ now, random })
ctx.send(event, data): void                    // push custom event to browser client (dropped over 64 KB JSON);
                                               // typed per event by ClientEventMap (below), else `unknown`
ctx.generate(opts): Promise<{ text, object? }> // one-shot LLM call (host-side)
                                               // with a `schema`, `object` is REQUIRED and typed by it
ctx.delegate(sub, opts): Promise<DelegateResult> // run a subagent — a whole tool loop with its own
                                               // context window (see "Speakers")
ctx.signal: AbortSignal                        // aborts on barge-in, reset, session stop, or this call's timeout
ctx.speech: SessionSpeech                      // say(text) verbatim LATER, or interrupt() — see "Saying
                                               // something from outside a turn" in PIPELINE-TUNING.md;
                                               // never await it in execute
```

**Declare an event's payload once** and every `ctx.send` of it is checked:

```ts
declare module "@alexkroman1/aai" {
  interface ClientEventMap { "order.progress": { done: number; total: number } }
}
```

**Pass `ctx.signal` to anything slow.** It is always present — no `?.` needed —
and forwarding it is what makes a tool stop work the caller has already
interrupted:

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

**Annotate the DECLARATION when the first write is somewhere the compiler cannot
follow** — inside a callback, or after the value has already been read. The
widening only tracks straight-line code in one scope, so in those cases the
declaration keeps its starting type:

```ts no-check
const items = [];                      // stays never[] if the only push is in a callback
let best = null;                       // stays null if the only assignment is in a callback
const [picks, set] = useState([]);     // never[] — useState's argument is read immediately

const items: Pick[] = [];              // ✅ annotate the DECLARATION
let best: Pick | null = null;          // ✅
const [picks, set] = useState<Pick[]>([]);  // ✅
```

Annotating the _use_ instead does not help — the declaration is still wrong, so
the next push just reports the next line.

### Session state

**A `sessionSlot` is the only way to keep state across a session's tool calls**,
and it is one declaration in a shared module. The default is a plain value
(cloned per session) or a factory; `sync: true` shows the slot's `view` to the
client with nothing declared on `agent()`:

```ts
// shared.ts — the one place the shape is written down.
import { sessionSlot } from "@alexkroman1/aai";

export type Incident = { id: string; status: "open" | "closed" };

export const incidentSlot = sessionSlot(
  "incidents",
  { items: [] as Incident[], open: 0 },
  {
    // Runs on EVERY store, the default included, so a derived field is never stale.
    after: (s) => {
      s.open = s.items.filter((i) => i.status === "open").length;
    },
    view: (s) => ({ open: s.open }),
    sync: true,
  },
);
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

Five rules, and each is an error rather than advice if you get it wrong:

- **`tool` reads, `updateTool` writes.** What a read is handed is FROZEN, so
  mutating it throws instead of quietly going nowhere.
- **A write is SYNCHRONOUS.** The value you mutate is stored the moment your
  body returns, so an `updateTool` body may not `await`. The await goes in
  `prepare`, which runs on the frozen value first and hands what it produced to
  `execute` as the THIRD argument, ahead of `ctx`; `require` is the precondition
  (`ToolFailure | undefined` off the frozen value), checked before `prepare` and
  again right before the window; `report` completes the result from what was
  actually STORED, after `after` and `caps`:

  ```ts
  import { sessionSlot, toolFailure } from "@alexkroman1/aai";
  import { z } from "zod";

  const cartSlot = sessionSlot("cart", { items: [] as string[], total: 0 });

  export default cartSlot.updateTool({
    description: "Price the cart",
    inputSchema: z.object({ sku: z.string() }),
    require: (cart) => (cart.items.length === 0 ? toolFailure("The cart is empty.") : undefined),
    prepare: async ({ sku }, _cart, ctx) =>
      Number((await ctx.generate({ prompt: `price ${sku}` })).text),
    execute: (_args, cart, price) => {
      cart.total = price;
      return { total: cart.total };
    },
    report: (stored, partial) => ({ ...partial, items: stored.items.length }),
  });
  ```

  A `ToolFailure` from `require` or `prepare` is the tool's whole result and
  opens no window; one RETURNED from `execute`, `report` or `commit` stores
  nothing, like a throw — a body that mutated the draft and then declined has
  declined. From inside a plain `tool()` the same shape is
  `slot.transact(ctx, { require?, prepare, commit })`.

- **Report from the stored value, never the draft.** A count read off the draft
  is the count before a cap trimmed it, and a field `after` computes is not on
  the draft when the body returns — `report` is the one reading that cannot
  disagree with the next `get`.
- **Hold plain data.** Objects, arrays, strings, numbers, booleans and null. A
  `Map`, a `Set`, a `Date`, a function or a class instance is refused with the
  slot and the field named — at declaration for a plain default, on the store
  otherwise — because none of them survives being stored.
- **State is STORED on the platform**, so a crash or a redeploy no longer loses
  it — the platform keeps a session's slots on its own database and there is
  nothing to enable. Under `aai dev` it lives in memory for the life of the
  process unless you set a `DATABASE_URL` in `.env`. You write the same code
  either way; that is the reason for the rules above.

There is nothing to declare on `agent()` — the slot owns its default, and
`sync: true` registers its projection (the slot must be declared in a module
`agent.ts` imports, such as `shared.ts`); `agent({ syncState })` is not a field.
**A SEEDED slot declares `empty`** —
`sessionSlot("catalog", loadSeed, { view, empty: () => ({ items: [] }) })` — so
the frame a page renders before its first push is the empty shape rather than
the seed shipped to the browser. `SlotValueOf<typeof slot>` and
`SlotDraftOf<typeof slot>` type a helper's parameter as the frozen value or the
draft without restating the shape. `slot.snapshot(ctx)` returns a mutable deep
copy of the value — what a spec hands `slot.set`, instead of
`structuredClone(slot.get(ctx))` and a cast.

### A sentence the model should follow THIS time — `withInstruction`

A tool often knows, once it has the answer, how the model should treat it: "read
the plan back in one breath", "ask which of these two before going on".
`withInstruction(value, "…")` rides that sentence on the result under a reserved
key; the model reads it beside the result, and the page, the history and a later
tool read the value alone. It works on a `toolFailure(...)` too. **Per OUTCOME,
not per tool**: a sentence that is the same on every call belongs in
`description`.

```ts
import { tool, withInstruction } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Draft the day's plan",
  inputSchema: z.object({ goals: z.array(z.string()) }),
  execute: ({ goals }) =>
    withInstruction(
      { steps: goals.map((goal, i) => `${i + 1}. ${goal}`) },
      "Read the plan back in one breath, then ask whether to start.",
    ),
});
```

**`verbatimModuleSyntax` applies to every type you import** — `ToolContext`,
`ToolDef`, `Message`, provider types. A plain `import { ToolContext }` fails;
use `import type { ToolContext }`, or `import { agent, type ToolContext }` to
combine with value imports.

`ctx.generate({ prompt, system?, llm?, schema?, temperature?, maxOutputTokens? })`
runs one LLM generation on the host. It defaults to the agent's pipeline `llm`;
pass an `llm` descriptor (from `@alexkroman1/aai/llm`) or a model-id string to
use another provider whose API key is in the agent's secrets — that's also how
S2S agents use it. Pass a Zod schema as `schema` for typed structured output
(`generateObject`-style): the result's `object` carries the parsed, typed value.
A plain JSON Schema object also works.

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

A tool declared with `checkout.tool({ when: "paying", send: … })` is REFUSED
outside the states `when` names, and the refusal reaches the model as a
`ToolFailure` it can recover from — the gate is enforced at EXECUTION rather
than hoped for in a prompt. The states and events are inferred from the spec, so
a misspelled `send` is a compile error. **A slot tool takes the same gate**:
`orderSlot.updateTool({ dialog: checkout, when, send, … })` runs the refusal,
then `require`/`prepare`, the window, `report`, and the transition — nothing is
sent on a `ToolFailure`.

```ts
import { dialog, sessionSlot } from "@alexkroman1/aai";
import { z } from "zod";

const scratch = sessionSlot("scratch", { notes: [] as string[] });
const orderSlot = sessionSlot("order", { items: [] as string[], paid: false });

const checkout = dialog("checkout", {
  initial: "collecting",
  states: {
    collecting: { instruction: "Take the order.", on: { CONFIRMED: "paying" } },
    paying: {
      instruction: "Take payment with pay. Do not add items now.",
      // Runs inside the move, when the dialog ENTERS the state: may write other
      // slots, never this dialog. Not on a resume, a fresh session or a reset.
      onEnter: (ctx) => scratch.reset(ctx),
      on: { PAID: "done", DECLINED: "collecting" },
    },
    done: { instruction: "Read back the order number and say goodbye." },
  },
});

export default orderSlot.updateTool({
  description: "Take payment",
  dialog: checkout,
  when: "paying",
  inputSchema: z.object({ approved: z.boolean() }),
  execute: ({ approved }, order) => {
    order.paid = approved;
    return { paid: approved, next: approved ? ("PAID" as const) : ("DECLINED" as const) };
  },
  // A field holding the event type (or undefined to stay put). The function
  // form `sendFrom: (result) => …` and the second argument
  // `checkout.tool(def, { sendFrom })` are the same transition; write any of
  // them in any order.
  sendFrom: "next",
});
```

**`when` is optional**: omitted, the tool is legal in every state, never
refuses, and still answers the `{ ...position, result }` envelope and honours
`send`/`sendFrom` — the shape of a tool that reports where the conversation is,
or restarts it (`reset: true` restarts the dialog once `require`/`prepare` have
passed, right before the body; its `send` goes to the restarted dialog). An
event the current state does not declare is a no-op, not an error.
`emergency-dispatch-agent` and `tabletop-rpg-agent` are the worked examples.

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
if it stops without reaching a final state — which makes "we ran out of
attempts" a state you declare and handle rather than an error. Options are
`ProcedureRunOptions`; the machine is an XState machine, and `xstate` is already
an SDK dependency. `technical-support-agent` is the worked example.

### Speakers (`speaker()`, `ctx.delegate`, `roster()`)

`ctx.generate` is ONE prompt. When answering takes an unknown number of tool
calls the conversation has no reason to carry, delegate to a **speaker** off the
line: a second tool loop with its own prompt, model, tools and — the whole point
— its own context window.

```ts
import { speaker, tool } from "@alexkroman1/aai";
import { z } from "zod";

const researcher = speaker({
  name: "researcher",
  systemPrompt: "Research the task with the tools you have.",
  expectedOutput: "A self-contained summary — the only thing the caller sees.",
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

Four rules, each the way a delegation disappoints when skipped: you receive its
FINAL message, so declare `expectedOutput`; its context is isolated, so `task`
must be a complete brief; `maxSteps` bounds the loop, and a capped run is asked
for its answer with tools withheld; and say you are looking it up before you
call. It may name its own `llm` and `tools` map; **delegation is one level
deep**. In tests, `stubDelegate` (`@alexkroman1/aai-runtime/testing`) fakes it
by name.

When the SPEAKER has to change — triage verifies the caller, billing takes over
with its own instructions and tools, one history — mark them `speaks: true` on a
`roster()`; the first speaking entry answers the call.

```ts
import { agent, speaker, roster } from "@alexkroman1/aai";

const triage = speaker({
  name: "triage",
  speaks: true,
  description: "Answers the phone and picks the desk",
  systemPrompt: "Bill or fault? Find out, then hand off.",
});
const billing = speaker({
  name: "billing",
  speaks: true,
  description: "Invoices, payments and refunds",
  systemPrompt: "You are the billing desk.",
});
export const desk = roster([triage, billing]);

export default agent({ name: "Front Desk", roster: desk });
```

One roster mints `handoff` over its speaking entries and `delegate` over the
rest, each described by the entries' `description`. A tool body hands off with
`desk.handoff(ctx, billing, { note })` and returns the result; the turn goes on
as the new speaker. Names are INFERRED: `desk.handoff(ctx, "biling")` does not
compile. A speaking entry's `tools` refuse while another speaks, naming who is
and how to hand off. `tools/` and `system-prompt.md` hold under every speaker; a
dialog state pins one with `persona`. Examples: `front-desk-agent`,
`topic-briefing-agent`.

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
`tools` field at all — see "A file in `tools/` IS a tool" in the core guide.

**Calling the network builtins from your own tool code.** `web_search`,
`visit_webpage` and `fetch_json` are declared to the MODEL — the LLM calls them,
and they are not on `ctx`. When your own `execute` needs one, import it:

```ts no-check
import { fetchJson, visitWebpage, webSearch } from "@alexkroman1/aai/tools";

execute: async ({ city }) => await fetchJson(`https://api.example.com/${city}`),
// Reading fields off the result needs no cast. Pass a shape when you want
// it checked: `await fetchJson<Forecast>(url)`.
```

Same implementations the builtins use, so you get URL screening, credential-
header stripping, size caps and timeouts rather than a bare `fetch`. Plain
`fetch` still works when you want none of that. There is no callable `run_code`:
it exists to run code the model wrote, and tool code that wants to compute
something can just compute it.

**But prefer the BUILTIN when the model should decide.** These two are not
interchangeable:

- If the agent's job is to search or browse — a research assistant, anything
  that follows a link the user mentions — declare
  `builtinTools: ["web_search", "visit_webpage"]` and let the model call them.
  It can then search several times with different queries, or read one specific
  page, as the conversation needs.
- Import from `/tools` when YOUR tool's own logic needs a fetch: a currency tool
  hitting one known API, a price checker with a fixed endpoint.

Wrapping `webSearch` in a single custom tool is the mistake to avoid — it
replaces "the model searches as needed" with one fixed query-and-summarize
pipeline, and no amount of prompting gets the flexibility back.

**`inputSchema` is a Zod object, or absent.** The field itself is optional, but
its VALUE must be a plain `z.object(...)` — so all of these are type errors:

```ts no-check
inputSchema: z.undefined(),                // ✗ ZodUndefined
inputSchema: z.void(),                     // ✗
inputSchema: z.object({ q: z.string() }).optional(),  // ✗ ZodOptional
```

For a tool with no arguments write `tool({ description, execute })` — omit the
field; `args` is then `Record<string, never>`. To make an individual argument
optional, put `.optional()` on the FIELD, never on the object:
`z.object({ notes: z.string().optional() })`.

**Do not annotate `execute`'s return type.** Nothing needs it — the result is
serialized to the model either way — and it reliably breaks the moment the tool
also returns an error, because `Promise<DrugInfo>` does not accept
`{ error: "not found" }`. Every such annotation eventually costs a build round
to widen into a union. Let it infer.

### A tool the BROWSER runs — `clientTool()`

`ctx.send` is fire-and-forget: a tool cannot wait for the page. When the answer
only the browser has (its location, what is on screen, a click on "Confirm", a
picked file) IS the tool's result, declare it a `clientTool`. It has no
`execute`: the page's `useClientTool(name, handler)` runs it, and whatever the
handler returns is the result the model reads. A throw in the handler is a
failed call the model is told about.

```ts
// tools/get_location.ts
import { clientTool } from "@alexkroman1/aai";
import { z } from "zod";

export default clientTool({
  description: "Get the caller's location from their browser",
  inputSchema: z.object({}),
  // Waits on a PERSON (the permission prompt), so longer than the 30 s default.
  timeoutMs: 60_000,
});
```

```tsx
// client.tsx — render <LocationTool /> anywhere inside the mounted tree
import { useClientTool } from "@alexkroman1/aai-ui";

export function LocationTool() {
  useClientTool(
    "get_location",
    () =>
      new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
          (err) => reject(new Error(err.message)),
        ),
      ),
  );
  return null;
}
```

- **Only a browser session can answer it.** On a phone call, in a text agent or
  a subagent the call fails naming why — give such an agent a server path.
- **No page answer within `timeoutMs` fails the call**, as does a barge-in.
- **Never send a secret the model should not see through one** — the result goes
  into the conversation like any other tool result. Return the token, the last
  four digits, the decision — not the card number.

### A tool built by a factory still gets its own file

The `tools/` rules (file name = tool name, default export, flat directory) are
in the core guide. A tool that closes over module-local state, or one built by
your own wrapper, still gets its own file — the file names the instance and the
factory lives beside it:

```ts no-check
// tools/to_hotel_assistant.ts
import { delegationTool } from "../routing.ts";

export default delegationTool("hotel");
```

Why discovery rather than a map: the map was 62 lines across the shipped
templates whose entire content was `snake_case_name: camelCaseImport`, and
forgetting one line was **silent** — the file compiled, every check passed, and
the tool simply never reached the model.

### Starting a run from a tool

`ctx.workflows.start(def, input)` starts a durable run and resolves its id as
soon as the run EXISTS; the turn answers while it works (`WORKFLOWS.md` has the
body side). Its `key` defaults to `"session"` — the session id — so a later
turn, or a later CALL from the same session, reads it back with
`ctx.workflows.latest(def)` (the newest run) or `live(def)` (the newest one
still in flight) with no key spelled on either side. **Declare the status tools
rather than writing them**:
`builtinTools: ["think", "workflow_status", "workflow_progress", "workflow_cancel"]`
gives the model those three over every declared workflow, keyed the same way;
`describeRun(run)` and `cancelNote` on the workflow def supply the sentences
they speak. A run parked on `ctx.waitForSignal("approval")` is answered from a
tool with `ctx.workflows.signalRun(def, "session", "approval", payload)` — the
token is derived on both sides, and a signal that lands before the body reaches
its wait is held for it.

## Built-in tools

Enable via `builtinTools` in `agent()`. **Omitted, none is on**: every built-in,
`think` included, is opt-in by name.

| Tool              | Description                                                                                                                 | Params                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `web_search`      | Search the web (DuckDuckGo), no key                                                                                         | `query`, `max_results?` (default 5)   |
| `visit_webpage`   | Fetch URL to plain text                                                                                                     | `url`                                 |
| `get_page_design` | Fetch URL's raw HTML + CSS to study/mimic a site's design                                                                   | `url`                                 |
| `fetch_json`      | HTTP GET a JSON API                                                                                                         | `url`, `headers?`                     |
| `run_code`        | Execute JS in the agent's sandbox — same authority as the agent's own tool code, output is what it logs (5s timeout)        | `code`                                |
| `think`           | Private reasoning scratchpad, no side effects                                                                               | `thought`                             |
| `remember`        | Save a confirmed fact to session notes                                                                                      | `key`, `value`                        |
| `recall`          | Read session notes saved with `remember`                                                                                    | `key?`                                |
| `calculate`       | Safe arithmetic evaluator, no code execution                                                                                | `expression`                          |
| `open_meteo`      | Weather + forecast (Open-Meteo), no key                                                                                     | `location`, `days?`, `units?`         |
| `brave_search`    | Brave Search API — `BRAVE_API_KEY`                                                                                          | `query`, `max_results?`, `freshness?` |
| `google_places`   | Google Places: address, phone, hours, rating — `GOOGLE_PLACES_API_KEY`                                                      | `query`, `max_results?`, `open_now?`  |
| `text_me`         | Text the owner (Textbelt) — `TEXTBELT_KEY`, `SMS_TO_PHONE`; a client's `?phone=` only if in `SMS_ALLOWED_PHONES` (`*`: any) | `message`, `url?`                     |

A keyed builtin reads its key from the agent env; list it in `requiredEnv`.

**Every builtin here is a tool the MODEL calls, not a function your code can
call** — there is no `fetch_json()` for a tool's `execute`. So:

- **Declare the builtin** (`builtinTools: ["fetch_json"]`) when the MODEL should
  decide the URL and read the JSON — lookups you cannot enumerate.
- **Write your own tool** whose `execute` calls `fetch` when YOU own the URL and
  the shape — a specific endpoint, auth, or a reshaped response.

Network builtins are SSRF-screened outside a container (private/loopback
blocked). Your own tool code has open egress either way.

## Calling an external API from your own tool code

`fetch` inside a tool's `execute` works directly — no declaration needed,
identical under `aai dev` and deployed. Right when your code owns the URL.

## Small helpers — `@alexkroman1/aai/utils`

Zero-dependency helpers a tool body, a step or a client may reach for, so the
same three lines are not rewritten per template. Import from `/utils`, which is
safe from a `workflows/*.ts` module and from a browser bundle:

| Helper                                                  | For                                                                                                                                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `errorMessage(err)`, `errorDetail(err)`                 | Turning an unknown `catch` value into a sentence for the model or the log                                                                                                                                      |
| `responseErrorMessage(res, label)`                      | The same for a non-2xx `Response`, preferring a JSON `error` field over the bare status                                                                                                                        |
| `safeJsonParse(text)`                                   | A parse that answers `undefined` instead of throwing                                                                                                                                                           |
| `formatBytes`, `formatDuration`, `countWords`, `plural` | Narration. Each returns ONE fixed shape, so a step's progress line and the page rendering the same run cannot disagree — they did, one template printing `1:04:09` from its workflow and `64:09` from its page |
| `pushCapped(list, item, max)`                           | An append that keeps the last N, for a log a session accumulates                                                                                                                                               |
| `isRecord(x)`, `omitUndefined(obj)`                     | The object guard and the spread-free way to drop undefined fields                                                                                                                                              |
| `decodeHtmlEntities(text)`                              | Six entities, no dependency. Enough for a `client.tsx`; for a page or a feed see `/html` below                                                                                                                 |
| `createKeyedLock()` / `withLock(lock, key, work)`       | Serializing async work per key                                                                                                                                                                                 |

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

**Reach for this rather than writing the patterns.** Both are cheap to get wrong
in ways that only show up on real pages: `<[^>]+>` cuts a tag whose attribute
contains a `>`, `<script[^>]*>[\s\S]*?<\/script>` leaves the whole script in
your prompt when the page was truncated mid-tag, and `indexOf("<title>")` finds
an entry's title rather than a channel's. The `link-digest-workflow` and
`podcast-digest-workflow` templates each shipped one before this subpath
existed.

## Persisting data — bring your own client

**There is no `ctx.db`.** The platform provisions no database and hands tool
code none.

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

Add the driver to your project's `package.json` and the URL with
`aai secret put DATABASE_URL …` (or in `.env` under `aai dev`). Nothing here is
privileged — an HTTP API, a provider SDK or a hosted KV works the same way.

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

## Speech goes both ways — `spokenMoney`, `resolveOne`, `isoDate`

**Speech goes both ways, and `@alexkroman1/aai` publishes both conversions.**
Inbound: `spokenDigits("four one five")` is `"415"`,
`spokenOrdinal("the third one")` is `3`, and
`resolveOne(candidates, spoken, opts)` picks the one item a phrase meant —
answering a `ToolFailure` when nothing matches or several do, the case a
hand-written `.find()` gets wrong.

Outbound: an engine handed `$240.50` may read "dollar sign two hundred forty
point five zero" — right text, wrong call. Render the words first:
`spokenMoney(240.5)` is `"240 dollars and 50 cents"`, `spokenDate("2026-06-08")`
is `"Monday, June 8"`, `spokenTime("18:30")` is `"6:30 PM"`. `mintCode("HTL")`
mints a reference with no `0`/`O`, `1`/`I` or `L` in it — what comes back wrong
read aloud.

**Declare a date or a time on the SCHEMA.** `isoDate("the arrival date")` and
`clockTime("the pickup time")` are zod fields, so the rule reaches the model
before it calls rather than as a refusal after. `isIsoDate` refuses
`2026-02-30`; `addDays`/`daysBetween` compute in UTC — never turn a `YYYY-MM-DD`
into a `Date` in local time.

**Never call `Math.random()` or `Date.now()` in a tool** — use `ctx.random` and
`ctx.now()`, which a test can pin, so a dice roll, a minted code or an
opening-hours check is something a spec can assert. `randomInt`, `pickOne` and
`shuffled` take the source last. A WORKFLOW body wants its own journaled
`ctx.random()` / `ctx.now()` instead.
