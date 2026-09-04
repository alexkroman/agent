# @alexkroman1/aai-ui

The browser client for aai agents: React 19 hooks and components over a
framework-agnostic session core (WebSocket + microphone + playback).

```sh
npm i @alexkroman1/aai-ui react react-dom
```

Every agent gets this UI for free — `aai dev` and deployed agents serve a
default client built from this package. Install it directly when the agent
has its own `client.tsx`.

## UI integration

The hooks here are what a page reads an agent with: the live call, the state
the agent projects, the tool calls as they run, and the durable runs it
started. **There is no route to write.** The agent server already serves the
session socket and the workflow HTTP API, so a component talks to a live
agent with no glue file in between — a client is one `client.tsx` calling one
mount.

**Two front doors, two mounts.** A voice agent's page calls `mountClient()` and
talks to a live session. A workflow app's page (`workflowApp()`, or
`agent({ page: "static" })`) calls `mountPage()` and talks to the workflow HTTP
API — no session, no socket, no microphone. Both are still `client.tsx`,
still React, still the same theme tokens.

### Agent `agent.ts`

The session's state lives in a slot, and `syncState` is what the browser sees
— pushed after every tool call, so the client never rebuilds it from events:

```ts
import { agent, sessionSlot } from "@alexkroman1/aai";

const desk = sessionSlot("desk", () => ({ symbols: [] as string[] }));

export default agent({
  name: "Market Desk",
  systemPrompt: "You look up quotes and keep the caller's watchlist.",
  syncState: desk.projection((state) => ({ symbols: state.symbols })),
});
```

### Tool `tools/get_quote.ts`

A tool is a **file**, named by its own filename. Nothing registers it, and
`agent()` takes no `tools` field:

```ts
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Look up the latest price for one ticker symbol",
  inputSchema: z.object({ symbol: z.string() }),
  execute: async ({ symbol }, ctx) => {
    const res = await fetch(`https://api.example.com/quote/${symbol}`, {
      headers: { authorization: `Bearer ${ctx.env.QUOTES_API_KEY}` },
      signal: ctx.signal,
    });
    return (await res.json()) as { symbol: string; price: number };
  },
});
```

### UI component for a tool `quote-card.tsx`

`useToolResult` fires once per settled call of one named tool, with the
result already parsed. A component that mounts late still receives the
results of calls that finished before it — a result is a value the UI is
driven from, not a moment:

```tsx
import { useState } from "react";
import { useToolResult } from "@alexkroman1/aai-ui";

type Quote = { symbol: string; price: number };

export default function QuoteCard() {
  const [quote, setQuote] = useState<Quote>();
  useToolResult<Quote>("get_quote", (result) => setQuote(result));

  if (!quote) return null;
  return (
    <p>
      {quote.symbol} — {quote.price.toFixed(2)}
    </p>
  );
}
```

`useToolCallStart` is the same hook for the other end of the call — the
pending invocation and its arguments, for a spinner rather than a value.
Either one takes the tool's own shape as a type argument, derived from the
tool module by a **type-only** import that is erased and so pulls no server
code into the bundle: `useToolResult<InferToolOutput<typeof getQuote>>(…)`
for the result, `useToolCallStart<InferToolInput<typeof getQuote>>(…)` for
the arguments.

### Client `client.tsx`

`mountClient()` mounts the default chat shell — start screen, transcript,
controls — with your components in it. `sidebar` takes the COMPONENT, not an
element:

```tsx no-check
import "@alexkroman1/aai-ui/styles.css";
import { mountClient, useAgentState } from "@alexkroman1/aai-ui";
import QuoteCard from "./quote-card.tsx";

function Watchlist() {
  // Whatever `syncState` projected, live. Null until the first push, which is
  // a moment the UI has to render.
  const desk = useAgentState<{ symbols: string[] }>();
  return (
    <div>
      <QuoteCard />
      {desk?.symbols.map((symbol) => <div key={symbol}>{symbol}</div>)}
    </div>
  );
}

mountClient({
  name: "Market Desk",
  sidebar: Watchlist,
  // Icon and label per tool, for the transcript's tool rows.
  tools: { get_quote: { icon: "📈", label: "Fetching quote" } },
  theme: { primary: "#2f9e44" },
});
```

The type argument above restates a shape the agent already knows. Move the
slot and its projection into a `shared.ts` both ends import, pass the
projection itself — `useAgentState(deskProjection)` — and the state is typed
from the projection and the pre-first-push frame derived from it, so there is
nothing to restate and no branch for the first render.

Pass `component` instead of `sidebar` to replace the whole shell. It renders
inside the same providers, so every hook here works in it unchanged.

## A workflow app

`mountPage()` mounts a form over the agent's workflows and installs no session.
`<WorkflowFields>` renders one control per scalar property of the workflow's
own input schema, so adding a field to the schema adds it to the page:

```tsx
import "@alexkroman1/aai-ui/styles.css";
import {
  Form,
  mountPage,
  SubmitButton,
  UploadProgressBar,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowProgress,
} from "@alexkroman1/aai-ui";

