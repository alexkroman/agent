# index

## Functions

### AutoScroll()

```ts
function AutoScroll(props: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  initial?: "instant" | "smooth";
  resize?: "instant" | "smooth";
  scrollClassName?: string;
  style?: CSSProperties;
}): ReactNode;
```

A scroll container that stays pinned to the bottom as its content grows,
releases when the reader scrolls up, and re-engages once they return to the
bottom.

For clients that render their own chat chrome instead of using
[MessageList](#messagelist) — a terminal, a dispatch board, a themed transcript.
`MessageList` already behaves this way; this is the same mechanism with no
opinion about what goes inside it.

#### Parameters

##### props

Scroll container props.

###### children

`ReactNode`

The scrollable content.

###### className?

`string`

Classes for the outer container, appended to its own.

**The container must end up with a bounded height** (`flex-1 min-h-0`,
`h-full`, a fixed height). This is the one constraint callers get wrong:
an unbounded container grows with its content and never scrolls, so
nothing pins and the component silently does nothing.

###### contentClassName?

`string`

Classes for the inner content element, where padding and the children's
own layout belong.

###### initial?

`"instant"` \| `"smooth"`

Scroll behavior on mount. Defaults to `"instant"` — start at the latest
content without animating a scroll the reader did not ask for.

###### resize?

`"instant"` \| `"smooth"`

Scroll behavior when pinned content grows. Defaults to `"smooth"`.

###### scrollClassName?

`string`

Classes for the scrolling element itself. Defaults to hiding the
scrollbar; pass `"overflow-y-auto"` to show a native one.

###### style?

`CSSProperties`

Inline styles for the outer container.

#### Returns

`ReactNode`

#### Remarks

The pattern this replaces is a `useEffect` that calls
`ref.current?.scrollIntoView()` on every message change. That version has
three faults, and they compound: it fights the reader, since scrolling up to
re-read is undone by the next transcript delta; it misses growth that is not
a new message, because a streamed reply, an expanding tool block or a
markdown reflow changes height without changing the dependency array; and it
needs a synthetic dependency (`messages.length + transcript.length`) to fire
at all, which is where the dead `if (version < 0) return;` line comes from.
A `ResizeObserver` on the content — what this uses — has none of those.

#### Example

```tsx
import { AutoScroll, useSession } from "@alexkroman1/aai-ui";

function Transcript() {
  const session = useSession();
  return (
    <AutoScroll className="flex-1 min-h-0" contentClassName="flex flex-col gap-2 p-4">
      {session.messages.map((m) => (
        <div key={m.id}>{m.content}</div>
      ))}
    </AutoScroll>
  );
}
```

***

### Button()

```ts
function Button(props: {
  children?: ReactNode;
  className?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">): Element;
```

A styled button with variant and size presets.

Accepts all standard `<button>` HTML attributes in addition to the props
listed below.

#### Parameters

##### props

\{
  `children?`: `ReactNode`;
  `className?`: `string`;
  `size?`: [`ButtonSize`](#buttonsize);
  `variant?`: [`ButtonVariant`](#buttonvariant);
\} & `Omit`\<`ButtonHTMLAttributes`\<`HTMLButtonElement`\>, `"className"`\>

Button props: `variant` (visual style — see
[ButtonVariant](#buttonvariant), defaults to `"default"`), `size` (see
[ButtonSize](#buttonsize), defaults to `"default"`), `className` (appended to the
button's own classes), `children` (the label), and any `<button>` attribute.

#### Returns

`Element`

#### Example

```tsx
import { Button } from "@alexkroman1/aai-ui";

function Actions({ onStop }: { onStop: () => void }) {
  return (
    <>
      <Button variant="secondary" onClick={onStop}>Stop</Button>
      <Button size="lg" className="w-full">Start Conversation</Button>
    </>
  );
}
```

***

### ChatView()

```ts
function ChatView(props: {
  className?: string;
  icon?: ReactNode;
  title?: string;
}): ReactNode;
```

The main chat interface for a voice agent session — the design-system
"voice agent console": a 760px column on the cream page with a header
(logo + live-status eyebrow), the conversation on a raised white card,
and the session controls beneath it.

Must be rendered inside a `SessionProvider`.

#### Parameters

##### props

Chat surface props.

###### className?

`string`

Additional CSS class names for the root element, appended to its own.

###### icon?

`ReactNode`

Element rendered in place of the logo in the header.

###### title?

`string`

Title string for the header. Defaults to the agent's declared name.

#### Returns

`ReactNode`

#### Example

```tsx
import { ChatView, StartScreen } from "@alexkroman1/aai-ui";

function App() {
  return (
    <StartScreen icon="🍕" title="Pizza Palace">
      <ChatView />
    </StartScreen>
  );
}
```

***

### CheckboxField()

```ts
function CheckboxField(props: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "className" | "type">): Element;
```

A checkbox. Contributes a BOOLEAN to [FormValues](#formvalues).

Accepts every `<input>` attribute except `name`, `className` and `type`,
plus the shared [FieldShell](#fieldshell) props. The label renders beside the box
rather than above it, so `hint` is the place for guidance.

#### Parameters

##### props

[`FieldShell`](#fieldshell) & `Omit`\<`InputHTMLAttributes`\<`HTMLInputElement`\>, `"name"` \| `"className"` \| `"type"`\>

[FieldShell](#fieldshell) props plus `<input>` attributes.

#### Returns

`Element`

***

### client()

```ts
function client(config: ClientConfig): ClientHandle;
```

Define and mount a client UI for a voice agent.

**Config only:** leave `component` out and the default shell renders
(StartScreen + ChatView, optional sidebar).

**A custom component:** pass `component` and it is rendered inside the same
providers instead of the default shell — beside a `sidebar` if one is given,
in the same [SidebarLayout](#sidebarlayout). A provided `name` then also sets
`document.title`, there being no shell header to show it in.

Mounts into `target` — a CSS selector or DOM element, defaulting to
`"#app"` — and throws `Element not found: <target>` when the selector
matches nothing.

#### Parameters

##### config

[`ClientConfig`](#clientconfig)

#### Returns

[`ClientHandle`](#clienthandle)

A [ClientHandle](#clienthandle) for cleanup.

#### Examples

**The default shell**

```tsx
import { client } from "@alexkroman1/aai-ui";

function OrderPanel() {
  return <div>Cart</div>;
}

client({
  name: "Pizza Ordering",
  theme: { bg: "#1a1a1a", primary: "#e55" },
  sidebar: OrderPanel,
  tools: { add_pizza: { icon: "🍕", label: "Adding pizza" } },
});
```

**A custom component**

```tsx
import { client, useSession } from "@alexkroman1/aai-ui";

function MyCustomApp() {
  const session = useSession();
  return <div>{session.state}</div>;
}

client({ component: MyCustomApp });
```

#### Throws

If the target element is not found in the DOM.

***

### ConsoleShell()

```ts
function ConsoleShell(props: ConsoleShellProps): ReactNode;
```

The design-system "console" chrome: a 760px column on the themed page with a
header (icon + live-status eyebrow), an announced error banner, the main
content on a raised card, and a footer row beneath it.

[ChatView](#chatview) is this shell with `<MessageList>` inside it and
`<Controls>` under it, and until now that was the only way to get it — the
shell itself was internal, so a client wanting its own conversation markup
had to rebuild the chrome as well. Each one that did re-derived the error
banner WITHOUT `role="alert"`, which is the one part of this component a
reviewer cannot see is missing: per the `fatalError` latch in
`session-core.ts`, the banner is the only remaining signal once the state
eyebrow goes back to reading like a live session, and a screen reader is
never told an unannounced one appeared.

Reach for it when the conversation is yours and the frame is not. Reach for
`<ChatView>` when both are ours.

Must be rendered inside the providers `client()` installs.

#### Parameters

##### props

[`ConsoleShellProps`](#consoleshellprops)

See [ConsoleShellProps](#consoleshellprops).

#### Returns

`ReactNode`

#### Example

**A custom conversation in the stock chrome**

```tsx
import {
  ConsoleShell,
  Controls,
  useConversation,
  useSessionSelector,
} from "@alexkroman1/aai-ui";

function Console() {
  const state = useSessionSelector((s) => s.state);
  const error = useSessionSelector((s) => s.error);
  const { items } = useConversation();
  return (
    <ConsoleShell
      title="Dispatch"
      state={state}
      pulsing={state === "listening"}
      error={error?.message}
      footer={<Controls />}
    >
      <ul>
        {items.map((item) => (
          <li key={item.kind === "message" ? item.message.id : item.toolCall.callId}>
            {item.kind === "message" ? item.message.content : item.toolCall.name}
          </li>
        ))}
      </ul>
    </ConsoleShell>
  );
}
```

***

### createSessionCore()

```ts
function createSessionCore(options: VoiceSessionOptions): SessionCore;
```

Create a framework-agnostic voice session core that connects to an AAI
server via WebSocket.

Uses a subscribe/getSnapshot pattern for state management, compatible with
React's `useSyncExternalStore` and other external store integrations.

Most clients never call this: `client()` creates a core and installs it in
React context for the hooks. Reach for it directly when building a
non-React UI (or wiring the session into another framework's store).

#### Parameters

##### options

[`VoiceSessionOptions`](#voicesessionoptions)

Session configuration including the platform server URL.

#### Returns

[`SessionCore`](#sessioncore)

A [SessionCore](#sessioncore) handle for controlling the session.

#### Example

```ts
import { createSessionCore, type SessionSnapshot } from "@alexkroman1/aai-ui";

declare function render(snapshot: SessionSnapshot): void;

const session = createSessionCore({ platformUrl: "https://host/my-agent/" });
session.subscribe(() => render(session.getSnapshot()));
session.start();
```

***

### createWorkflowApi()

```ts
function createWorkflowApi(opts?: WorkflowApiOptions): WorkflowApi;
```

Create a workflow API client aimed at the agent serving this page.

Hoist it out of the component that uses it. `useWorkflowRun` holds the client
in a ref precisely so a fresh object per render does not restart its watch,
but a client built in render is still a new `fetch` closure every time and
reads as though it were free.

#### Parameters

##### opts?

[`WorkflowApiOptions`](#workflowapioptions)

See [WorkflowApiOptions](#workflowapioptions). Both fields are optional; the
default base URL is the page's own origin and path.

#### Returns

[`WorkflowApi`](#workflowapi)

The call set — see [WorkflowApi](#workflowapi).

#### Example

```tsx
import { createWorkflowApi, useWorkflowRun } from "@alexkroman1/aai-ui";
import { useState } from "react";

// Module scope, not render scope — see above.
const api = createWorkflowApi();

function StartDigest() {
  const [runId, setRunId] = useState<string>();
  const { run } = useWorkflowRun(runId, { api });
  return (
    <button
      type="button"
      onClick={() => void api.start("digest", { url: "…" }).then(setRunId)}
    >
      {run ? run.status : "Start"}
    </button>
  );
}
```

***

### fetchClientConfig()

```ts
function fetchClientConfig(platformUrl: string, fetchFn?: {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  (input: string | Request | URL, init?: RequestInit): Promise<Response>;
}): Promise<{
  greeting?: string;
  name?: string;
  page: "static" | "voice";
  sessionUrl?: string;
}>;
```

Fetch the agent's declared `name`, `greeting` and front door; any failure
yields the agent default (`{}`).

**This is what a workflow app calls instead of receiving the config.**
`client()` fetches `GET client-config` for itself before it renders the
default chat shell, so a voice client never has to. `page()` mounts no
session and makes no such request — deliberately, since a page has no shell
to put a name in — so a page that wants the agent's own `name` or `greeting`
asks for them here.

Every failure path degrades to the empty default rather than throwing: a
network error, a 404 from a server older than the endpoint, a malformed
body, and a lookup that hangs past
`CLIENT_CONFIG_ATTEMPT_TIMEOUT_MS` all read as "the agent declared nothing".
So a page may render straight from the result and never needs a `catch` —
treat every field as optional, because an agent that declared none is a
normal agent.

#### Parameters

##### platformUrl

`string`

The agent's base URL. On a deployed page that is the
page's own origin and path (`location.origin + location.pathname`); the
endpoint is resolved relative to it.

##### fetchFn?

\{
  (`input`: `RequestInfo` \| `URL`, `init?`: `RequestInit`): `Promise`\<`Response`\>;
  (`input`: `string` \| `Request` \| `URL`, `init?`: `RequestInit`): `Promise`\<`Response`\>;
\}

Fetch implementation, for tests and for a caller that
supplies its own credentials. Defaults to the global `fetch`.

#### Returns

`Promise`\<\{
  `greeting?`: `string`;
  `name?`: `string`;
  `page`: `"static"` \| `"voice"`;
  `sessionUrl?`: `string`;
\}\>

The agent's config, or `{}` when the lookup produced no answer.

#### Example

```tsx
import { fetchClientConfig, page } from "@alexkroman1/aai-ui";

const { name, greeting } = await fetchClientConfig(
  location.origin + location.pathname,
);

function App() {
  return (
    <main>
      <h1>{name ?? "Workflows"}</h1>
      {greeting ? <p>{greeting}</p> : null}
    </main>
  );
}

page({ name: name ?? "Workflows", component: App });
```

***

### Field()

```ts
function Field(props: {
  children: ReactNode;
  className?: string;
  hint?: string;
  htmlFor?: string;
  label?: string;
}): Element;
```

Label + control + hint, in the layout every field here uses.

Exported so a caller's own control gets the same shell rather than an
approximation of it.

#### Parameters

##### props

Field-shell props.

###### children

`ReactNode`

The control itself.

###### className?

`string`

Additional CSS class names for the wrapper, appended to its own.

###### hint?

`string`

One line of guidance under the control.

###### htmlFor?

`string`

Id of the control this labels.

###### label?

`string`

Visible label. Omitted leaves the control unlabelled.

#### Returns

`Element`

#### Example

```tsx
import { Field, Form } from "@alexkroman1/aai-ui";

function ColorForm() {
  return (
    <Form onSubmit={() => undefined}>
      <Field label="Accent" hint="Any CSS color." htmlFor="accent">
        <input id="accent" name="accent" type="color" />
      </Field>
    </Form>
  );
}
```

***

### FileField()

```ts
function FileField(props: FieldShell & {
  read?: FileRead;
  upload?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "className" | "type">): Element;
```

A file picker. Contributes a [FileValue](#filevalue) (or an array, with `multiple`)
to [FormValues](#formvalues) — or nothing when no file was chosen.

**`upload` is what a workflow input wants.** A run's input is serialized into
the run record and replayed from it on every resume, so a file's BYTES cannot
travel in it. With `upload` the field contributes the `File` itself,
`useWorkflowSubmit` stores it through `POST /workflows/uploads` before
starting the run, and the input carries the upload id — which a step reads
windows of with `readUpload`. Declaring the property in the workflow's
`uploads` list makes `<WorkflowFields>` render exactly this, so a declared
form needs no file markup at all.

**Without it the field describes the file and does not read it.** `read`
exists for the cases where the bytes really are small and really are the
input — a CSV of ids, a config — and the size is the author's to check. See
[FileRead](#fileread) for the four values; `upload` is shorthand for
`read="upload"`.

Otherwise accepts every `<input>` attribute except `name`, `className` and
`type`, plus the shared [FieldShell](#fieldshell) props — so `accept` and
`multiple` are passed straight through.

#### Parameters

##### props

[`FieldShell`](#fieldshell) & \{
  `read?`: [`FileRead`](#fileread);
  `upload?`: `boolean`;
\} & `Omit`\<`InputHTMLAttributes`\<`HTMLInputElement`\>, `"name"` \| `"className"` \| `"type"`\>

[FieldShell](#fieldshell) props, `read`/`upload`, and `<input>`
attributes.

#### Returns

`Element`

***

### Form()

```ts
function Form(props: FormProps): Element;
```

A form that hands its values to `onSubmit` as one object.

Native validation still applies — a `required` field blocks the submit and the
browser says so, which is better than anything this could render.

#### Parameters

##### props

[`FormProps`](#formprops)

See [FormProps](#formprops). Every `<form>` attribute except
`onSubmit` and `className` is passed through.

#### Returns

`Element`

#### Example

```tsx
import { Form, SubmitButton, TextField } from "@alexkroman1/aai-ui";

function NameForm() {
  return (
    <Form onSubmit={(values) => console.log(values.topic)}>
      <TextField name="topic" label="Topic" required />
      <SubmitButton>Start</SubmitButton>
    </Form>
  );
}
```

***

### isTerminal()

```ts
function isTerminal<R>(run: 
  | WorkflowRunSnapshot<R>
  | undefined): run is TerminalWorkflowRun<R>;
```

Is this run finished?

A type guard rather than a `boolean`, so the narrow it performs is usable:
`if (isTerminal(run))` leaves `run.status` as the three-member union a caller
can switch over exhaustively. Accepts `undefined` (nothing started yet, or the
first poll has not landed) because that is what every call site holds.

#### Type Parameters

##### R

`R`

#### Parameters

##### run

  \| [`WorkflowRunSnapshot`](../aai/workflow-api.md#workflowrunsnapshot)\<`R`\>
  \| `undefined`

#### Returns

`run is TerminalWorkflowRun<R>`

***

### NumberField()

```ts
function NumberField(props: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "className" | "type">): Element;
```

A number input. Contributes a NUMBER to [FormValues](#formvalues), or nothing when
left empty.

Accepts every `<input>` attribute except `name`, `className` and `type`,
plus the shared [FieldShell](#fieldshell) props — so `min`, `max` and `step` are
passed straight through.

#### Parameters

##### props

[`FieldShell`](#fieldshell) & `Omit`\<`InputHTMLAttributes`\<`HTMLInputElement`\>, `"name"` \| `"className"` \| `"type"`\>

[FieldShell](#fieldshell) props plus `<input>` attributes.

#### Returns

`Element`

***

### page()

```ts
function page(config: PageConfig): PageHandle;
```

Mount a page for an agent whose work happens in workflows.

There is deliberately no session, no microphone, and no socket: the component
talks to the agent over the workflow HTTP API
(`createWorkflowApi`/`useWorkflowRun`), which is durable and outlives the tab.

#### Parameters

##### config

[`PageConfig`](#pageconfig)

#### Returns

[`PageHandle`](#pagehandle)

#### Example

```tsx
import { createWorkflowApi, page, useWorkflowRun } from "@alexkroman1/aai-ui";
import { useState } from "react";

// Hoisted: a client built in render is a new object every render.
const api = createWorkflowApi();

function App() {
  const [runId, setRunId] = useState<string>();
  const { run } = useWorkflowRun(runId, { api });
  return (
    <button
      type="button"
      onClick={() => void api.start("digest", { topic: "ai" }).then(setRunId)}
    >
      {run ? run.status : "Start"}
    </button>
  );
}

page({ name: "Digest", component: App });
```

#### Throws

If the target element is not found in the DOM.

***

### SelectField()

```ts
function SelectField(props: FieldShell & {
  options?: readonly (
     | string
     | {
     label: string;
     value: string;
  })[];
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "name" | "className">): Element;
```

A dropdown.

`options` is the short form — a list of strings, or of
`{ value, label }` pairs when the two differ. Pass `children` instead for
full control over the `<option>` elements; `children` wins when both are
given.

Otherwise accepts every `<select>` attribute except `name` and `className`,
plus the shared [FieldShell](#fieldshell) props. Note `multiple` works and
contributes an ARRAY (`[]` when nothing is chosen).

#### Parameters

##### props

[`FieldShell`](#fieldshell) & \{
  `options?`: readonly (
     \| `string`
     \| \{
     `label`: `string`;
     `value`: `string`;
  \})[];
\} & `Omit`\<`SelectHTMLAttributes`\<`HTMLSelectElement`\>, `"name"` \| `"className"`\>

[FieldShell](#fieldshell) props, `options`, and `<select>`
attributes.

#### Returns

`Element`

***

### SidebarLayout()

```ts
function SidebarLayout(props: {
  children: ReactNode;
  className?: string;
  sidebar: ReactNode;
  sidebarPosition?: "left" | "right";
  sidebarWidth?: string;
}): Element;
```

A two-column layout with a fixed-width sidebar and a flexible main area.
Commonly used to pair a custom sidebar (cart, dashboard) with `<ChatView />`.

#### Parameters

##### props

Layout props.

###### children

`ReactNode`

The main pane, normally a `<ChatView />`.

###### className?

`string`

Additional CSS class names for the root element, appended to its own.

###### sidebar

`ReactNode`

The sidebar pane — a cart, a dashboard, a run history.

###### sidebarPosition?

`"left"` \| `"right"`

Which side the sidebar sits on. Defaults to `"left"`.

###### sidebarWidth?

`string`

Width of the sidebar as a CSS length. Defaults to `"18rem"`, and applies
from the `md` breakpoint up: below it the two panes stack, because a fixed
width that never shrinks leaves a phone-width main pane unreadable.

#### Returns

`Element`

#### Example

```tsx
import { ChatView, SidebarLayout } from "@alexkroman1/aai-ui";

function OrderPanel() {
  return <div>Cart</div>;
}

function App() {
  return (
    <SidebarLayout sidebar={<OrderPanel />}>
      <ChatView />
    </SidebarLayout>
  );
}
```

***

### StartScreen()

```ts
function StartScreen(props: {
  buttonText?: string;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
  subtitle?: string;
  title?: string;
}): ReactNode;
```

A centered start screen: a white card on the cream page with the logo, an
eyebrow label, a serif title, subtitle, and the start CTA. Renders
`children` (the main app) once the session has started.

#### Parameters

##### props

Start-screen props.

###### buttonText?

`string`

Label of the start CTA. Defaults to `"Start Conversation"`.

###### children

`ReactNode`

The app, rendered once the session has started.

###### className?

`string`

Additional CSS class names for the root element, appended to its own.

###### icon?

`ReactNode`

Element rendered in place of the logo on the card.

###### subtitle?

`string`

A line under the title.

###### title?

`string`

The card's serif title. Defaults to the agent's declared name.

#### Returns

`ReactNode`

#### Example

```tsx
import { ChatView, StartScreen } from "@alexkroman1/aai-ui";

function MyAgent() {
  return (
    <StartScreen icon="🍕" title="Pizza Palace" subtitle="Voice-powered ordering">
      <ChatView />
    </StartScreen>
  );
}
```

***

### SubmitButton()

```ts
function SubmitButton(props: {
  children?: ReactNode;
  className?: string;
  pending?: boolean;
  pendingLabel?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "disabled" | "type">): Element;
```

The form's submit button, disabled and relabelled while a submit is in
flight.

Accepts all standard `<button>` HTML attributes except `type` and `disabled`,
in addition to the props below — so `aria-label` on an icon-only submit,
`form`, `id`, `title` and `onClick` all work here exactly as they do on
[Button](#button). `type` and `disabled` stay owned: this component sets both
from `pending`, and letting a caller set either is how a form gets a submit
button that does not submit.

#### Parameters

##### props

\{
  `children?`: `ReactNode`;
  `className?`: `string`;
  `pending?`: `boolean`;
  `pendingLabel?`: `string`;
  `size?`: [`ButtonSize`](#buttonsize);
  `variant?`: [`ButtonVariant`](#buttonvariant);
\} & `Omit`\<`ButtonHTMLAttributes`\<`HTMLButtonElement`\>, `"className"` \| `"disabled"` \| `"type"`\>

Button props.

#### Returns

`Element`

#### Example

```tsx
import { Form, SubmitButton, TextField } from "@alexkroman1/aai-ui";

function Digest({ pending }: { pending: boolean }) {
  return (
    <Form onSubmit={() => undefined}>
      <TextField name="url" label="Link" required />
      <SubmitButton pending={pending} variant="secondary" size="lg">
        Summarize
      </SubmitButton>
    </Form>
  );
}
```

***

### TextAreaField()

```ts
function TextAreaField(props: FieldShell & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "name" | "className">): Element;
```

A multi-line text input.

Accepts every `<textarea>` attribute except `name` and `className`, plus the
shared [FieldShell](#fieldshell) props. `rows` defaults to 4.

#### Parameters

##### props

[`FieldShell`](#fieldshell) & `Omit`\<`TextareaHTMLAttributes`\<`HTMLTextAreaElement`\>, `"name"` \| `"className"`\>

[FieldShell](#fieldshell) props plus `<textarea>` attributes.

#### Returns

`Element`

***

### TextField()

```ts
function TextField(props: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "className">): Element;
```

A single-line text input.

Accepts every `<input>` attribute except `name` and `className`, which this
component owns, plus the shared [FieldShell](#fieldshell) props.

#### Parameters

##### props

[`FieldShell`](#fieldshell) & `Omit`\<`InputHTMLAttributes`\<`HTMLInputElement`\>, `"name"` \| `"className"`\>

[FieldShell](#fieldshell) props plus `<input>` attributes.

#### Returns

`Element`

***

### ToolCallRow()

```ts
function ToolCallRow(props: ToolCallRowProps): ReactNode;
```

The design system's console row for one tool invocation: a small outlined
"TOOL" chip (or a custom `icon`), the tool title in mono, a truncated
detail preview, and a rotating chevron that expands to the panel content.

Purely presentational — callers own the mapping from their tool-call data
to `title`/`detail`/`pending` and the expanded panel. The deployed agent
UI's message list renders it via its tool-call block, and the studio's
chat transcript renders it with `variant="compact"`, so the two surfaces
read as one component.

Colors come from the nearest theme context (see [useTheme](#usetheme)); without
a provider the default AssemblyAI theme applies.

#### Parameters

##### props

[`ToolCallRowProps`](#toolcallrowprops)

See [ToolCallRowProps](#toolcallrowprops).

#### Returns

`ReactNode`

#### Example

```tsx
import { ToolCallRow, useSession } from "@alexkroman1/aai-ui";

// A custom chrome's tool log, from the snapshot's own `toolCalls`.
function ToolLog() {
  const { toolCalls } = useSession();
  return (
    <div>
      {toolCalls.map((call) => (
        <ToolCallRow
          key={call.callId}
          title={call.name}
          detail={call.result}
          pending={call.status === "pending"}
        />
      ))}
    </div>
  );
}
```

***

### UploadProgressBar()

```ts
function UploadProgressBar(props: {
  className?: string;
  onPause?: () => void;
  onResume?: () => void;
  upload?: UploadStatus;
}): ReactNode;
```

How far a form's files have got, rendered as a bar.

The wait this covers is the one a run cannot describe: a workflow run does not
EXIST until its input is stored, so from the moment a form is submitted until
the last byte lands there is no run id, no status, and nothing for
`<WorkflowProgress>` to read — which for a 200 MB recording is minutes of a
page that looks stuck. `useWorkflowSubmit` reports the bytes as they go and
this is what draws them.

Three things it decides, so a page does not:

- **It renders nothing when there is nothing to describe.** `upload` is
  undefined before the first byte and again from the moment the last one
  lands, so `<UploadProgressBar upload={upload} />` is correct unguarded and a
  form with no files never shows a bar at all.
- **An unknown total is INDETERMINATE, not zero.** A body whose length the
  transport cannot state up front (see `UploadProgress.total`) has no honest
  width, and a bar pinned at 0% reads as an upload that is not moving.
- **The file is NAMED, and counted when there is more than one.** Files are
  sent one after another, so a single bar otherwise appears to restart from
  zero partway through with nothing to say why.
- **A paused upload SAYS SO, rather than being a bar that stopped.** Those look
  identical, which is the whole reason `UploadStatus.paused` exists, and the
  fill stops animating so the difference is visible without reading.

The pause control appears only when a handler for it is passed. That is not
politeness about props: a button whose press does nothing is worse than no
button, and a page holding an `upload` it did not produce (a saved status, a
parent's state) has nothing to pause.

#### Parameters

##### props

Progress-bar props.

###### className?

`string`

**Replaces** the default classes rather than extending them, so a custom
chrome is not fighting a default it did not ask for.

###### onPause?

() => `void`

The hook's `pauseUpload`. **Pass it together with `onResume`** to get the
pause control; pass neither for a bar that only reports. One without the
other is a one-way door drawn as a toggle, so the control is hidden unless
both are present.

###### onResume?

() => `void`

The hook's `resumeUpload`. See `onPause` — the two travel together.

###### upload?

[`UploadStatus`](#uploadstatus)

What `useWorkflowSubmit` / `useWorkflowStream` report as `upload`.
`undefined` renders nothing, so a page may pass its state straight through
and never guard the element.

#### Returns

`ReactNode`

#### Example

```tsx no-check
import { Form, SubmitButton, UploadProgressBar, useWorkflowSubmit, WorkflowFields } from "@alexkroman1/aai-ui";
import type { transcribe } from "./agent.ts";

function TranscribeForm() {
  const { submitForm, upload, pending, error } = useWorkflowSubmit<typeof transcribe>("transcribe");
  return (
    <Form onSubmit={submitForm} error={error}>
      <WorkflowFields workflow="transcribe" />
      <UploadProgressBar upload={upload} />
      <SubmitButton pending={pending}>Transcribe</SubmitButton>
    </Form>
  );
}
```

***

### useAgentState()

#### Call Signature

```ts
function useAgentState<S = any>(): S | null;
```

The agent's projected session state, or `null` before the first push.

The counterpart to `syncState` on the agent: whatever that projection
returns is what arrives here — no per-tool result mirroring needed.

```tsx
import { useAgentState } from "@alexkroman1/aai-ui";

type Item = { sku: string; qty: number };

function Cart() {
  const state = useAgentState<{ cart: Item[] }>();
  return <ul>{state?.cart.map((item) => <li key={item.sku}>{item.qty}</li>)}</ul>;
}
```

Typed by the caller for the same reason `useToolResult` is: the shape is
the author's own projection, which the framework cannot see. It is
nullable on purpose — nothing has been pushed before the first tool call,
and a UI has to render that moment.

##### Type Parameters

###### S

`S` = `any`

##### Returns

`S` \| `null`

#### Call Signature

```ts
function useAgentState<V>(projection: StateProjection<V>): V;
```

The agent's projected session state, typed and defaulted by the SAME
projection the agent pushes — pass `slot.projection(view)` and there is no
type argument to restate and no empty frame to derive.

This is the overload to reach for whenever `syncState` is a slot projection,
because it closes the round-trip the other two leave open. A projection is
callable, so the pre-first-push frame is what `projection()` returns — the
`fallback` overload's own doc tells you to build it that way — and the
projection's return type is the state's type, so `useAgentState<CartView>`
was restating what `cartView` already knew. Both halves came out of the same
declaration and both were written by hand:

```tsx no-check
// `no-check`: the projection lives with the agent, in another file.
// Before — the empty frame derived by hand, the type named three times:
const EMPTY: CartView = cartSlot.projection(cartView)(undefined);
const cart = useAgentState<CartView>(EMPTY);

// After — `shared.ts` exports the projection once, both ends import it:
const cart = useAgentState(cartProjection);
```

The empty frame is memoized on the projection's identity, so a module-scope
projection (the normal case) produces ONE frame for the life of the
component — which the `fallback` overload can only ask you to arrange by
hoisting, and which a `slot.projection(view)` spelled inline in the render
body silently got wrong.

##### Type Parameters

###### V

`V`

##### Parameters

###### projection

[`StateProjection`](../aai/index.md#stateprojection)\<`V`\>

The same `slot.projection(view)` the agent declares as
  `syncState`. Export it from the module that declares the slot so the two
  ends cannot drift.

##### Returns

`V`

#### Call Signature

```ts
function useAgentState<S = any>(fallback: S): S;
```

The agent's projected session state, falling back to `fallback` before the
first push — so the return is never `null` and a sidebar needs no branch for
the pre-first-tool-call moment.

Build the fallback by running the SAME projection over an empty state, not
by hand-writing an empty-looking literal: a field added to the projection
then reaches the first render too, instead of being `undefined` only in
that one frame.

```tsx no-check
// `no-check`: the projection lives with the agent, in another file.
import { useAgentState } from "@alexkroman1/aai-ui";
import { cartSlot, cartView, type CartView } from "./shared.ts";

const EMPTY: CartView = cartSlot.projection(cartView)(undefined);

function Cart() {
  const cart = useAgentState<CartView>(EMPTY);
  return <ul>{cart.items.map((item) => <li key={item.sku}>{item.qty}</li>)}</ul>;
}
```

##### Type Parameters

###### S

`S` = `any`

##### Parameters

###### fallback

`S`

Returned while the agent has pushed nothing. Not memoized
  here — hoist it to module scope (or memoize it) so it is a stable
  reference across renders.

##### Returns

`S`

***

### useConversation()

```ts
function useConversation(): UseConversationResult;
```

Subscribe to the conversation: the interleaved exchange, the streaming
utterance, the live transcript and the thinking rule — with no markup.

Must be used inside the provider `client()` installs.

#### Returns

[`UseConversationResult`](#useconversationresult)

See [UseConversationResult](#useconversationresult).

#### Example

**A custom bubble, keeping every rule \`\<MessageList\>\` knows**

```tsx
import { useConversation } from "@alexkroman1/aai-ui";

function Transcript() {
  const { items, streaming, transcript, thinking } = useConversation();
  return (
    <div>
      {items.map((item) =>
        item.kind === "message" ? (
          <p key={item.message.id} data-role={item.message.role}>
            {item.message.content}
          </p>
        ) : (
          <code key={item.toolCall.callId}>{item.toolCall.name}</code>
        ),
      )}
      {streaming !== null && <p data-role="assistant">{streaming}</p>}
      {transcript.speaking && <p data-role="user">{transcript.text}</p>}
      {thinking && <p>…</p>}
    </div>
  );
}
```

***

### useDownloadUrl()

```ts
function useDownloadUrl(uploadId: string | undefined, opts?: UseDownloadUrlOptions): UseDownloadUrlResult;
```

Read an upload's bytes and hand back a URL a DOM element can use.

#### Parameters

##### uploadId

`string` \| `undefined`

The id a completed run reported, or `undefined` before one
  exists — which is what a page passes straight through while it waits, and
  reports as idle rather than pending.

##### opts?

[`UseDownloadUrlOptions`](#usedownloadurloptions)

See [UseDownloadUrlOptions](#usedownloadurloptions).

#### Returns

[`UseDownloadUrlResult`](#usedownloadurlresult)

See [UseDownloadUrlResult](#usedownloadurlresult).

#### Example

```tsx no-check
import { useDownloadUrl, useWorkflowSubmit } from "@alexkroman1/aai-ui";
import type { spokenSummary } from "./agent.ts";

function Playback() {
  const { run } = useWorkflowSubmit<typeof spokenSummary>("spokenSummary");
  const output = run?.status === "completed" ? run.output : undefined;
  const audio = useDownloadUrl(output?.audio);
  if (audio.pending) return <p>Fetching audio…</p>;
  if (audio.error !== undefined) return <p role="alert">{audio.error}</p>;
  return audio.url === undefined ? null : (
    <a href={audio.url} download="summary.mp3">
      Download
    </a>
  );
}
```

***

### useEvent()

```ts
function useEvent<T = unknown>(event: string, callback: (data: T) => void): void;
```

Subscribe to custom events emitted by agent tools via
`ctx.send(event, data)`; the callback receives each event's `data`.

This is the preferred way to drive UI from tools — an explicit event beats
inferring state from tool results with [useToolResult](#usetoolresult).

#### Type Parameters

##### T

`T` = `unknown`

#### Parameters

##### event

`string`

##### callback

(`data`: `T`) => `void`

#### Returns

`void`

#### Example

```tsx
import { useEvent } from "@alexkroman1/aai-ui";
import { useState } from "react";

type Item = { sku: string; qty: number };

function Cart() {
  const [cart, setCart] = useState<Item[]>([]);
  // Tool: ctx.send("item_added", { sku, qty })
  useEvent<Item>("item_added", (data) => {
    setCart((cart) => [...cart, data]);
  });
  return <div>{cart.length} items</div>;
}
```

***

### useRunKey()

```ts
function useRunKey(options?: {
  storage?: "session" | "local";
}): string;
```

A lookup key for `useWorkflowSubmit({ key })`, stable across reloads.

#### Parameters

##### options?

See the module doc for the whole argument. The storage kind
  is read once, when the key is minted: a value that changed afterwards would
  be asking to move a key that has already been recorded with a run.

###### storage?

`"session"` \| `"local"`

Which store keeps the key between loads.

`"session"` (the default) dies with the tab; `"local"` survives the
browser closing, which is what a run that sleeps for days needs. See "The
storage is the caller's decision".

#### Returns

`string`

The key to record runs under and to look them up by — the same one
  for the life of the component, and for the next load in the same tab (or the
  same browser, under `"local"`).

***

### useSession()

```ts
function useSession(): Session;
```

Return the live [Session](#session-1): the current snapshot fields plus the
control methods (`start`, `toggle`, `reset`, `resetState`, `disconnect`,
`cancel`, `end`).

Throws if used outside the provider `client()` installs (the error names
`<SessionProvider>` — you only mount that yourself when bypassing
`client()`). Re-renders the component on *every* snapshot change; for a
component that reads one field, prefer [useSessionSelector](#usesessionselector) for a
targeted subscription.

#### Returns

[`Session`](#session-1)

#### Example

```tsx
import { useSession } from "@alexkroman1/aai-ui";

function Controls() {
  const session = useSession();
  if (!session.started) return <button onClick={session.start}>Start</button>;
  return <button onClick={session.toggle}>{session.running ? "Pause" : "Resume"}</button>;
}
```

***

### useSessionSelector()

```ts
function useSessionSelector<T>(selector: (snapshot: SessionSnapshot) => T, isEqual?: (a: T, b: T) => boolean): T;
```

Subscribe to a narrow slice of the session snapshot.

Unlike [useSession](#usesession) — which re-renders the component on *every*
snapshot change — this only triggers a re-render when the selected value
changes (per `isEqual`, default `Object.is`). Use it for components that
read a single field, e.g. `useSessionSelector((s) => s.running)`.

The selector must be pure. It may run on every snapshot change, so keep it
cheap; when it returns a derived object, pass a custom `isEqual` to avoid
re-renders on referentially-new-but-equal results.

#### Type Parameters

##### T

`T`

#### Parameters

##### selector

(`snapshot`: [`SessionSnapshot`](#sessionsnapshot)) => `T`

Reads the slice out of the snapshot. Must be pure.

##### isEqual?

(`a`: `T`, `b`: `T`) => `boolean`

Compares two selected values. Defaults to `Object.is`.

#### Returns

`T`

The selected slice.

#### Example

```tsx
import { useSessionSelector } from "@alexkroman1/aai-ui";

// Re-renders when `running` flips, and on nothing else — not on every
// transcript delta the way `useSession()` would.
function MicDot() {
  const running = useSessionSelector((snapshot) => snapshot.running);
  return <span>{running ? "●" : "○"}</span>;
}
```

***

### useTheme()

```ts
function useTheme(): Required<ClientTheme>;
```

Read the resolved theme (every [ClientTheme](#clienttheme) field filled with its
default) from the nearest theme context. Returns the default theme when no
provider is present, so components can call it unconditionally.

This is how a custom component stays on the agent's palette: a
`client({ theme })` override reaches it here, where a hardcoded colour or a
Tailwind class cannot see it.

#### Returns

`Required`\<[`ClientTheme`](#clienttheme)\>

Every [ClientTheme](#clienttheme) field, filled in.

#### Example

```tsx
import { useTheme } from "@alexkroman1/aai-ui";

function Total({ amount }: { amount: string }) {
  const theme = useTheme();
  return (
    <strong style={{ color: theme.primary, background: theme.surface }}>
      {amount}
    </strong>
  );
}
```

***

### useToolCallStart()

#### Call Signature

```ts
function useToolCallStart<A = Record<string, any>>(toolName: string, callback: (toolCall: Omit<ToolCallInfo, "args"> & {
  args: A;
}) => void): void;
```

Fire a callback when ONE named tool starts, before its result arrives.

A start is a MOMENT rather than a value, so unlike [useToolResult](#usetoolresult)
this never replays: a component that mounts mid-session learns nothing about
calls that started before it.

##### Type Parameters

###### A

`A` = `Record`\<`string`, `any`\>

The tool's ARGUMENT shape. Defaults to
  `ToolCallInfo["args"]`, which is `Record<string, any>` — so an
  un-parameterized call behaves exactly as it always has, and
  `toolCall.args.totally_made_up_field` still compiles. That default is a
  property of [ToolCallInfo](#toolcallinfo) rather than a choice made here (its doc
  carries the argument, and the escape hatch it recommends —
  `args as { url: string }` — is what this type parameter replaces); until
  that field is tightened there is nothing stricter for this hook to fall
  back to. What was missing was any way to opt IN: there was no type
  parameter at all, so a custom client could not check args even when it
  knew the shape. Name it — `useToolCallStart<{ query: string }>(…)` — or
  derive it from the tool with a TYPE-ONLY import, which is erased and so
  pulls no host code into the browser graph:
  `useToolCallStart<InferToolInput<typeof search>>("search", …)`.

##### Parameters

###### toolName

`string`

Only calls of this tool fire the callback.

###### callback

(`toolCall`: `Omit`\<[`ToolCallInfo`](#toolcallinfo), `"args"`\> & \{
  `args`: `A`;
\}) => `void`

Called with the pending call.

##### Returns

`void`

##### Example

```tsx
import { useState } from "react";
import { useToolCallStart } from "@alexkroman1/aai-ui";

function Searching() {
  const [busy, setBusy] = useState(false);
  useToolCallStart("search_catalog", () => setBusy(true));
  return busy ? <p>Searching the catalog…</p> : null;
}
```

#### Call Signature

```ts
function useToolCallStart<A = Record<string, any>>(callback: (toolCall: Omit<ToolCallInfo, "args"> & {
  args: A;
}) => void): void;
```

Fire a callback when ANY tool call starts — read the tool's name off the
call itself (`toolCall.name`).

##### Type Parameters

###### A

`A` = `Record`\<`string`, `any`\>

The tool's ARGUMENT shape; see the filtered overload. On the
  unfiltered form every tool's call arrives, so naming one shape here is
  only right for a page that switches on `toolCall.name` and narrows it
  itself — the default is the honest answer for a log renderer.

##### Parameters

###### callback

(`toolCall`: `Omit`\<[`ToolCallInfo`](#toolcallinfo), `"args"`\> & \{
  `args`: `A`;
\}) => `void`

Called with the pending call.

##### Returns

`void`

##### Example

```tsx
import { useState } from "react";
import { useToolCallStart } from "@alexkroman1/aai-ui";

function Activity() {
  const [now, setNow] = useState<string>();
  useToolCallStart((toolCall) => setNow(toolCall.name));
  return now ? <p>Running {now}…</p> : null;
}
```

***

### useToolResult()

#### Call Signature

```ts
function useToolResult<R = unknown>(toolName: string, callback: (result: R, toolCall: ToolCallInfo) => void): void;
```

Fire a callback when ONE named tool settles, with its parsed JSON result.

For new code prefer explicit events — `ctx.send(event, data)` in the tool
paired with [useEvent](#useevent) here — over listening to tool results.

A component that mounts late still receives the results of calls that
already completed, because a result is a value the UI is driven from rather
than a moment. Each call fires exactly once per hook instance.

##### Type Parameters

###### R

`R` = `unknown`

The result shape. Defaults to `unknown`, NOT to
  [DefaultToolResult](../aai/index.md#defaulttoolresult) (`any`): the return type is inferred perfectly
  at `tool()` and this hook is the one place a client reads it, so an `any`
  default threw the whole inference away exactly where it was wanted —
  `useToolResult("get_order", (r) => r.a.b.c.d.e)` reported nothing. It is
  the tool's own shape that belongs here, and the spelling that costs a
  browser bundle nothing is a TYPE-ONLY import of the tool module:
  `import type getOrder from "./tools/get_order.ts"` is erased, so
  `useToolResult<InferToolOutput<typeof getOrder>>(…)` pulls no host code
  into the client graph. `useToolResult<Quote>(…)` against a hand-written
  shape is the other spelling. [DefaultToolResult](../aai/index.md#defaulttoolresult) itself stays `any`
  — see `ToolCallInfo.args` for why a value the framework cannot see is
  typed that way at REST; the argument does not extend to a call site whose
  whole job is to name the shape.

##### Parameters

###### toolName

`string`

Only calls of this tool fire the callback.

###### callback

(`result`: `R`, `toolCall`: [`ToolCallInfo`](#toolcallinfo)) => `void`

Called with the parsed result and the call itself.

##### Returns

`void`

##### Example

```tsx
import { useState } from "react";
import { useToolResult } from "@alexkroman1/aai-ui";

type Quote = { symbol: string; price: number };

function QuoteCard() {
  const [quote, setQuote] = useState<Quote>();
  useToolResult<Quote>("get_quote", (result) => setQuote(result));
  return quote ? <p>{quote.symbol}: {quote.price}</p> : null;
}
```

#### Call Signature

```ts
function useToolResult<R = unknown>(callback: (name: string, result: R, toolCall: ToolCallInfo) => void): void;
```

Fire a callback when ANY tool call settles — the tool's name is the
callback's first argument.

The unfiltered form, for a chrome rendering a log of everything the agent
did rather than reacting to one tool.

##### Type Parameters

###### R

`R` = `unknown`

The result shape. Defaults to `unknown`, for the reason the
  filtered overload's `@typeParam` gives. A log renderer is the one caller
  that legitimately wants no shape, and `unknown` is what it should say:
  `JSON.stringify(result)` takes it unchanged.

##### Parameters

###### callback

(`name`: `string`, `result`: `R`, `toolCall`: [`ToolCallInfo`](#toolcallinfo)) => `void`

Called with the tool's name, the parsed result, and the
call itself.

##### Returns

`void`

##### Example

```tsx
import { useState } from "react";
import { useToolResult } from "@alexkroman1/aai-ui";

function ToolLog() {
  const [lines, setLines] = useState<string[]>([]);
  useToolResult((name, result) => {
    setLines((prev) => [...prev, `${name}: ${JSON.stringify(result)}`]);
  });
  return <pre>{lines.join("\n")}</pre>;
}
```

***

### useUserTranscript()

```ts
function useUserTranscript(): UseUserTranscriptResult;
```

Subscribe to the caller's in-progress turn.

Narrowly subscribed — a component using this re-renders at STT-partial rate,
which is exactly what it is for and exactly what a whole-page `useSession()`
should not do.

#### Returns

[`UseUserTranscriptResult`](#useusertranscriptresult)

#### Example

```tsx
import { useUserTranscript } from "@alexkroman1/aai-ui";

function LiveTranscript() {
  const { speaking, text } = useUserTranscript();
  if (!speaking) return null;
  return <div className="italic opacity-60">{text}</div>;
}
```

***

### useWorkflowProgress()

```ts
function useWorkflowProgress<T = string>(runId: string | undefined, opts?: {
  api?: WorkflowApi;
  intervalMs?: number;
  namespace?: string;
  startIndex?: number;
}): UseWorkflowProgressResult<T>;
```

Follow one run's progress stream.

Passing `undefined` (nothing started yet) costs nothing, and reading stops for
good once a read reports the run terminal — so a finished run costs one read.

#### Type Parameters

##### T

`T` = `string`

What the workflow writes. Defaults to `string`, which is what
  a progress channel usually carries; a workflow writing objects names its own
  shape. Nothing in the browser can verify it — the route describes no type —
  so this is the page's assertion about its own agent, narrowed once here
  rather than at every read.

#### Parameters

##### runId

`string` \| `undefined`

##### opts?

###### api?

[`WorkflowApi`](#workflowapi)

###### intervalMs?

`number`

###### namespace?

`string`

###### startIndex?

`number`

#### Returns

[`UseWorkflowProgressResult`](#useworkflowprogressresult)\<`T`\>

#### Example

```tsx
import { useWorkflowProgress } from "@alexkroman1/aai-ui";

function Progress({ runId }: { runId?: string }) {
  const { progress, streaming, supported } = useWorkflowProgress(runId);
  if (!supported) return null;
  return (
    <pre>
      {progress.join("\n")}
      {streaming && "\n…"}
    </pre>
  );
}
```

***

### useWorkflowRun()

```ts
function useWorkflowRun<R = unknown>(runId: string | undefined, opts?: {
  api?: WorkflowApi;
  intervalMs?: number;
}): UseWorkflowRunResult<R>;
```

Watch one run until it reaches a terminal status.

A watch rather than a subscription because a run is durable and the page is
not: it can complete while the tab is closed, on a different sandbox, hours
later. There is no session to reconnect — the id is the whole state.

Which is also the limit of what this hook can do on its own. An id is state a
RELOAD destroys, so a page holding nothing else comes back unable to name a
run that is still going. The durable handle is `StartOptions.key`, read back
with `find(workflow, key)`, and the hook that owns the id is where that
belongs: `useWorkflowSubmit({ key, recover: true })` adopts the key's newest
run as it mounts and passes the id here. See `_recover-run.ts` — the reason
recovery is NOT in this hook is `reset()`, which leaves the owner holding no
id on purpose, and a watcher that re-resolved one from a key would undo it.

The stream (`GET /runs/:id/events`) is tried first and the poll is its
fallback, so an agent deployed before that route existed still works. Watching
STOPS on a terminal status, so a finished run costs nothing; passing
`undefined` (nothing started yet) also costs nothing.

#### Type Parameters

##### R

`R` = `unknown`

The workflow's output type. Supplying it is what makes
  `run.status === "completed"` narrow to a typed `run.output` instead of
  `unknown`. Derive it with `WorkflowOutputOf<typeof myWorkflow>` — a
  type-only import of `agent.ts` is erased, so it costs the bundle nothing.

#### Parameters

##### runId

`string` \| `undefined`

The run to watch. `undefined` costs nothing, so a page may
  pass its state straight through before a run exists.

##### opts?

`api` when the page holds its own client; `intervalMs` to
  change the poll interval the stream falls back to.

###### api?

[`WorkflowApi`](#workflowapi)

###### intervalMs?

`number`

#### Returns

[`UseWorkflowRunResult`](#useworkflowrunresult)\<`R`\>

The latest snapshot, the last read's error, and whether the watch
  is still going — see [UseWorkflowRunResult](#useworkflowrunresult).

#### Example

```tsx
import type { ToolInputSchema, WorkflowDef } from "@alexkroman1/aai";
import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import { useWorkflowRun } from "@alexkroman1/aai-ui";

// A real page writes `import type { digest } from "./agent.ts"`. Stood in
// for here so the example compiles on its own.
declare const digest: WorkflowDef<ToolInputSchema, Promise<{ points: string[] }>>;

type Digest = WorkflowOutputOf<typeof digest>;

function RunPanel({ runId }: { runId: string | undefined }) {
  // The type argument is what makes `run.output` a `Digest` below.
  const { run, error, polling } = useWorkflowRun<Digest>(runId);
  if (error !== undefined) return <p role="alert">{error}</p>;
  if (run?.status === "completed") {
    return (
      <ul>
        {run.output.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
    );
  }
  return <p>{polling ? "Working…" : "Nothing running."}</p>;
}
```

***

### useWorkflowRuns()

```ts
function useWorkflowRuns<R = unknown>(workflow: string | undefined, opts?: UseWorkflowRunsOptions): UseWorkflowRunsResult<R>;
```

Read a workflow's recent runs.

#### Type Parameters

##### R

`R` = `unknown`

The workflow's output type, so a completed run's `output` is
  typed rather than `unknown`. Derive it with `WorkflowOutputOf`.

#### Parameters

##### workflow

`string` \| `undefined`

##### opts?

[`UseWorkflowRunsOptions`](#useworkflowrunsoptions)

#### Returns

[`UseWorkflowRunsResult`](#useworkflowrunsresult)\<`R`\>

#### Example

```tsx
import { useWorkflowRuns } from "@alexkroman1/aai-ui";

function History() {
  const { runs } = useWorkflowRuns("transcribe", { limit: 10 });
  return <ul>{runs.map((run) => <li key={run.runId}>{run.status}</li>)}</ul>;
}
```

***

### useWorkflows()

```ts
function useWorkflows(opts?: UseWorkflowsOptions): UseWorkflowsResult;
```

Read the agent's declared workflows.

What `<WorkflowFields>` renders a form FROM: each summary carries the JSON
Schema of that workflow's input, converted server-side precisely so a browser
can read it.

The failure is reported rather than swallowed, because the alternative is an
empty list — which renders as a form with no fields and reads as "this agent
declares no workflows" about an agent that was merely unreachable.

#### Parameters

##### opts?

[`UseWorkflowsOptions`](#useworkflowsoptions)

See [UseWorkflowsOptions](#useworkflowsoptions).

#### Returns

[`UseWorkflowsResult`](#useworkflowsresult)

The listing, its loading flag and its failure — see
[UseWorkflowsResult](#useworkflowsresult).

#### Example

```tsx
import { useWorkflows } from "@alexkroman1/aai-ui";

// A page rendering its own chrome from the listing — a picker, say. A form
// for ONE workflow wants `<WorkflowFields workflow="name" />` instead,
// which does this lookup itself.
function WorkflowPicker({ onPick }: { onPick: (name: string) => void }) {
  const { workflows, loading, error } = useWorkflows();
  if (loading) return <p>Loading…</p>;
  if (error !== undefined) return <p role="alert">{error}</p>;
  return (
    <ul>
      {workflows.map((summary) => (
        <li key={summary.name}>
          <button type="button" onClick={() => onPick(summary.name)}>
            {summary.description ?? summary.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
```

***

### useWorkflowStream()

```ts
function useWorkflowStream<D extends AnyWorkflowDef>(workflow: string, opts?: UseWorkflowStreamOptions): WorkflowStreamSubmission<WorkflowOutputOf<D>, SubmitInputOf<D>>;
```

Start a workflow run and stream a file into it while it works.

The workflow declares which input property carries the upload
(`workflow({ uploads: ["recording"] })`) — the same declaration
`useWorkflowSubmit` reads, because what the property carries is an upload id
either way. What differs is only WHEN the id becomes valid.

#### Type Parameters

##### D

`D` *extends* [`AnyWorkflowDef`](../aai/workflow-api.md#anyworkflowdef)

#### Parameters

##### workflow

`string`

##### opts?

[`UseWorkflowStreamOptions`](#useworkflowstreamoptions)

#### Returns

[`WorkflowStreamSubmission`](#workflowstreamsubmission)\<[`WorkflowOutputOf`](#workflowoutputof)\<`D`\>, [`SubmitInputOf`](#submitinputof)\<`D`\>\>

#### Example

```tsx no-check
const { submit, run, upload, pending, error } = useWorkflowStream("transcribe");

<Form onSubmit={(values) => submit(values)} error={error}>
  <WorkflowFields workflow="transcribe" />
  <UploadProgressBar upload={upload} />
  <SubmitButton pending={pending}>Transcribe</SubmitButton>
</Form>
```

***

### useWorkflowSubmit()

```ts
function useWorkflowSubmit<D extends AnyWorkflowDef>(workflow: string, opts?: UseWorkflowSubmitOptions): WorkflowSubmission<WorkflowOutputOf<D>, SubmitInputOf<D>>;
```

Start a workflow from a form, and follow the run it creates.

#### Type Parameters

##### D

`D` *extends* [`AnyWorkflowDef`](../aai/workflow-api.md#anyworkflowdef)

The workflow DEFINITION, which types both halves of the
  submission: `submit(input)` takes what the workflow's schema parses to, and
  `run.status === "completed"` narrows to a typed `run.output`.

  It used to be the OUTPUT type alone, and the asymmetry was the bug: a page
  already wrote `WorkflowOutputOf<typeof digest>` to get the output, while
  `submit` took `unknown`, so `submit({ ur1: 42 })` compiled and arrived as a
  400 in the browser. Naming the def instead types the input from the same
  declaration — and `import type` is ERASED, so it costs the bundle nothing.
  Passing an output type where a def belongs is now a compile error rather
  than a silent loss of typing, which is the point.

#### Parameters

##### workflow

`string`

##### opts?

[`UseWorkflowSubmitOptions`](#useworkflowsubmitoptions)

#### Returns

[`WorkflowSubmission`](#workflowsubmission)\<[`WorkflowOutputOf`](#workflowoutputof)\<`D`\>, [`SubmitInputOf`](#submitinputof)\<`D`\>\>

#### Example

```tsx no-check
import { Form, SubmitButton, TextField, useWorkflowSubmit } from "@alexkroman1/aai-ui";
import type { digest } from "./agent.ts";

function DigestForm() {
  const { submit, run, pending, error } = useWorkflowSubmit<typeof digest>("digest");
  return (
    <Form onSubmit={(values) => submit(values)} error={error}>
      <TextField name="url" label="Link" type="url" required />
      <SubmitButton pending={pending}>Digest</SubmitButton>
      {run?.status === "completed" && <p>{run.output.title}</p>}
    </Form>
  );
}
```

***

### WorkflowFields()

```ts
function WorkflowFields(props: {
  workflow?: string | WorkflowSummary;
}): Element | null;
```

Render one field per scalar property of a workflow's input schema.

Pass the workflow's NAME and the schema is fetched here; pass a
[WorkflowSummary](#workflowsummary) you already hold and nothing is fetched. The name form
is the one a page usually wants — it is the same string the submit hook takes,
and the alternative is three lines (`useWorkflows()`, a `.find()` by name, and
folding that lookup's error into the form's) whose only product is this
component's argument.

Renders nothing when the workflow declared no schema — a workflow with no
declared input takes anything, and a form for "anything" is not a form — and
nothing while a named lookup is still in flight, so the hand-written fields
beside it are not reordered when the schema lands.

#### Parameters

##### props

Field-set props.

###### workflow?

`string` \| [`WorkflowSummary`](#workflowsummary)

The workflow whose input schema to render. A NAME is looked up here (one
`GET workflows`); a [WorkflowSummary](#workflowsummary) the page already holds fetches
nothing. `undefined` renders nothing, so a page may pass a selection
straight through before one is made.

#### Returns

`Element` \| `null`

#### Example

```tsx no-check
import { Form, SubmitButton, WorkflowFields, useWorkflowSubmit }
  from "@alexkroman1/aai-ui";
import type { transcribe } from "./agent.ts";

function StartRun() {
  const { submitForm, pending, error } = useWorkflowSubmit<typeof transcribe>("transcribe");
  return (
    <Form onSubmit={submitForm} error={error}>
      <WorkflowFields workflow="transcribe" />
      <SubmitButton pending={pending}>Transcribe</SubmitButton>
    </Form>
  );
}
```

***

### WorkflowProgress()

```ts
function WorkflowProgress(props: {
  api?: WorkflowApi;
  className?: string;
  lines?: number;
  placeholder?: ReactNode;
  runId?: string;
}): ReactNode;
```

What a run has said so far, rendered.

The complement of a status line, and the reason both exist: a run is
`running` for its whole life, so a one-round job and a ten-round one look
identical while they happen. These lines come from the run itself (`report()`
in a `"use step"` body), which is the only channel a workflow has before it
produces an output.

Three rules are baked in, and they are why this is a component rather than
three lines each page writes for itself — the two templates that had written
it had written all three, comments included:

- **It renders nothing until there is something to render.** `supported` is
  what keeps this from being an empty box forever on an agent deployed before
  progress streams existed: "wrote nothing yet" and "serves no stream" are
  indistinguishable from the chunk list alone.
- **The lines are TEXT, not elements.** They are append-only and two rounds
  legitimately produce identical text, so there is no stable per-line key to
  give React. Joining sidesteps the question instead of suppressing the lint
  rule that asks it.
- **They REPLAY.** Chunks are retained with the run, so a reload mid-run —
  or opening a finished run tomorrow — shows how it got there rather than an
  empty box. That is `useWorkflowProgress`'s doing; this is what makes it
  visible.

#### Parameters

##### props

Progress-log props.

###### api?

[`WorkflowApi`](#workflowapi)

The workflow API client, when the page holds its own. Defaults to the
lazily-built one every workflow hook shares.

###### className?

`string`

**Replaces** the default classes rather than extending them, so a custom
chrome is not fighting a default it did not ask for.

###### lines?

`number`

How many of the newest lines to show. Undefined (the default) shows the
whole log; `1` is the newest line only.

A run's narration is append-only and unbounded, so a page with a fixed slot
for it — a status strip, a card footer — wants a window rather than a log.
`0` renders the placeholder, which is the consistent reading of "show none"
and the one that keeps a computed `lines` from silently rendering
everything.

###### placeholder?

`ReactNode`

Rendered instead of nothing while the run has said nothing yet — for a
page that would otherwise reflow when the first line lands.

###### runId?

`string`

The run to read. `undefined` renders nothing, so a page may pass its state
straight through before a run exists.

#### Returns

`ReactNode`

#### Example

```tsx
import { WorkflowProgress } from "@alexkroman1/aai-ui";

function RunPanel({ runId }: { runId: string }) {
  return <WorkflowProgress runId={runId} />;
}
```

## Interfaces

### ToolCallRowProps

Props for [ToolCallRow](#toolcallrow).

#### Properties

##### children?

```ts
optional children?: ReactNode;
```

Expanded panel content. When present the row is expandable: a chevron is
shown and clicking toggles the panel. When absent the row is inert (the
button is disabled). Content provides its own padding and typography;
the panel supplies the top border, surface background, and a max height.

##### className?

```ts
optional className?: string;
```

Additional CSS class names for the outer container.

##### detail?

```ts
optional detail?: ReactNode;
```

One-line detail (typically an args preview), truncated to the row.

##### icon?

```ts
optional icon?: ReactNode;
```

Optional icon rendered in place of the outlined "TOOL" chip.

##### pending?

```ts
optional pending?: boolean;
```

True while the call is in flight — animates the title with a shimmer.

##### title

```ts
title: ReactNode;
```

Tool title, rendered in mono (shimmers while `pending`).

##### variant?

```ts
optional variant?: ToolCallRowVariant;
```

Size preset; defaults to `"default"`.

***

### UseUserTranscriptResult

What [useUserTranscript](#useusertranscript) returns.

#### Properties

##### partial

```ts
partial: string | null;
```

The raw partial: the words so far, `""` while there are none, and `null`
when nobody is speaking. For a chrome that wants to render its own
placeholder (or none).

##### speaking

```ts
speaking: boolean;
```

True while the caller holds the turn — from speech detection to the final
transcript. This is the flag a live-transcript row renders on.

##### text

```ts
text: string;
```

The words so far, or a one-character ellipsis (`…`) while there are none.
Empty string when nobody is speaking.

## Type Aliases

### AgentCustomEvent

```ts
type AgentCustomEvent = {
  data: unknown;
  event: string;
  id: number;
};
```

A custom event emitted by the agent via `ctx.send(event, data)` — the
payload the session records in `SessionSnapshot.customEvents` (`id` is a
monotonic session-unique counter, `event` the name, `data` the payload).

Deliberately NOT the DOM `CustomEvent`: it shares nothing with that
interface, and the old name shadowed the global in `.tsx` files.

#### Properties

##### data

```ts
readonly data: unknown;
```

##### event

```ts
readonly event: string;
```

##### id

```ts
readonly id: number;
```

***

### AgentState

```ts
type AgentState = 
  | "disconnected"
  | "connecting"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";
```

Current state of the voice agent session — the `state` field of
[SessionSnapshot](#sessionsnapshot), and what a chrome paints its status indicator from.

#### Remarks

The seven members, in the order a call passes through them:

- `"disconnected"` — no socket. The state before the first `start()` and
  after `disconnect()` / `end()`.
- `"connecting"` — dialling. Covers the broker lookup and every automatic
  reconnect attempt, so a session flickers back through it mid-call.
- `"ready"` — the socket is open and the handshake is done, but no turn has
  happened yet. **The default chrome paints this with the same live
  indicator as `"listening"`**, which is deliberate — to a caller they are
  the same "the agent is there" — but they are not the same thing, and a
  session can wedge here (see `session-core-handshake.ts`).
- `"listening"` — the microphone is open and the agent is waiting for the
  caller. Check [SessionSnapshot.recording](#recording) for whether the mic is
  actually live.
- `"thinking"` — the caller's turn is committed and the agent is working:
  the LLM step, and any tool calls under it.
- `"speaking"` — the agent's reply is playing. A caller may still barge in;
  the mic stays open throughout.
- `"error"` — the session reported a failure. See
  [SessionSnapshot.error](#error-1) for what it was. A FATAL error latches here
  until the next completed handshake, so a later frame cannot quietly paint
  over the banner explaining a dead call.

***

### ButtonSize

```ts
type ButtonSize = "default" | "lg";
```

Size preset for a [Button](#button).

- `"default"` — Compact control (height 36 px).
- `"lg"` — Primary CTA (height 44 px, generous padding).

***

### ButtonVariant

```ts
type ButtonVariant = "default" | "secondary" | "ghost";
```

Visual style of a [Button](#button) (design-system "website refresh":
rectangular, ALL-CAPS, tracked labels).

- `"default"` — Primary filled button (indigo background).
- `"secondary"` — Outlined primary (transparent background, primary border).
- `"ghost"` — Raised neutral (surface background with hairline border).

***

### ChatMessage

```ts
type ChatMessage = {
  content: string;
  id: number;
  role: "user" | "assistant";
};
```

A chat message exchanged between user and assistant.

`role` is `"user" | "assistant"` only — unlike the SDK's `Message`, there
is no `"tool"` role here. Tool activity never arrives as messages: it is
surfaced via `SessionSnapshot.toolCalls` (or `useEvent` for `ctx.send`
events).

#### Properties

##### content

```ts
content: string;
```

The text content of the message.

##### id

```ts
id: number;
```

Monotonically increasing, session-unique message id assigned at append
time. Stable across snapshot updates and window slides — use it as a
render key.

##### role

```ts
role: "user" | "assistant";
```

The sender of the message.

***

### ClientConfig

```ts
type ClientConfig = Pick<VoiceSessionOptions, "onSessionId" | "resumeSessionId" | "WebSocket"> & {
  buttonText?: string;
  component?: ComponentType;
  icon?: ReactNode;
  name?: string;
  platformUrl?: string;
  sidebar?: ComponentType;
  sidebarPosition?: "left" | "right";
  sidebarWidth?: string;
  subtitle?: string;
  target?: string | HTMLElement;
  theme?: ClientTheme;
  tools?: ToolDisplayConfig;
};
```

Configuration passed to [client](#client).

The session-forwarded fields are picked from [VoiceSessionOptions](#voicesessionoptions)
(one source of truth for types and docs) rather than re-declared — a
re-declared copy is exactly how doc comments drift. It is NOT the session's
own options type: that is [VoiceSessionOptions](#voicesessionoptions), which
`createSessionCore` takes and which three of these fields come from.

#### Type Declaration

##### buttonText?

```ts
optional buttonText?: string;
```

Label of the start CTA. Defaults to `"Start Conversation"`.

##### component?

```ts
optional component?: ComponentType;
```

Full custom component to render instead of the default shell.

It is rendered inside the same providers the default shell gets, so every
session hook, `useTheme` and the tool display config work in it unchanged.

##### icon?

```ts
optional icon?: ReactNode;
```

Element rendered in place of the AAI logo — on the start card, and in the
shell header once the session begins.

Both, because they are one mark: an agent whose start screen shows a slice
of pizza and whose header shows our logo reads as two products.

##### name?

```ts
optional name?: string;
```

Agent name shown in the header and start screen — and, with a `component`,
the page title, there being no shell header to put it in. Left out, the
default shell asks the agent for its own declared name.

##### platformUrl?

```ts
optional platformUrl?: string;
```

Base URL of the AAI platform server. Derived from `location.href` by default.

##### sidebar?

```ts
optional sidebar?: ComponentType;
```

Optional sidebar component rendered alongside the main pane.

Beside a `component` it is the custom component that becomes the main pane,
in the same [SidebarLayout](#sidebarlayout) the default shell uses.

##### sidebarPosition?

```ts
optional sidebarPosition?: "left" | "right";
```

Which side the sidebar sits on. Defaults to `"left"`.

Routed through the same [SidebarLayout](#sidebarlayout) whether the main pane is the
default shell or a `component`, for the reason `sidebar` itself is: the two
branches build the same layout and a field honoured by only one of them is
the shape this config used to have.

##### sidebarWidth?

```ts
optional sidebarWidth?: string;
```

CSS width of the sidebar. Defaults to `"18rem"`.

##### subtitle?

```ts
optional subtitle?: string;
```

A line under the title on the start card.

##### target?

```ts
optional target?: string | HTMLElement;
```

CSS selector or DOM element to render into. Defaults to `"#app"`.

##### theme?

```ts
optional theme?: ClientTheme;
```

Theme color overrides.

##### tools?

```ts
optional tools?: ToolDisplayConfig;
```

Tool display config: icon and label overrides keyed by tool name.

Honoured with a custom `component` too: [client](#client) installs it into
`ToolConfigContext`, and the consumer is `ToolCallBlock` — which a custom
component renders as soon as it uses `MessageList` or `ChatView`, the usual
way to build one.

#### Remarks

**One flat type, not a union of tiers.** `component` is what decides which
shell renders — absent, the default one (StartScreen + ChatView, optional
sidebar); present, the caller's own component inside the same providers —
and that decision is made at runtime, where every field can be honoured. It
used to be a union whose two arms banned each other's fields with `?: never`,
and the failure that shape produces is recorded twice in this file's history:
`client({ name, component })` and `client({ component, tools })` were both
the natural thing to write, both were refused with *"Type 'string' is not
assignable to type 'undefined'"*, and both cost a build round each time
before the ban was lifted. What was left banned was `sidebar` beside a
`component`, which invited the identical failure for a combination
[client](#client) can simply render.

***

### ClientConfigResponse

```ts
type ClientConfigResponse = z.infer<typeof ClientConfigResponseSchema>;
```

Parsed body of `GET /client-config`.

***

### ClientHandle

```ts
type ClientHandle = {
  session: SessionCore;
  [dispose]: void;
  dispose: void;
};
```

Handle returned by [client](#client) for cleanup.

Implements `Disposable` so it can be used with `using`.

#### Methods

##### \[dispose\]()

```ts
dispose: void;
```

Alias for `dispose` for use with `using`.

###### Returns

`void`

##### dispose()

```ts
dispose(): void;
```

Unmount the UI and disconnect the session.

###### Returns

`void`

#### Properties

##### session

```ts
session: SessionCore;
```

The underlying session core.

***

### ClientTheme

```ts
type ClientTheme = {
  bg?: string;
  border?: string;
  primary?: string;
  surface?: string;
  text?: string;
};
```

Theme color overrides for the AAI UI components.

#### Properties

##### bg?

```ts
optional bg?: string;
```

Background color, also painted on `html`/`body`. Default: `#FBF8F2`.

##### border?

```ts
optional border?: string;
```

Border color. Default: `#DCD7CC`.

##### primary?

```ts
optional primary?: string;
```

Primary accent color. Default: `#3F2BC1`.

##### surface?

```ts
optional surface?: string;
```

Surface/card color. Default: `#FFFFFF`.

##### text?

```ts
optional text?: string;
```

Main text color. Default: `#1B1A18`.

***

### ConsoleShellProps

```ts
type ConsoleShellProps = {
  children: ReactNode;
  className?: string;
  error?: string | null;
  footer: ReactNode;
  icon?: ReactNode;
  pulsing: boolean;
  state: AgentState;
  title?: string;
};
```

Props of [ConsoleShell](#consoleshell).

#### Properties

##### children

```ts
children: ReactNode;
```

Card content — normally a [MessageList](#messagelist).

##### className?

```ts
optional className?: string;
```

Additional CSS class names for the root element, appended to its own.

##### error?

```ts
optional error?: string | null;
```

Error banner text; `null`/`undefined` hides the banner.

Pass `session.error?.message` — the banner is announced, which a
hand-rolled `<div>` in a custom chrome is not. See the `role="alert"`
comment below for why that matters more here than it looks.

##### footer

```ts
footer: ReactNode;
```

Row rendered beneath the card (controls).

##### icon?

```ts
optional icon?: ReactNode;
```

Element rendered in place of the logo in the header.

##### pulsing

```ts
pulsing: boolean;
```

Whether the status dot pulses.

##### state

```ts
state: AgentState;
```

Live status shown in the header eyebrow.

##### title?

```ts
optional title?: string;
```

Title string for the header.

***

### ControlsProps

```ts
type ControlsProps = {
  className?: string;
};
```

Props of [Controls](#controls).

#### Properties

##### className?

```ts
optional className?: string;
```

Additional CSS class names, appended to the container's own layout
classes rather than replacing them.

***

### ConversationItem

```ts
type ConversationItem = 
  | {
  kind: "message";
  message: ChatMessage;
}
  | {
  kind: "tool";
  toolCall: ToolCallInfo;
};
```

One row of the conversation: a finalized message, or a tool invocation.

A discriminated union rather than two arrays, because the ORDER between them
is the thing this hook computes — handing back two lists would hand back the
problem. `kind` is what a `switch` in a custom renderer narrows on.

***

### FieldShell

```ts
type FieldShell = {
  className?: string;
  hint?: string;
  label?: string;
  name: string;
};
```

The props every field in `form.tsx` shares.

Public because it is part of each field's own signature — a type reachable
from a documented one has to be reachable from the entry point too, which the
docs build enforces.

#### Properties

##### className?

```ts
optional className?: string;
```

Additional CSS class names for the field's WRAPPER (label + control +
hint), appended to its own layout classes. The control itself takes the
shared field styling; pass `style` or a `data-` hook through the native
attributes to reach it.

##### hint?

```ts
optional hint?: string;
```

One line of guidance under the control.

##### label?

```ts
optional label?: string;
```

Visible label. Omitted leaves the control unlabelled — pass `aria-label` instead.

##### name

```ts
name: string;
```

Key this field contributes to [FormValues](#formvalues).

***

### FileRead

```ts
type FileRead = "none" | "text" | "dataUrl" | "upload";
```

How much of a chosen file a [FileField](#filefield) reads.

`"upload"` is the odd one and the one a workflow input wants: the field
contributes the `File` ITSELF rather than a description of it, and
`useWorkflowSubmit` then stores it through `POST /workflows/uploads` and puts
the id in the run input. Bytes cannot travel in a run input — see
[FileField](#filefield) — so this is how a form takes a file at all.

***

### FileValue

```ts
type FileValue = {
  content?: string;
  lastModified: number;
  name: string;
  size: number;
  type: string;
};
```

What a [FileField](#filefield) contributes to [FormValues](#formvalues).

#### Properties

##### content?

```ts
optional content?: string;
```

The file's contents, present only when the field asked for them — see
[FileField](#filefield)'s `read` prop. A `data:` URL for `"dataUrl"`, decoded text
for `"text"`.

##### lastModified

```ts
lastModified: number;
```

Last modified, as epoch ms.

##### name

```ts
name: string;
```

##### size

```ts
size: number;
```

Size in bytes.

##### type

```ts
type: string;
```

MIME type the browser reported, or `""` when it could not tell.

***

### FormProps

```ts
type FormProps = {
  children?: ReactNode;
  className?: string;
  error?: string;
  onSubmit: (values: FormValues) => void | Promise<void>;
} & Omit<FormHTMLAttributes<HTMLFormElement>, "onSubmit" | "className">;
```

Props of [Form](#form).

#### Type Declaration

##### children?

```ts
optional children?: ReactNode;
```

##### className?

```ts
optional className?: string;
```

##### error?

```ts
optional error?: string;
```

A failure to show above the fields. The caller owns it, because the
interesting failures are the server's (`useWorkflowSubmit`'s `error`) and
this component never sees them.

##### onSubmit

```ts
(values: FormValues) => void | Promise<void>
```

Called with the collected values. May be async — the form stays disabled
for the duration, so a double-click cannot submit twice.

***

### FormValues

```ts
type FormValues = Record<string, unknown>;
```

One submitted form, as a plain object keyed by field name.

`unknown` values rather than `string`: see the module doc — a number field
yields a number and a file field yields a [FileValue](#filevalue).

***

### MarkdownProps

```ts
type MarkdownProps = {
  text: string;
  variant?: MarkdownVariant;
};
```

Props of [Markdown](#markdown).

#### Properties

##### text

```ts
text: string;
```

The Markdown source. Required — this is the prose to render, normally one
agent message or the streaming tail of one.

##### variant?

```ts
optional variant?: MarkdownVariant;
```

Type scale. Defaults to `"default"`, the deployed agent UI's scale; pass
`"compact"` for a denser surface. Colors are unaffected either way.

***

### MarkdownVariant

```ts
type MarkdownVariant = "default" | "compact";
```

Type scale for [Markdown](#markdown): `"default"` is the deployed agent UI's
scale, `"compact"` a notch smaller for denser surfaces (the studio's chat
transcript). Colors are unaffected — they come from the theme either way.

***

### MessageListProps

```ts
type MessageListProps = {
  className?: string;
};
```

Props of [MessageList](#messagelist).

#### Properties

##### className?

```ts
optional className?: string;
```

Additional CSS class names for the outer scroll container, appended to its
own rather than replacing them.

The container is an [AutoScroll](#autoscroll), so it must end up with a BOUNDED
height (`flex-1 min-h-0`, `h-full`, a fixed height). Unbounded, it grows
with the conversation and never scrolls, so nothing pins to the newest
message.

***

### PageConfig

```ts
type PageConfig = {
  component: ComponentType;
  name?: string;
  target?: string | HTMLElement;
  theme?: ClientTheme;
};
```

Configuration for [page](#page).

#### Properties

##### component

```ts
component: ComponentType;
```

The root component. Required — a workflow app has no default shell to fall
back to, because there is no session for one to render.

##### name?

```ts
optional name?: string;
```

Page title. Set only when given, so a title the HTML shell declared is never
clobbered — the same rule `client()`'s custom-component tier follows.

##### target?

```ts
optional target?: string | HTMLElement;
```

CSS selector or DOM element to render into. Defaults to `"#app"`.

##### theme?

```ts
optional theme?: ClientTheme;
```

Theme color overrides, read by the same tokens the voice components use.

***

### PageHandle

```ts
type PageHandle = {
  [dispose]: void;
  dispose: void;
};
```

Handle returned by [page](#page). `Disposable`, so `using` works.

#### Methods

##### \[dispose\]()

```ts
dispose: void;
```

Alias for `dispose` for use with `using`.

###### Returns

`void`

##### dispose()

```ts
dispose(): void;
```

Unmount the React tree.

###### Returns

`void`

***

### Session

```ts
type Session = SessionSnapshot & Pick<SessionCore, 
  | "start"
  | "cancel"
  | "resetState"
  | "reset"
  | "disconnect"
  | "toggle"
| "end">;
```

What [useSession](#usesession) returns: the live [SessionSnapshot](#sessionsnapshot) fields
(`state`, `messages`, `toolCalls`, `agentState`, live transcripts, `error`,
`apiUrl`, `started`/`running`/`recording`, …) merged with the session's
control methods (`start`, `toggle`, `reset`, `resetState`, `disconnect`,
`cancel`, `end`).

Note there is no text-send method — sessions are voice-only; the only
client→server inputs are audio and the control methods above.

Method signatures come from [SessionCore](#sessioncore) — one source of truth.

***

### SessionCore

```ts
type SessionCore = {
  [dispose]: void;
  cancel: void;
  connect: void;
  disconnect: void;
  end: void;
  getSnapshot: SessionSnapshot;
  reset: void;
  resetState: void;
  start: void;
  subscribe: () => void;
  toggle: void;
};
```

A framework-agnostic voice session that manages WebSocket communication,
audio capture/playback, and agent state transitions.

Uses a subscribe/getSnapshot pattern (compatible with React's
`useSyncExternalStore`). Implements `Disposable` for resource cleanup.

#### Methods

##### \[dispose\]()

```ts
dispose: void;
```

Alias for `disconnect` for use with `using`.

###### Returns

`void`

##### cancel()

```ts
cancel(): void;
```

Cancel the current agent turn and discard in-flight TTS audio.

###### Returns

`void`

##### connect()

```ts
connect(options?: {
  signal?: AbortSignal;
}): void;
```

Open a WebSocket connection to the server and begin audio capture,
without touching the `started`/`running` flags — the low-level half of
`start()`. Most UIs call `start()` (first activation) or `toggle()`
(mute-style connect/disconnect) instead.

###### Parameters

###### options?

Optional. `signal` is an AbortSignal that, when aborted, disconnects the session.

###### signal?

`AbortSignal`

###### Returns

`void`

##### disconnect()

```ts
disconnect(): void;
```

Close the WebSocket and release all audio resources.

###### Returns

`void`

##### end()

```ts
end(): void;
```

End the call: close the connection, clear the conversation, and return
to the not-started state (`started` flips back to false, so a
start-screen UI shows its Start control again). Unlike `reset()` —
which keeps the call live and only clears the conversation — the next
`start()` mints a brand-new session: a new session id, fresh
per-session tool state, greeting included.

###### Returns

`void`

##### getSnapshot()

```ts
getSnapshot(): SessionSnapshot;
```

Return the current immutable state snapshot.

###### Returns

[`SessionSnapshot`](#sessionsnapshot)

##### reset()

```ts
reset(): void;
```

Reset the session: clear state as `resetState()` does, then drop and
reopen the connection for a fresh conversation.

###### Returns

`void`

##### resetState()

```ts
resetState(): void;
```

Clear messages, transcripts, and error state while keeping the current
connection (unlike `reset()`, which also reconnects).

###### Returns

`void`

##### start()

```ts
start(): void;
```

Start the session for the first time: sets `started` and `running`, then
connects. Use this for the initial "start conversation" action;
afterwards `toggle()` is the pause/resume control.

###### Returns

`void`

##### subscribe()

```ts
subscribe(callback: () => void): () => void;
```

Subscribe to state changes. Returns an unsubscribe function.

###### Parameters

###### callback

() => `void`

###### Returns

() => `void`

##### toggle()

```ts
toggle(): void;
```

Toggle between connected and disconnected states (after `start()`).

###### Returns

`void`

***

### SessionError

```ts
type SessionError = {
  code: SessionErrorCode;
  fatal: boolean;
  message: string;
};
```

Error reported by the voice session.

#### Properties

##### code

```ts
readonly code: SessionErrorCode;
```

The category of the error.

##### fatal

```ts
readonly fatal: boolean;
```

Whether the session is OVER.

`false` means surface the message and keep the session interactive — a
turn-level failure over a server that kept running. `true` means the call
is dead and the microphone has been released.

Required rather than optional, because the wire always carries it
(`error.reported` declares `fatal: z.boolean()`) and a client that cannot
tell the two apart has to guess which banner to render. It was dropped one
line before reaching here for long enough that this type's own doc, and
the reference page generated from it, described a field that did not
exist.

##### message

```ts
readonly message: string;
```

A human-readable description of the error.

***

### SessionErrorCode

```ts
type SessionErrorCode = z.infer<typeof SessionErrorCodeSchema>;
```

Error codes for categorizing session errors on the wire.

#### Remarks

The field a client renders its error banner from (`error.reported.code`, and
`SessionError.code` in `@alexkroman1/aai-ui`). Eight values, by where the
failure came from:

- `stt` — speech-to-text: the provider refused the connection, or its stream
  failed mid-utterance.
- `llm` — the model call for a reply failed. In pipeline mode the caller also
  hears `errorPhrase`, so the turn is handed back rather than going silent.
- `tts` — synthesis failed, which is the one the caller cannot hear.
- `tool` — a tool threw and the failure could not be given to the model.
- `protocol` — a frame that does not parse, or one sent in a state that has
  no answer for it.
- `connection` — the session's own link, or a provider's, went away.
- `audio` — the audio path: a rate the transport cannot honour, a decode.
- `internal` — anything the runtime could not classify.

**Severity is `fatal`, not the code**, and the two are independent: any of
these can arrive on a session that continues. `fatal: false` means surface
the message and keep the session interactive. It is REQUIRED: a fatal frame
is not a banner — `aai-ui` answers one by releasing the microphone and ending
the call — so every emitter states which it means rather than inheriting a
default that takes the whole session down.

***

### SessionSnapshot

```ts
type SessionSnapshot = {
  agentState: unknown;
  agentTranscript: string | null;
  apiUrl: string;
  contentVersion: number;
  customEvents: AgentCustomEvent[];
  error: SessionError | null;
  messages: ChatMessage[];
  recording: boolean;
  running: boolean;
  started: boolean;
  state: AgentState;
  toolCalls: ToolCallInfo[];
  userTranscript: string | null;
};
```

Immutable snapshot of the session state.

Consumers (e.g. React hooks via `useSyncExternalStore`) read this to render.
A new object reference is created on every state change.

#### Remarks

**Four fields describe liveness and they answer different questions.** They
are routinely collapsed into one truthy check, which is how a chrome ends up
showing a live indicator over a call that has ended:

| Field | The question it answers |
| --- | --- |
| `started` | Has the caller pressed Start? `end()` puts it back to `false`; `disconnect()` does not. |
| `running` | Is the socket MEANT to be up? `toggle()` is what flips it. |
| `recording` | Is the microphone actually live right now? |
| `state` | What is the agent doing — see [AgentState](#agentstate). |

#### Properties

##### agentState

```ts
readonly agentState: unknown;
```

Latest state the agent projected via `syncState`, or `null` before the
first push. A value, not a log — a component that mounts mid-session
reads current state rather than replaying events it missed.

##### agentTranscript

```ts
readonly agentTranscript: string | null;
```

The agent's reply as it streams, or `null` when it is not speaking.
Cleared when the reply is committed to `messages`, so a chrome renders
this row and the finished message, never both.

##### apiUrl

```ts
readonly apiUrl: string;
```

The WebSocket URL a program can connect to directly — the long-living
platform endpoint, e.g. `wss://host/my-agent/websocket`. Derived from
`platformUrl` at construction — available before connecting — and never
replaced by the brokered sandbox tunnel URL the session may actually be
connected to: that URL is ephemeral (it dies when the sandbox is
replaced), while the platform endpoint is stable and upgrades
programmatic clients to the current sandbox endpoint itself.

##### contentVersion

```ts
readonly contentVersion: number;
```

Monotonically increasing counter bumped whenever rendered conversation
content changes (`messages`, `toolCalls`, or either live transcript).
Cheap dependency for scroll-to-bottom effects — unlike summed lengths it
never collides when the capped arrays slide.

##### customEvents

```ts
readonly customEvents: AgentCustomEvent[];
```

Custom events the agent pushed with `ctx.send(event, data)`, in order.
A LOG rather than a value — `useEvent(name, cb)` is the reader that
delivers each one exactly once; reading this array directly means owning
the cursor yourself.

##### error

```ts
readonly error: SessionError | null;
```

The session's current failure, or `null`. Carries a `code`
([SessionErrorCode](#sessionerrorcode)), a message, and whether it was FATAL.

A fatal error LATCHES: nothing clears it but the next completed handshake,
because the frame announcing a session's death is also the frame that used
to wipe the message explaining it. A non-fatal one is retired by later
activity, which is what the recovery was written for.

##### messages

```ts
readonly messages: ChatMessage[];
```

The conversation so far, oldest first — user and assistant turns only.
Tool activity is NOT in here; it is in `toolCalls`. Capped, so the oldest
entries slide off a long call.

##### recording

```ts
readonly recording: boolean;
```

True while the microphone is live and streaming to the server.

This is the mic, not the session: a session can be `running` with the mic
still opening, and a failure to acquire it leaves this `false` with the
socket up.

##### running

```ts
readonly running: boolean;
```

Whether the session is MEANT to be connected — the pause/resume state
`toggle()` flips, not a report of the socket. A reconnecting session is
still `running`.

##### started

```ts
readonly started: boolean;
```

Whether the caller has pressed Start. `false` until the first `start()`,
and back to `false` after `end()` — which is what makes a start-screen
chrome show its Start control again. `disconnect()` leaves it `true`.

##### state

```ts
readonly state: AgentState;
```

What the agent is doing. See [AgentState](#agentstate) for the seven members.

##### toolCalls

```ts
readonly toolCalls: ToolCallInfo[];
```

Every tool call the agent has made this session, in order, each carrying
its own pending/settled state. Capped like `messages`. `useToolResult` and
`useToolCallStart` are the narrow readers; this is the whole log.

##### userTranscript

```ts
readonly userTranscript: string | null;
```

The caller's in-progress turn, as STT reports it.

**`null` and `""` are different turns, and collapsing them is the mistake
this field invites.** `null` is silence; `""` is speech DETECTED with no
words back yet — where a live session sits for a few hundred milliseconds
at the start of every turn. Read as one falsy check, the live-transcript
row appears a beat late, on the first word rather than on the first sound,
which is the moment it exists for.

Prefer [useUserTranscript](#useusertranscript), which returns the distinction as two
named things (`speaking` to render on, `text` with a placeholder) rather
than leaving each chrome to re-derive the ternary.

Cleared when the turn is committed to `messages`.

***

### SubmitInputOf

```ts
type SubmitInputOf<D> = [WorkflowInputOf<D>] extends [never] ? undefined : WorkflowInputOf<D>;
```

What `submit()` takes for `D` — `undefined` when `D` declares no schema.

This is what [WorkflowInputOf](#workflowinputof) cannot say on its own: a def whose
`input` schema is absent has no parsed input, and `never` as a parameter type
accepts nothing at all — not even `undefined` — so a workflow that declares
no schema would have an uncallable `submit`. It gets `undefined` instead, i.e.
`submit(undefined)`. Explicit rather than `void`, which would let the argument
be omitted and which Biome's `noConfusingVoidType` rejects outside a return or
type-parameter position.

The `[T] extends [never]` spelling is deliberate: a bare `T extends never`
distributes over a naked type parameter and answers `never` for a union.

#### Type Parameters

##### D

`D`

***

### ToolCallInfo

```ts
type ToolCallInfo = {
  afterMessageId: number;
  args: Record<string, DefaultToolResult>;
  callId: string;
  name: string;
  result?: string;
  seq: number;
  status: "pending" | "done";
};
```

Info about a tool call for display in the UI.

#### Properties

##### afterMessageId

```ts
afterMessageId: number;
```

`id` of the last [ChatMessage](#chatmessage) present when this tool call was
inserted (`-1` when there were none). The tool call renders immediately
after that message; if the anchor message has slid out of the retained
window, the tool call renders before all messages.

##### args

```ts
args: Record<string, DefaultToolResult>;
```

The tool's arguments, as the model sent them.

Values are [DefaultToolResult](../aai/index.md#defaulttoolresult) — `any` — for the same reason a tool
*result* is: the shape is the author's own Zod schema, which the framework
cannot see from here. As `Record<string, unknown>` the ordinary
`toolCall.args.url` was a compile error in a client that runs correctly,
and the escape hatch agents reached for next (`args as FetchJsonArgs`) is
itself an error — TypeScript rejects the cast as insufficiently
overlapping. That pair cost two build rounds in one run.

Annotate at the read site for real checking:
`const { url } = toolCall.args as { url: string }` is still available, and
now actually compiles.

##### callId

```ts
callId: string;
```

##### name

```ts
name: string;
```

##### result?

```ts
optional result?: string;
```

##### seq

```ts
seq: number;
```

Monotonically increasing, session-unique insertion sequence number.
Tool calls in a snapshot are always sorted ascending by `seq`.

##### status

```ts
status: "pending" | "done";
```

***

### ToolCallRowVariant

```ts
type ToolCallRowVariant = "default" | "compact";
```

Size preset for [ToolCallRow](#toolcallrow): `"default"` is the deployed agent
UI's scale, `"compact"` the studio transcript's denser one.

***

### ToolDisplayConfig

```ts
type ToolDisplayConfig = Record<string, {
  icon?: string;
  label?: string;
}>;
```

Display configuration for a tool call in the UI.

***

### UploadStatus

```ts
type UploadStatus = UploadProgress & {
  count: number;
  index: number;
  name: string;
  paused: boolean;
};
```

What [WorkflowSubmission.upload](#upload-1) reports while the bytes are going.

The SDK's per-request [UploadProgress](../aai/workflow-api.md#uploadprogress) plus WHICH file it describes,
because a form is allowed more than one and a bar over "the upload" would
restart at zero partway through with nothing to say why.

#### Type Declaration

##### count

```ts
count: number;
```

How many files this submission sends in total.

##### index

```ts
index: number;
```

Which file of the submission this is, counting from 1.

##### name

```ts
name: string;
```

The file being sent, by the name the picker gave it.

##### paused

```ts
paused: boolean;
```

Whether the person has parked this upload.

A paused upload is not a stopped one: the windows already stored stay stored,
`loaded` holds where it got to, and resuming sends what is missing rather than
the file. So a bar rendering this reads "Paused at 62%", never "62% and
frozen" — which is what a page could otherwise only guess from a number that
stopped moving, the same ambiguity `complete` exists to remove on the run side.

***

### UseConversationResult

```ts
type UseConversationResult = {
  items: readonly ConversationItem[];
  streaming: string | null;
  thinking: boolean;
  transcript: UseUserTranscriptResult;
};
```

What [useConversation](#useconversation) returns.

#### Properties

##### items

```ts
items: readonly ConversationItem[];
```

Messages and tool calls in one list, in the order they happened.

Referentially stable while neither array changes, so a consumer may map it
inside a `useMemo` keyed on it, or hand rows to `memo()`ed components,
without rebuilding the list on unrelated snapshot updates.

##### streaming

```ts
streaming: string | null;
```

The agent's utterance as it arrives, or `null` between turns.

Not yet a member of `items`: it has no id and it is replaced wholesale on
every delta, so it is rendered as its own trailing row and disappears when
the finalized message takes its place.

##### thinking

```ts
thinking: boolean;
```

Whether to show a thinking indicator.

The suppression rule, and it is why this is a field rather than
`state === "thinking"`: the agent is `thinking` for a stretch during which
something ELSE is already saying so. A pending tool call draws its own
spinner, and a trailing agent message means the reply has begun landing —
in both cases a second indicator underneath reads as a second thing
happening. So it is on only while `thinking` with no pending tool call, and
either no messages yet, a trailing USER message, or a settled tool call
after it.

##### transcript

```ts
transcript: UseUserTranscriptResult;
```

The caller's in-progress turn — [useUserTranscript](#useusertranscript)'s result,
forwarded rather than re-derived, so the `null`-vs-`""` distinction is made
in exactly one place.

***

### UseDownloadUrlOptions

```ts
type UseDownloadUrlOptions = {
  api?: WorkflowApi;
};
```

Options for [useDownloadUrl](#usedownloadurl).

#### Properties

##### api?

```ts
optional api?: WorkflowApi;
```

The client to read the bytes with. Defaults to one for the page's own agent.

***

### UseDownloadUrlResult

```ts
type UseDownloadUrlResult = {
  error?: string;
  pending: boolean;
  url?: string;
};
```

What [useDownloadUrl](#usedownloadurl) reports.

#### Properties

##### error?

```ts
optional error?: string;
```

The read's failure, as the agent's own sentence where it gave one.

##### pending

```ts
pending: boolean;
```

True while the bytes are on their way.

Its own field rather than "neither `url` nor `error`", which cannot tell a
download in flight from no id to download — the two states a page most
wants to render differently (a spinner, and nothing at all).

##### url?

```ts
optional url?: string;
```

An object URL for the stored bytes, once they are here. Valid until the id
changes or the component unmounts — do not stash it anywhere that outlives
the render that read it.

***

### UseWorkflowProgressResult

```ts
type UseWorkflowProgressResult<T = string> = {
  latest: T | undefined;
  progress: T[];
  streaming: boolean;
  supported: boolean;
};
```

#### Type Parameters

##### T

`T` = `string`

#### Properties

##### latest

```ts
latest: T | undefined;
```

The newest chunk, or undefined before the first one lands.

##### progress

```ts
progress: T[];
```

Every chunk the run has written, oldest first.

##### streaming

```ts
streaming: boolean;
```

True while the run is still being read — it may yet say more.

##### supported

```ts
supported: boolean;
```

False once the agent has answered that it does not serve this route.

Distinguishes "this deploy predates progress streams" from "the run has not
written anything yet", which look identical from `progress` alone. A page
uses it to hide the section rather than show an empty one forever.

***

### UseWorkflowRunResult

```ts
type UseWorkflowRunResult<R = unknown> = {
  error: string | undefined;
  polling: boolean;
  run: WorkflowRun<R> | undefined;
};
```

#### Type Parameters

##### R

`R` = `unknown`

#### Properties

##### error

```ts
error: string | undefined;
```

The last read's failure, cleared by the next successful one.

##### polling

```ts
polling: boolean;
```

True while a non-terminal run is still being watched.

##### run

```ts
run: WorkflowRun<R> | undefined;
```

Latest snapshot, or undefined before the first read lands.

***

### UseWorkflowRunsOptions

```ts
type UseWorkflowRunsOptions = {
  api?: WorkflowApi;
  key?: string;
  limit?: number;
  skip?: boolean;
};
```

Options for [useWorkflowRuns](#useworkflowruns).

#### Properties

##### api?

```ts
optional api?: WorkflowApi;
```

The client to read with. Defaults to one for the page's own agent.

##### key?

```ts
optional key?: string;
```

Narrow to one correlation key — the `key` a run was started with.

Omitted, the list is every recent run of the workflow, which is what an
operator's page wants. A page showing "your" runs passes the key it started
them with; there is no per-user filtering behind this, so the key IS the
scoping mechanism.

##### limit?

```ts
optional limit?: number;
```

Most runs to return, newest first. The agent clamps its own ceiling.

##### skip?

```ts
optional skip?: boolean;
```

Skip the read entirely — for a page that does not know its workflow yet.

***

### UseWorkflowRunsResult

```ts
type UseWorkflowRunsResult<R = unknown> = {
  error: string | undefined;
  loading: boolean;
  refresh: () => void;
  runs: WorkflowRun<R>[];
};
```

What [useWorkflowRuns](#useworkflowruns) reports.

#### Type Parameters

##### R

`R` = `unknown`

#### Properties

##### error

```ts
error: string | undefined;
```

The read's failure, alongside an empty list — which is why it exists.

##### loading

```ts
loading: boolean;
```

True until the first read settles, and during an explicit refresh.

##### refresh

```ts
refresh: () => void;
```

Re-read now. Call it when a run this page started reaches a terminal status.

###### Returns

`void`

##### runs

```ts
runs: WorkflowRun<R>[];
```

The runs, newest first. Empty until the first read lands.

***

### UseWorkflowsOptions

```ts
type UseWorkflowsOptions = {
  api?: WorkflowApi;
  skip?: boolean;
};
```

Options for [useWorkflows](#useworkflows).

#### Properties

##### api?

```ts
optional api?: WorkflowApi;
```

The client to read the listing with. Defaults to one for the page's own agent.

##### skip?

```ts
optional skip?: boolean;
```

Skip the lookup entirely, reporting an empty listing that is not loading.

For a caller that may or may not need the listing and cannot decide with a
conditional hook — `<WorkflowFields>` handed a summary rather than a name is
the one in this package. It reports `loading: false`, because a skipped
lookup is finished rather than pending.

***

### UseWorkflowsResult

```ts
type UseWorkflowsResult = {
  error: string | undefined;
  loading: boolean;
  workflows: WorkflowSummary[];
};
```

What [useWorkflows](#useworkflows) reports.

#### Properties

##### error

```ts
error: string | undefined;
```

The lookup's failure. Set alongside an EMPTY list, which is why it exists.

##### loading

```ts
loading: boolean;
```

True until the listing lands, so a form can hold its fields back.

##### workflows

```ts
workflows: WorkflowSummary[];
```

The agent's declared workflows, each with the JSON Schema of its input.

***

### UseWorkflowStreamOptions

```ts
type UseWorkflowStreamOptions = Omit<UseWorkflowSubmitOptions, "wait" | "recover">;
```

Options for [useWorkflowStream](#useworkflowstream).

[UseWorkflowSubmitOptions](#useworkflowsubmitoptions) without `wait`, which is the synchronous
mode: it holds the `POST` open until the run settles, and here the run is
started before its bytes are, so there is nothing left to hold it for.

Without `recover` either, and REFUSED rather than ignored: an option a hook
accepts and does nothing with is the silent-no-op failure this repo keeps
paying for. Adopting an earlier run by key would hand this hook a run whose
input names an upload id it did not mint and is not filling — so the run
would sit waiting for bytes nobody is sending until its own abandonment
bound. That is the same reason `_upload-recall.ts` deliberately does not
recall for this hook, one layer up: here the id is part of a run's INPUT.
`key` itself still works, and still makes the run findable — but it is NOT
defaulted here the way `useWorkflowSubmit` defaults it, because the whole
value of that default is the lookup this hook refuses, and minting a key
nothing will ever read back is a slot left in storage for no one.

`parallel` COMPOSES with what this hook is for rather than competing with it.
The run still starts before the bytes, and the store still publishes how far
the file is readable — that number is the CONTIGUOUS prefix, so a run reading
ahead of the uplink sees the same growing file whether one connection or four
are filling it. What changes is only how fast it grows.

***

### UseWorkflowSubmitOptions

```ts
type UseWorkflowSubmitOptions = {
  api?: WorkflowApi;
  intervalMs?: number;
  key?: string;
  parallel?: UploadParallel;
  recover?: boolean;
  wait?: number;
};
```

Options for [useWorkflowSubmit](#useworkflowsubmit).

#### Properties

##### api?

```ts
optional api?: WorkflowApi;
```

The client to start runs with. Defaults to one for the page's own agent.

##### intervalMs?

```ts
optional intervalMs?: number;
```

How often the fallback poll re-reads a live run.

##### key?

```ts
optional key?: string;
```

Correlation key recorded with the run, for finding it again without the id.

**Defaulted**, to an opaque per-page key in `sessionStorage` that the next
load produces again — `useRunKey()`'s, minted by the hook. Pass one to
scope runs to something the page knows better: an ACCOUNT's own id, which
is what makes a run follow the person to a new device, or
`useRunKey({ storage: "local" })` for a run that outlives the tab by
design. The key is a lookup CAPABILITY (there is no per-user filtering
behind `find`), it must fit the route's 256-character bound, and anything
derived from a person's own input both collides and carries what they
typed — `use-run-key.ts` argues every alternative.

##### parallel?

```ts
optional parallel?: UploadParallel;
```

Send each chosen file as concurrent parts instead of in one request.

**On by default.** `false` opts out, `{ partBytes, concurrency }` tunes it.
This is the wait a form with a recording in it actually spends: the run does
not exist until its input is stored, so until the last byte lands there is no
run to watch and nothing for `<WorkflowProgress>` to say. Splitting the file
across connections is what makes that stretch shorter, and it degrades to the
single request wherever it would not help — a small file, an older agent — so
the default costs nothing where it would not have paid. See
`UploadOptions.parallel`.

##### recover?

```ts
optional recover?: boolean;
```

On mount, adopt the newest run this `key` already has.

**This is what makes a reload survivable, and it is ON.** The run id is
this hook's own state, so a refresh loses it while the run carries on — and
a page that cannot name a run cannot show it, cancel it or wake it. The
hook asks `find(workflow, key)` once as it mounts and follows whatever
comes back, so the answer, the progress and the controls are all there
again.

It used to be opt-in, on the argument that a `key` alone means only "record
this with the run" — true of `ctx.workflows.start({ key })`, where there is
no page to put a run back on, and not of a form: six of six page templates
passed `useRunKey()` and `recover: true` together, which is a default in
the wrong place. `false` is the opt-out, and what it buys is a form that
always opens empty — no lookup on mount, and a live run reachable only by
an id the page has already lost.

##### wait?

```ts
optional wait?: number;
```

Hold the `POST` open until the run settles, up to this many ms — the
synchronous mode. Omitted (the default) returns as soon as the run exists.

***

### VoiceSessionOptions

```ts
type VoiceSessionOptions = {
  onSessionId?: (sessionId: string) => void;
  platformUrl: string;
  resumeSessionId?: string;
  WebSocket?: WebSocketConstructor;
};
```

Options for creating a voice session — the shared field set accepted by
both `client()` and `createSessionCore`. The one difference: `client()`
defaults `platformUrl` from `location.href`, while `createSessionCore`
requires it.

#### Properties

##### onSessionId?

```ts
optional onSessionId?: (sessionId: string) => void;
```

Called when the server sends a session ID in the config message.
Use this to store the ID (e.g. in localStorage) for reconnection
via `resumeSessionId`.

Treat session IDs as sensitive: whoever holds one can resume the
session and read its replayed history. They travel as a WebSocket
query parameter (browsers cannot set WS headers), so they may appear
in proxy and server access logs — don't put them in shared URLs.

###### Parameters

###### sessionId

`string`

###### Returns

`void`

##### platformUrl

```ts
platformUrl: string;
```

Base URL of the AAI platform server.

##### resumeSessionId?

```ts
optional resumeSessionId?: string;
```

Session ID from a previous connection. When set, the server resumes
that session if its per-session state is still within the resume grace
window (`SESSION_RESUME_GRACE_MS`), replaying history into the new
connection. Sensitive — see [onSessionId](#onsessionid).

##### WebSocket?

```ts
optional WebSocket?: WebSocketConstructor;
```

WebSocket constructor override. Primarily useful for testing with a mock
WebSocket. When omitted, the session uses a reconnecting WebSocket
(partysocket) that retries with exponential backoff after an unexpected
close and resumes the session; an injected constructor is used as-is and
never reconnects on its own.

***

### WebSocketConstructor()

```ts
type WebSocketConstructor = WebSocket;
```

Minimal WebSocket constructor type accepted by [VoiceSessionOptions](#voicesessionoptions).

```ts
type new WebSocketConstructor(url: string | URL, protocols?: string | string[]): WebSocket;
```

Minimal WebSocket constructor type accepted by [VoiceSessionOptions](#voicesessionoptions).

#### Parameters

##### url

`string` \| `URL`

##### protocols?

`string` \| `string`[]

#### Returns

`WebSocket`

#### Properties

##### OPEN

```ts
readonly OPEN: number;
```

***

### WorkflowApi

```ts
type WorkflowApi = {
  cancel: Promise<boolean>;
  download: Promise<Blob>;
  find: Promise<WorkflowRunSnapshot[]>;
  follow: AsyncIterable<WorkflowRunSnapshot>;
  followOutput: AsyncIterable<unknown>;
  get: Promise<
     | WorkflowRunSnapshot
    | undefined>;
  list: Promise<WorkflowSummary[]>;
  recent: Promise<WorkflowRunSnapshot[]>;
  start: Promise<string>;
  startAndWait: Promise<WorkflowRunSnapshot>;
  streamOutput: Promise<Response>;
  upload: Promise<UploadRef>;
  uploadInfo: Promise<UploadInfo>;
  uploadStream: Promise<UploadRef>;
  wake: Promise<number>;
  watch: Promise<Response>;
};
```

The calls the API offers — one method per route, and nothing beyond them.

The width is the constraint: a route needing more than a tool can do is the
signal to add a `WorkflowClient` method server-side, never to grow this
into an engine with reads of its own: this surface dispatches, it does not
query.

#### Methods

##### cancel()

```ts
cancel(runId: string): Promise<boolean>;
```

Stop a run, resolving whether this call is what ended it. A run that had
already finished answers false rather than failing — two tabs pressing Stop
is ordinary.

###### Parameters

###### runId

`string`

###### Returns

`Promise`\<`boolean`\>

##### download()

```ts
download(id: string, options?: {
  signal?: AbortSignal;
}): Promise<Blob>;
```

Read an upload's BYTES, as a `Blob` — the other end of a run that PRODUCED
a file (`writeUpload` stores it, the output carries the id). A `Blob`
rather than a URL because the byte route takes the same bearer every route
here does and neither `<audio src>` nor `<a href>` can send one;
`downloadUpload` carries the rest.

###### Parameters

###### id

`string`

###### options?

###### signal?

`AbortSignal`

###### Returns

`Promise`\<`Blob`\>

##### find()

```ts
find(
   workflow: string, 
   key: string, 
   options?: {
  limit?: number;
}
): Promise<WorkflowRunSnapshot[]>;
```

Runs of `workflow` started with `key`, newest first.

###### Parameters

###### workflow

`string`

###### key

`string`

###### options?

###### limit?

`number`

###### Returns

`Promise`\<[`WorkflowRunSnapshot`](../aai/workflow-api.md#workflowrunsnapshot)[]\>

##### follow()

```ts
follow(runId: string, options?: {
  signal?: AbortSignal;
}): AsyncIterable<WorkflowRunSnapshot>;
```

Every snapshot of a run, until it settles — the call `watch` is the raw
material for.

```ts
import { createAgentClient } from "@alexkroman1/aai/workflow-api";

const agent = createAgentClient({ baseUrl: "https://agents.example/my-agent" });
for await (const run of agent.follow("wrun_1")) console.log(run.status);
```

The last value is the TERMINAL snapshot, and reaching it is what ends the
iteration, so a caller that only wants the answer keeps the last one it saw.
The two protocol rules a hand-written loop gets wrong are honoured inside:
the stream hands the client back with an `idle` frame after its own duration
cap (a run may sleep for hours) and this re-opens, and a stream that ends
with the run unsettled THROWS rather than looking like a run that finished.

There is no polling fallback, deliberately — an agent that does not serve
the route fails here with its own sentence, and a caller who wants to poll
instead is the caller [WorkflowApi.watch](#watch) exists for.

###### Parameters

###### runId

`string`

###### options?

###### signal?

`AbortSignal`

###### Returns

`AsyncIterable`\<[`WorkflowRunSnapshot`](../aai/workflow-api.md#workflowrunsnapshot)\>

##### followOutput()

```ts
followOutput(runId: string, options?: {
  fromIndex?: number;
  namespace?: string;
  signal?: AbortSignal;
}): AsyncIterable<unknown>;
```

Everything a run WRITES, in order, until it settles.

```ts
import { createAgentClient } from "@alexkroman1/aai/workflow-api";

const agent = createAgentClient({ baseUrl: "https://agents.example/my-agent" });
for await (const chunk of agent.followOutput("wrun_1")) console.log(chunk);
```

One read of the route is bounded by the tail it saw, so this re-opens from
the next unread chunk until the run is finished — which is the rule that
makes a single `for await` cover a live run's whole log. Chunks are retained
with the run, so it is a replay as much as a tail and starts at the
beginning by default; `fromIndex` is ABSOLUTE, and the raw route's negative
"last N" form is left on [WorkflowApi.streamOutput](#streamoutput) because it names
no position a re-open could resume from.

###### Parameters

###### runId

`string`

###### options?

###### fromIndex?

`number`

###### namespace?

`string`

###### signal?

`AbortSignal`

###### Returns

`AsyncIterable`\<`unknown`\>

##### get()

```ts
get(runId: string, options?: {
  wait?: number;
}): Promise<
  | WorkflowRunSnapshot
| undefined>;
```

Read a run's state. Resolves undefined for an unknown id.

Deliberately NOT generic on the output, even though a caller wants it typed:
a generic METHOD has to be implemented generically, which would make every
test double and every hand-written stub of this client generic too. The type
parameter belongs on whatever a caller states its expectation with —
`useWorkflowRun<R>` in the browser client, or a cast at the one place a
script reads `output`.

###### Parameters

###### runId

`string`

###### options?

###### wait?

`number`

###### Returns

`Promise`\<
  \| [`WorkflowRunSnapshot`](../aai/workflow-api.md#workflowrunsnapshot)
  \| `undefined`\>

##### list()

```ts
list(): Promise<WorkflowSummary[]>;
```

Declared workflows: name, description, and the input schema to render.

###### Returns

`Promise`\<[`WorkflowSummary`](#workflowsummary)[]\>

##### recent()

```ts
recent(workflow: string, options?: {
  limit?: number;
}): Promise<WorkflowRunSnapshot[]>;
```

Runs of `workflow`, newest first, whatever key they carry.

The operator's read where [WorkflowApi.find](#find) is the app's — a console
has no correlation key to ask about, and most runs carry none (a page holds
its own `runId`). Two methods rather than one nullable key, so a caller
meaning "this user's runs" cannot silently widen to every user's.

###### Parameters

###### workflow

`string`

###### options?

###### limit?

`number`

###### Returns

`Promise`\<[`WorkflowRunSnapshot`](../aai/workflow-api.md#workflowrunsnapshot)[]\>

##### start()

```ts
start(
   workflow: string, 
   input?: unknown, 
   options?: {
  key?: string;
}
): Promise<string>;
```

Start a run and resolve its id WITHOUT waiting for it — the point of the
mechanism. Rejects when the name is not declared or the input fails the
workflow's schema, both of which are 400s carrying the reason.

`key` is a correlation handle the caller chooses, so the run can be found
again later without the id — a signed-in user, an upload, a device. Pass one
when the caller might be gone before the run finishes and you would rather
look it up than remember the id.

###### Parameters

###### workflow

`string`

###### input?

`unknown`

###### options?

###### key?

`string`

###### Returns

`Promise`\<`string`\>

##### startAndWait()

```ts
startAndWait(
   workflow: string, 
   input?: unknown, 
   options?: {
  key?: string;
  wait?: number;
}
): Promise<WorkflowRunSnapshot>;
```

Start a run and resolve the FINISHED one — the synchronous call.

What a form or a shell script wants, and what [WorkflowApi.start](#start-1)
deliberately is not: one request in, one result out, with no watch to wire
up. The agent holds the request open until the run settles or its own budget
expires, so a run that is still going when the wait runs out resolves
NON-terminal — check `isTerminal`, or keep the id and read it back later.

`wait` is clamped to `MAX_WORKFLOW_WAIT_MS` at both ends, by the same
function, so this can never be waiting on a request the agent already
answered.

###### Parameters

###### workflow

`string`

###### input?

`unknown`

###### options?

###### key?

`string`

###### wait?

`number`

###### Returns

`Promise`\<[`WorkflowRunSnapshot`](../aai/workflow-api.md#workflowrunsnapshot)\>

##### streamOutput()

```ts
streamOutput(runId: string, options?: {
  namespace?: string;
  signal?: AbortSignal;
  startIndex?: number;
}): Promise<Response>;
```

Open a server-sent-event stream of what the run has WRITTEN — its progress,
as opposed to [WorkflowApi.watch](#watch)'s status transitions.

Resolves the raw `Response` for the same reason `watch` does: an agent
deployed before this route existed answers 404, which a caller has to be able
to see rather than have raised at it. Frames are `chunk` then `done`.

Chunks are retained with the run, so this is a replay as much as a live tail:
a caller that reloads gets the whole stream by default, and `startIndex`
(negative counts back from the end) is for a reader resuming from a known
position.

###### Parameters

###### runId

`string`

###### options?

###### namespace?

`string`

###### signal?

`AbortSignal`

###### startIndex?

`number`

###### Returns

`Promise`\<`Response`\>

##### upload()

```ts
upload(file: UploadBody, options?: UploadOptions): Promise<UploadRef>;
```

Store a file and resolve the handle a run input carries.

The other half of `WorkflowDef.uploads`: a workflow's input is journaled and
replayed on every resume, so bytes may not travel in it — they go here once,
and the run carries [UploadRef.id](../aai/workflow-api.md#id), which a step reads windows of with
`readUpload`.

A `File` from an `<input type="file">` needs no second argument: its own
`name` and `type` are what get stored. Anything else — a `Blob`, a
`Uint8Array` — should name the file it is, since a step's failure messages
and the download link are all the name it will ever have.

One request for the whole body, so a file past `MAX_WORKFLOW_UPLOAD_BYTES` is
a 413 rather than a truncation; [UploadOptions.onProgress](../aai/workflow-api.md#onprogress) draws a bar.
`{ parallel: true }` sends it as concurrent parts instead, which is what a
recording over a long link wants — see [UploadOptions.parallel](../aai/workflow-api.md#parallel).

###### Parameters

###### file

[`UploadBody`](../aai/workflow-api.md#uploadbody)

###### options?

[`UploadOptions`](../aai/workflow-api.md#uploadoptions)

###### Returns

`Promise`\<[`UploadRef`](../aai/workflow-api.md#uploadref)\>

##### uploadInfo()

```ts
uploadInfo(id: string): Promise<UploadInfo>;
```

Read an upload's record: its name, how much has ARRIVED, and `complete`.

What a page watches a streamed upload with. `complete` is the field to branch
on — a `size` that stopped growing means only that nothing arrived recently,
which a slow link and a dead client both produce.

###### Parameters

###### id

`string`

###### Returns

`Promise`\<[`UploadInfo`](../aai/step.md#uploadinfo)\>

##### uploadStream()

```ts
uploadStream(
   id: string, 
   file: UploadBody, 
   options?: UploadOptions
): Promise<UploadRef>;
```

Store a file under an id YOU chose, so a run can start before it is all in.

The counterpart of [WorkflowApi.upload](#upload), and the difference is the order
it makes possible: `upload` answers with an id once the last byte is stored, so
a run that needs the id in its input has to wait for the whole upload. Here the
caller already has the id.

`id` must be 1-64 characters of letters, digits, `-` and `_` (a
`crypto.randomUUID()` qualifies) and must not already exist — a second call on
one id is a 409, never an append.

`{ parallel: true }` applies here too, and composes with the ORDER this method
exists for: the run reads the contiguous prefix as the parts fill it in,
exactly as it reads a single streaming `PUT`.

###### Parameters

###### id

`string`

###### file

[`UploadBody`](../aai/workflow-api.md#uploadbody)

###### options?

[`UploadOptions`](../aai/workflow-api.md#uploadoptions)

###### Returns

`Promise`\<[`UploadRef`](../aai/workflow-api.md#uploadref)\>

##### wake()

```ts
wake(runId: string, options?: WakeUpOptions): Promise<number>;
```

End a run's `sleep()` early, resolving how many pending sleeps were
interrupted.

`0` is an answer, not a failure — the run finished, was never sleeping, or is
gone. Same shape as [WorkflowApi.cancel](#cancel-1) answering false, and for the
same reason: two tabs pressing "send it now" is ordinary.

[WakeUpOptions.correlationIds](../aai/workflow-api.md#correlationids) narrows it to the waits declared with
those ids, which is the same bag `ctx.workflows.wakeUp` takes and reaches the
route's repeatable `?correlationId=`. Reach for it when the caller means one
particular wait rather than "everything this run is waiting on" — and note it
is the ONLY spelling that can end a hook's approval deadline, since a bare
wake deliberately cannot (the journal filters a `hookTimeout` out of one).

An id that is blank, or longer than 256 characters, REJECTS here without a
request being sent. The route answers 400 for both, and there is nothing a
caller can do with that answer that it could not do with a rejection it never
had to make a round trip for.

###### Parameters

###### runId

`string`

###### options?

[`WakeUpOptions`](../aai/workflow-api.md#wakeupoptions)

###### Returns

`Promise`\<`number`\>

##### watch()

```ts
watch(runId: string, signal?: AbortSignal): Promise<Response>;
```

Open a server-sent-event stream of one run's state.

Resolves the raw `Response` rather than parsed frames, because what a caller
needs to decide first is whether the agent SERVES this at all — an older
deploy answers 404 and the caller falls back to polling, which is a normal
path rather than an error.

###### Parameters

###### runId

`string`

###### signal?

`AbortSignal`

###### Returns

`Promise`\<`Response`\>

***

### WorkflowApiOptions

```ts
type WorkflowApiOptions = {
  baseUrl?: string;
  token?: string;
};
```

#### Properties

##### baseUrl?

```ts
optional baseUrl?: string;
```

Base URL of the agent. Defaults to the page's own origin + path, which is
right for a page the agent itself serves — the only case that exists today,
and the reason this wrapper exists at all: the SDK client requires a base
URL, because `location` does not exist in that half of the SDK.

##### token?

```ts
optional token?: string;
```

Bearer for an agent whose operator set `AAI_WORKFLOW_API_TOKEN`. A page
served to the public has nothing to put here (and should not — it would be
readable in the bundle); this exists for a programmatic caller written
against the same client.

***

### WorkflowInputOf

```ts
type WorkflowInputOf<D> = D extends WorkflowDef<infer P, unknown> ? InferSchemaOutput<P> : never;
```

A workflow's INPUT type — what its declared schema parses to, which is
exactly what the body's parameter should be.

**The reason it exists is that nothing checks a hand-written parameter.**
[WorkflowBody](../aai/workflow-api.md#workflowbody) takes its input as a function PARAMETER, so it is
contravariant: a body declaring a WIDER shape than the schema produces is
assignable, and a body declaring the same shape with a field's optionality or
a default's type subtly different is assignable too. Both compile. A
`z.number().default(5)` against a body that writes `input.limit ?? 3` is the
sharp version — the schema guarantees `limit` is present, the `??` is dead,
and the two numbers disagree with nothing to report it.

Two details a restated shape gets wrong by hand, both of which this gets
right for free. A zod `.optional()` infers a property that may be PRESENT AND
`undefined`, which under `exactOptionalPropertyTypes` is `?: T | undefined`
and not `?: T` — two templates carry the same four-line comment explaining
that, which is a comment `z.infer` makes unnecessary. And a `.default()` makes
the OUTPUT property required while the input stays optional, so a body reading
it needs no fallback at all.

Like [WorkflowOutputOf](#workflowoutputof), it needs no build step: `import type` is
erased, so a body in `workflows/` naming `WorkflowInputOf<typeof theDef>`
through a type-only import of `../agent.ts` drags no runtime cycle behind it.

#### Type Parameters

##### D

`D`

#### Example

```ts no-check
// agent.ts
export const digest = workflow({
  input: z.object({ topic: z.string(), limit: z.number().default(5) }),
  run: digestFlow,
});

// workflows/digest.ts — `import type` is erased, so there is no cycle.
import type { WorkflowInputOf } from "@alexkroman1/aai/workflow-api";
import type { digest } from "../agent.ts";

export async function digestFlow(input: WorkflowInputOf<typeof digest>, ctx: WorkflowCtx) {
  // `limit` is `number`, not `number | undefined` — the default already ran.
  return await research(input.topic, input.limit);
}
```

***

### WorkflowOutputOf

```ts
type WorkflowOutputOf<D> = D extends {
  output?: StandardSchemaV1<unknown, infer O>;
  run: WorkflowBody<never, infer R>;
} ? Awaited<unknown extends O ? R : O> : never;
```

A workflow's OUTPUT type, for a page that polls its runs.

This is the end-to-end typing a static page would otherwise be missing.
`useWorkflowRun<R>` makes `run.status === "completed"` narrow to a typed
`run.output`, and without this the page has to name `R` by hand — restating a
shape the agent module already declares, with nothing checking the two agree.

It needs no build step and no generated `.d.ts`, because the reason a page
"cannot import the agent" does not survive contact with `import type`: a
type-only import is ERASED, so it drags no server graph into the browser
bundle.

#### Type Parameters

##### D

`D`

#### Example

```ts no-check
// agent.ts
export const transcribe = workflow({ input: …, output: transcriptSchema, run: transcribeFlow });

// client.tsx — `import type` is erased, so nothing server-side is bundled.
import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import type { transcribe } from "./agent.ts";

const run = useWorkflowRun<WorkflowOutputOf<typeof transcribe>>(runId, { api });
if (run?.status === "completed") console.log(run.output.text); // typed
```

## It reads the declared SCHEMA first, and that is what breaks a cycle

The DECLARATION is the better source of this type, and the worse one used to
be the only one. Deriving `R` from the body means `typeof theDef` needs the
body's signature — while a body annotated `WorkflowInputOf<typeof theDef>`
needs `typeof theDef`, which is `TS7022` reported against `agent.ts`. The
documented way out is to ANNOTATE the declaration, and an annotation whose
`R` comes from a schema (`WorkflowDef<typeof digestInput, z.infer<typeof
digestOutput>>`) states the output type once, in the schema, rather than
naming it a second time by hand.

That annotated shape is also what the second reading gets WRONG, which is
the other half of this rewrite. `D extends WorkflowDef<ToolInputSchema, infer
R>` is an assignability test over the whole def, and `run`'s input is a
function PARAMETER — so a def carrying an input schema is not assignable to
one taking the open `Record<string, unknown>`, and the conditional silently
fell to `never`. It is the same contravariance [AnyWorkflowDef](../aai/workflow-api.md#anyworkflowdef) was
written for, reached by the other route, and it is why the test below matches
`run` as `WorkflowBody<never, infer R>` — `never` is assignable to every
parameter type.

`unknown extends O` is how "declared nothing" is told from "declared a
schema": a def with no output schema still HAS the optional property in its
type, carrying `R` — so the two readings agree, and the fallback only ever
fires for a def-shaped object that names no output at all.

`Awaited` because a body may be sync or async and the snapshot always holds
the settled value.

***

### WorkflowRun

```ts
type WorkflowRun<R = unknown> = WorkflowRunSnapshot<R>;
```

A run's observable state.

Aliased from the SDK rather than restated. `import type` is erased entirely,
so a second definition of the fields and the five-member status union would
buy nothing and cost the one thing that matters — nothing would assert the two
agree, so a status added to the SDK would never reach the browser type.

`WorkflowRun` keeps the shorter name because it is what a page's own code
writes; nothing in a browser needs the word "snapshot" to know a read returns
one.

It is GENERIC on the run's output, and a page supplies it — see
[useWorkflowRun](#useworkflowrun). It does NOT have to restate that type: a page can name
its own workflow and derive the rest with `WorkflowOutputOf`, pulling no
server graph into the bundle.

#### Type Parameters

##### R

`R` = `unknown`

***

### WorkflowRunStatus

```ts
type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
```

Lifecycle of one workflow run.

- `pending` — created, not yet picked up by the queue.
- `running` — executing, or suspended at a `sleep`/hook waiting to resume.
- `completed` / `failed` / `cancelled` — terminal.

***

### WorkflowStreamSubmission

```ts
type WorkflowStreamSubmission<R = unknown, I = unknown> = WorkflowSubmission<R, I>;
```

What [useWorkflowStream](#useworkflowstream) returns: a [WorkflowSubmission](#workflowsubmission), exactly.

The same eight fields `useWorkflowSubmit` returns, of which this hook is a
drop-in sibling — same `<Form>`, same `<UploadProgressBar>`, same
`<WorkflowProgress>`. An ALIAS rather than a second declaration of the eight:
the two have to agree field for field to be drop-in, and two copies of a type
that have to agree are two copies that can stop agreeing.

Exactly two of the fields mean something different here, and both differences
follow from WHEN the run is created — it exists before its bytes do:

- `submit()` resolves when the UPLOAD finishes, not when the run is accepted;
  the run's own progress arrives through `run`. It still resolves rather than
  rejecting on a failed upload — the failure is reported through `error`, the
  way a form expects.
- `run` is set from the moment the run EXISTS, which here is before the bytes
  are in. That is what lets a page render `<WorkflowProgress>` beside the
  upload bar rather than after it.

#### Type Parameters

##### R

`R` = `unknown`

##### I

`I` = `unknown`

***

### WorkflowSubmission

```ts
type WorkflowSubmission<R = unknown, I = unknown> = {
  cancel: () => Promise<boolean>;
  error: string | undefined;
  pauseUpload: () => void;
  pending: boolean;
  reset: () => void;
  resumeUpload: () => void;
  run: WorkflowRun<R> | undefined;
  submit: (input: I) => Promise<void>;
  submitForm: (values: FormValues) => Promise<void>;
  upload: UploadStatus | undefined;
  wake: () => Promise<number>;
};
```

What [useWorkflowSubmit](#useworkflowsubmit) returns.

#### See

[WorkflowStreamSubmission](#workflowstreamsubmission) — an ALIAS of this type, returned by
`useWorkflowStream`, which is a drop-in sibling. Exactly two fields MEAN
something different there, and both differences follow from WHEN the run is
created: there, `submit()` resolves when the UPLOAD finishes rather than when
the run is accepted, and `run` is non-`undefined` from before the bytes are
in, so a page can render `<WorkflowProgress>` beside the upload bar instead
of after it. Here the run does not exist until the last byte lands.

#### Type Parameters

##### R

`R` = `unknown`

##### I

`I` = `unknown`

#### Properties

##### cancel

```ts
cancel: () => Promise<boolean>;
```

Stop the current run, resolving whether this call is what ended it.

`false` for a run that had already finished, and for no run at all — the
SDK's contract, because two tabs pressing Stop is ordinary. Distinct from
`reset()`, which puts the FORM back and leaves the run running.

###### Returns

`Promise`\<`boolean`\>

##### error

```ts
error: string | undefined;
```

The submit's own failure (a rejected input), or the watch's.

##### pauseUpload

```ts
pauseUpload: () => void;
```

Park the upload where it is, stopping the bytes in flight.

The windows already stored stay stored, so `resumeUpload()` sends what is
missing rather than the file — which is the difference between a pause a
person will actually use on a 200 MB recording and a cancel dressed up as one.

`submit()`'s promise stays unresolved across a pause, because the submission
genuinely has not finished: the run does not exist until the last byte lands,
so resolving here would tell a `<Form>` the work was accepted when nothing has
been started. A no-op when there is no upload in flight.

###### Returns

`void`

##### pending

```ts
pending: boolean;
```

True from `submit()` until the run reaches a terminal status.

The WORK, not the request: a run outlives its `POST`, and a submit button
that re-enabled on the response would invite a second submission of work
already in flight.

##### reset

```ts
reset: () => void;
```

Clear the run and any error, putting the form back to its initial state.

###### Returns

`void`

##### resumeUpload

```ts
resumeUpload: () => void;
```

Continue a paused upload, sending only the windows the store does not have.

###### Returns

`void`

##### run

```ts
run: WorkflowRun<R> | undefined;
```

The run, once started, followed to completion.

##### submit

```ts
submit: (input: I) => Promise<void>;
```

Start a run with this input. Resolves once the run EXISTS — progress
arrives through `run` — so a `<Form>`'s handler can await it to know the
submission was accepted.

###### Parameters

###### input

`I`

###### Returns

`Promise`\<`void`\>

##### submitForm

```ts
submitForm: (values: FormValues) => Promise<void>;
```

Start a run from a `<Form>`'s values, which are UNVALIDATED.

The same function as [WorkflowSubmission.submit](#submit), with the type the
form path can honestly offer. `FormValues` is `Record<string, unknown>`
scraped off the DOM at submit time — a `<TextField name="limit">`
contributes a string whatever the schema says — so the shape is not known
here and the SERVER is what checks it against the workflow's schema.

Two doors rather than one loose one: `submit` takes the workflow's own
input type, so a hand-built object is checked at compile time and
`submit({ ur1: 42 })` is an error; widening it to accept `FormValues` would
have made every object satisfy it and given the typing back. Reaching for
this one is the author saying "these came from a form", which is a fact
about the values and not a cast.

###### Parameters

###### values

[`FormValues`](#formvalues)

###### Returns

`Promise`\<`void`\>

##### upload

```ts
upload: UploadStatus | undefined;
```

How far the submission's files have got, while any are still going.

Undefined before the first byte and again from the moment the last one
lands, so a page can render `{upload && <UploadProgressBar upload={upload} />}`
and the bar exists exactly for as long as there is an upload to describe. A
form with no files never sets it at all.

The wait it covers is the one `run` cannot: a run does not EXIST until its
input is stored, so `pending` is true and there is nothing to poll — which
for a 200 MB recording is minutes of a page that looks stuck.

##### wake

```ts
wake: () => Promise<number>;
```

End the current run's `sleep()` early — "file it now" — resolving how many
pending sleeps were interrupted.

Bound to the run this submission is following, which is the point: it is
the only reason a page holding one of these hooks needed an `api` of its
own. `0` is an answer rather than a failure (the run had already moved past
its wait, or there is no run yet), so nothing here has to be guarded.

###### Returns

`Promise`\<`number`\>

***

### WorkflowSummary

```ts
type WorkflowSummary = {
  description?: string;
  inputSchema?: unknown;
  name: string;
  outputSchema?: unknown;
  uploads?: readonly string[];
};
```

One declared workflow, as `GET /workflows` lists it.

Here rather than in `host/` because both ends need it and only one of them is
a Node process: the API serves it, and a static page's client renders a form
from it.

#### Properties

##### description?

```ts
optional description?: string;
```

The workflow's own `description`, when it declared one.

##### inputSchema?

```ts
optional inputSchema?: unknown;
```

JSON Schema for the run input, when the workflow declared one — what a page
renders its form from. Converted at declaration-listing time rather than
shipped as the Standard Schema itself, because the reader is a browser.

##### name

```ts
name: string;
```

Key the workflow is declared under in `agent({ workflows })`.

##### outputSchema?

```ts
optional outputSchema?: unknown;
```

JSON Schema for what a completed run answers with, when the workflow
declared an `output` — what a page renders its RESULTS from, the way
`inputSchema` is what it renders its form from.

Converted at declaration-listing time for the same stated reason: the
reader is a browser, and a Standard Schema does not survive the wire.

The two are converted in opposite DIRECTIONS and the asymmetry is not an
oversight — see the converter in the runtime's `workflow-client.ts`. An
input schema is described as what a caller may SEND (a `.default()` field
is optional); an output schema as what the run PRODUCES, which is the
parsed value, where that same field is always present.

##### uploads?

```ts
optional uploads?: readonly string[];
```

Input properties that carry an upload id — see `WorkflowDef.uploads`.

Served alongside the schema because a form is rendered from BOTH: the schema
says the property is a string, and this says the string is a file the page
has to upload first.

## Variables

### Controls

```ts
const Controls: MemoExoticComponent<FunctionComponent<ControlsProps>>;
```

Session control buttons: **Stop / Resume** and **New Conversation**.

Reads session state from [useSession](#usesession). Must be rendered inside a
`SessionProvider`.

#### Example

```tsx
import { Controls } from "@alexkroman1/aai-ui";

function Footer() {
  return <Controls className="justify-end" />;
}
```

#### Param

**props**

Container props.

***

### Markdown

```ts
const Markdown: MemoExoticComponent<FunctionComponent<MarkdownProps>>;
```

Agent prose, rendered as Markdown.

Pipeline and S2S models write emphasis, lists, `code`, and links; before
this they arrived as literal asterisks and backticks. Styling is
per-element (theme colors via inline styles, spacing via Tailwind) so it
stays on the default client's type scale and follows custom themes.
The optional `variant` selects the type scale (see
[MarkdownVariant](#markdownvariant)).
GFM is on for tables and strikethrough. react-markdown does not render
raw HTML unless rehype-raw is added — keep it that way, this text comes
from a model.

Memoized alongside `MessageBubble`: message content is referentially
stable across snapshots, so only the streaming row re-parses.

#### Example

```tsx
import { Markdown, useSessionSelector } from "@alexkroman1/aai-ui";

// The agent's reply as it streams, rendered rather than shown as literal
// asterisks and backticks.
function LiveReply() {
  const text = useSessionSelector((snapshot) => snapshot.agentTranscript);
  return text === null ? null : <Markdown text={text} variant="compact" />;
}
```

***

### MessageList

```ts
const MessageList: MemoExoticComponent<FunctionComponent<MessageListProps>>;
```

Scrollable list of all chat messages, tool-call blocks, live transcript,
streaming agent utterance, and a thinking indicator.

Messages and tool calls are interleaved in the correct order. The list
auto-scrolls to the latest content.

Must be rendered inside a `SessionProvider`.

#### Example

```tsx
import { MessageList } from "@alexkroman1/aai-ui";

function Conversation() {
  return <MessageList className="flex-1" />;
}
```

#### Param

**props**

Container props.

***

### WORKFLOW\_STATUS\_LABELS

```ts
const WORKFLOW_STATUS_LABELS: Readonly<Record<WorkflowRunStatus, string>>;
```

The default status line per [WorkflowRunStatus](#workflowrunstatus).

Override the ones your page has a better word for and keep the rest:

```ts
import { WORKFLOW_STATUS_LABELS } from "@alexkroman1/aai-ui";

const STATUS_LINE = { ...WORKFLOW_STATUS_LABELS, running: "Writing…" };
```

The wording is deliberately about the RUN rather than about the work — a page
knows what its workflow does and this does not, so `running` is the neutral
"Working…" and every page that cares replaces exactly that key.
