# @alexkroman1/aai-ui

The browser client for aai agents: React 19 components, hooks, and a
framework-agnostic session core (WebSocket + microphone + playback).

```sh
npm i @alexkroman1/aai-ui react react-dom
```

Every agent gets this UI for free — `aai dev` and deployed agents serve a
default client built from this package. Install it directly when the agent
has its own `client.tsx`.

**Two front doors, two mounts.** A voice agent's page calls `client()` and
talks to a live session. A workflow app's page (`workflowApp()`, or
`agent({ page: "static" })`) calls `page()` and talks to the workflow HTTP
API — no session, no socket, no microphone. Both are still `client.tsx`,
still React, still the same theme tokens.

## A custom voice client

`client()` mounts the default chat shell with your sidebar, or replaces the
whole UI with a custom component:

```tsx
import "@alexkroman1/aai-ui/styles.css";
import { client, useAgentState, useTheme } from "@alexkroman1/aai-ui";

type OrderView = { items: string[]; total: string };

function OrderSidebar() {
  const theme = useTheme();
  // Server state projected by the agent's `syncState`, pushed after every
  // tool call.
  const order = useAgentState<OrderView>() ?? { items: [], total: "$0.00" };
  return (
    <div style={{ color: theme.text }}>
      {order.items.map((item) => (
        <div key={item}>{item}</div>
      ))}
      <strong style={{ color: theme.primary }}>{order.total}</strong>
    </div>
  );
}

// `sidebar` takes the COMPONENT, not an element — the shell renders it.
client({ sidebar: OrderSidebar });
```

## A workflow app

`page()` mounts a form over the agent's workflows. `<WorkflowFields>` renders
one control per scalar property of the workflow's own input schema, so adding
a field to the schema adds it to the page:

```tsx
import "@alexkroman1/aai-ui/styles.css";
import {
  Form,
  page,
  SubmitButton,
  UploadProgressBar,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowProgress,
} from "@alexkroman1/aai-ui";

function App() {
  const { submit, run, pending, upload, error } = useWorkflowSubmit("digest");
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <Form onSubmit={submit} error={error}>
        <WorkflowFields workflow="digest" />
        <SubmitButton pending={pending}>Summarize</SubmitButton>
      </Form>
      {/* The upload is its own wait: the run does not exist until the bytes
          are in, so nothing else on the page can describe it. */}
      <UploadProgressBar upload={upload} />
      {/* What the run has SAID, from `report()` in its steps. */}
      <WorkflowProgress runId={run?.runId} />
      {run?.status === "completed" && <pre>{JSON.stringify(run.output)}</pre>}
    </main>
  );
}

page({ name: "Digest", component: App });
```

`WorkflowOutputOf<typeof myWorkflow>` is what makes
`run.status === "completed"` narrow to a typed `run.output` — a type-only
import of `agent.ts` is erased, so it pulls no server code into the bundle.

## What is in the package

The reference below groups by TypeScript kind. This is the same surface
grouped by what it is for.

**Mounts** — `client()`, `page()`, and the handles they return
(`ClientConfig`, `ComponentTier`, `ConfigTier`, `BaseOptions`,
`ClientHandle`, `PageConfig`, `PageHandle`). `fetchClientConfig()` reads the
agent's declared `name`/`greeting` on a page, which `client()` does for
itself.

**The live call** — `useSession()` for the whole snapshot,
`useSessionSelector()` for one slice, `useUserTranscript()` for the caller's
in-progress turn. `createSessionCore()` is the same session as a plain store,
for a non-React client. `SessionSnapshot`, `AgentState`, `ChatMessage`,
`ToolCallInfo`, `SessionError`, `SessionErrorCode` and
`VOICE_CAPTURE_CONSTRAINTS` come with it.

**What the agent pushes** — `useAgentState()` (the `syncState` projection),
`useToolResult()` / `useToolCallStart()` (tool calls as they run), and
`useEvent()` (custom events from `ctx.send`).

**Chat chrome** — `ChatView` is the whole surface; `MessageList`, `Controls`,
`Markdown`, `ToolCallRow`, `StartScreen`, `SidebarLayout`, `AutoScroll` and
`Button` are its parts, exported so a custom chrome reuses them rather than
approximating them. `AutoScroll` is the one to reach for directly: it is the
only scroll-pinning implementation here, and it needs a **bounded height**.

**Forms** — `Form` collects typed values off the DOM on submit. `Field`,
`TextField`, `NumberField`, `TextAreaField`, `SelectField`, `CheckboxField`,
`FileField` and `SubmitButton` are the controls; `WorkflowFields` generates
them from a schema. A plain `<input name="x">` works identically.

**Workflows** — `createWorkflowApi()` is the client;
`useWorkflowSubmit()` / `useWorkflowStream()` (start one and watch it),
`useWorkflowRun()` (watch one by id), `useWorkflowRuns()` (the history),
`useWorkflowProgress()` (what a run has written), `useWorkflows()` (the
listing). `<WorkflowProgress>` and `<UploadProgressBar>` are the rendered
halves. `WorkflowRun`, `WorkflowSummary`, `WorkflowOutputOf` and
`isTerminal()` are the vocabulary.

**Theme** — `useTheme()` and `ClientTheme`.

**Node only** — `@alexkroman1/aai-ui/client-dir` exports
`defaultClientDir()`, the filesystem path of the prebuilt default client, for
`createServer({ clientDir })`.

## Hooks

Inside components rendered by `client()`:

- `useSession()` — connection state, transcript, and the call controls:
  `start`, `toggle`, `cancel`, `reset`, `resetState`, `disconnect`, `end`.
- `useAgentState<T>()` — the agent's `syncState` projection, live.
- `useToolResult(name, cb)` / `useToolCallStart(name, cb)` — observe tool
  calls as they run (e.g. to render a card per result).
- `useEvent(name, cb)` — custom events the agent pushes with `ctx.send`.
- `useTheme()` — the resolved theme colors for custom components.

For a non-React integration, `createSessionCore()` exposes the same session
as a plain store with an immutable snapshot per change.

## Documentation

Full API reference: <https://alexkroman.github.io/agent/>