function App() {
  const { submitForm, run, pending, upload, error } =
    useWorkflowSubmit("digest");
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <Form onSubmit={submitForm} error={error}>
        <WorkflowFields workflow="digest" />
        <SubmitButton pending={pending}>Summarize</SubmitButton>
      </Form>
      {/* The upload is its own wait: the run does not exist until the bytes
          are in, so nothing else on the page can describe it. */}
      <UploadProgressBar upload={upload} />
      {/* What the run has SAID, from `stepReport()` in its steps. */}
      <WorkflowProgress runId={run?.runId} />
      {run?.status === "completed" && <pre>{JSON.stringify(run.output)}</pre>}
    </main>
  );
}

mountPage({ name: "Digest", component: App });
```

Naming the workflow's def — `useWorkflowSubmit<typeof digest>("digest")`, off
a **type-only** import of `agent.ts` — is what makes `submit()` take the
declared input and `run.status === "completed"` narrow to a typed
`run.output`. The import is erased, so it pulls no server code into the
bundle.

## What is in the package

The [API reference](https://alexkroman.github.io/agent/) groups by TypeScript
kind. This is the same surface grouped by what it is for.

**Mounts** — `mountClient()`, `mountPage()`, the config each takes and the handle each
returns (`ClientConfig`, `ClientHandle`, `PageConfig`, `PageHandle`).
`fetchClientConfig()` reads the agent's declared `name`/`greeting` on a page,
which `mountClient()` does for itself.

**The live call** — `useSession()` for the whole snapshot plus the controls
(`start`, `toggle`, `cancel`, `reset`, `resetState`, `restart`, `disconnect`,
`end`); `useSessionSelector()` for one slice, with `useSessionStatus()`,
`useSessionError()` and `useSessionActions()` as the narrow reads a custom
chrome repeats; `useUserTranscript()` for the caller's in-progress turn, which
keeps `null` (silent) and `""` (speech, no words yet) apart; `useConversation()`
for the interleaved transcript with nothing rendered. `createSessionCore()` is
the same session as a plain store with an immutable snapshot per change, for a
non-React client. `SessionSnapshot`, `AgentState`, `ChatMessage`,
`ToolCallInfo`, `SessionError` and `SessionErrorCode` come with it.

**What the agent pushes** — `useAgentState()` (the `syncState` projection),
`useToolResult()` / `useToolCallStart()` (tool calls as they run), and
`useEvent()` (custom events from `ctx.send`, and the one to prefer in new
code over reading tool results).

**Chat chrome** — `ChatView` is the whole surface; `ConsoleShell`,
`MessageList`, `Controls`, `Markdown`, `ToolCallRow`, `SessionErrorBanner`,
`StartScreen`, `SidebarLayout`, `AutoScroll`, `BulletList`, `Facts` and
`Button` are its parts, exported so a custom chrome reuses them rather than
approximating them. `AutoScroll` is the one to reach for directly: it is the
only scroll-pinning implementation here, and it needs a **bounded height**.
`AGENT_STATE_LABELS` and `WORKFLOW_STATUS_LABELS` are the default state words,
so a chrome overrides the one term it has a better word for.

**Forms** — `Form` collects typed values off the DOM on submit. `Field`,
`TextField`, `NumberField`, `TextAreaField`, `SelectField`, `CheckboxField`,
`FileField` and `SubmitButton` are the controls; `WorkflowFields` generates
them from a schema. A plain `<input name="x">` works identically.

**Workflows** — `createWorkflowApi()` is the client;
`useWorkflowSubmit()` / `useWorkflowStream()` (start one and watch it),
`useWorkflowRun()` (watch one by id), `useWorkflowRuns()` (the history),
`useWorkflowProgress()` (what a run has written), `useWorkflows()` (the
listing), `useDownloadUrl()` (an upload a run produced, as a URL a DOM element
accepts), `useRunKey()` (the storage-backed key a submission is recovered by).
`<WorkflowProgress>` and `<UploadProgressBar>` are the
rendered halves. `WorkflowRun`, `WorkflowSummary`, `WorkflowInputOf`,
`WorkflowOutputOf` and `isTerminal()` are the vocabulary.

**Theme** — `useTheme()` and `ClientTheme`.

## Other subpaths

The root export is the whole client API. Two subpaths sit beside it, neither
of them something a `client.tsx` reaches for:

| Subpath | Reach for it when |
| --- | --- |
| `/client-dir` | serving the prebuilt default client from Node — `defaultClientDir()`, the filesystem path `createRuntimeServer({ clientDir })` wants |
| `/internal` | never, from application code: the plumbing `mountClient()` installs for itself (the session and theme providers, the default shell's URL chips, the tool-config context, the pre-connection lookup). Not a public API and not covered by semver |

## Documentation

Full API reference: <https://alexkroman.github.io/agent/>
