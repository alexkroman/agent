# @alexkroman1/aai-ui

The browser client for aai voice agents: React 19 components, hooks, and a
framework-agnostic session core (WebSocket + microphone + playback).

```sh
npm i @alexkroman1/aai-ui react react-dom
```

Every agent gets this UI for free — `aai dev` and deployed agents serve a
default client built from this package. Install it directly when the agent
has its own `client.tsx`.

## A custom client

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

## Hooks

Inside components rendered by `client()`:

- `useSession()` — connection state, transcript, `connect`/`disconnect`.
- `useAgentState<T>()` — the agent's `syncState` projection, live.
- `useToolResult(name, cb)` / `useToolCallStart(name, cb)` — observe tool
  calls as they run (e.g. to render a card per result).
- `useEvent(name, cb)` — custom events the agent pushes with `ctx.send`.
- `useTheme()` — the resolved theme colors for custom components.

For a non-React integration, `createSessionCore()` exposes the same session
as a plain store with an immutable snapshot per change.

## Documentation

Full API reference: <https://alexkroman.github.io/agent/>

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

The words so far, or [TRANSCRIBING\_PLACEHOLDER](#transcribing_placeholder) while there are none.
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

Current state of the voice agent session.

***

### BaseOptions

```ts
type BaseOptions = Pick<VoiceSessionOptions, "onSessionId" | "resumeSessionId" | "WebSocket"> & {
  platformUrl?: string;
  target?: string | HTMLElement;
  theme?: ClientTheme;
};
```

Options shared by both [client](#client) tiers (config-only and custom
component).

The session-forwarded fields are picked from [VoiceSessionOptions](#voicesessionoptions)
(one source of truth for types and docs) rather than re-declared — a
re-declared copy is exactly how doc comments drift.

#### Type Declaration

##### platformUrl?

```ts
optional platformUrl?: string;
```

Base URL of the AAI platform server. Derived from `location.href` by default.

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
type ClientConfig = ConfigTier | ComponentTier;
```

Configuration passed to [client](#client).

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

#### Properties

##### session

```ts
session: SessionCore;
```

The underlying session core.

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

### ComponentTier

```ts
type ComponentTier = BaseOptions & {
  component: ComponentType;
  name?: string;
  sidebar?: never;
  sidebarWidth?: never;
  tools?: ToolDisplayConfig;
};
```

Tier 2: custom component — renders the provided `component` inside the
providers instead of the default shell.

#### Type Declaration

##### component

```ts
component: ComponentType;
```

Full custom component to render instead of the default shell.

##### name?

```ts
optional name?: string;
```

Agent name. With a custom component there is no shell header to put it
in, so it becomes the page title.

Allowed here rather than `never` because `client({ name, component })` is
the natural thing to write and two different models wrote it. As `never`
it failed with *"Type 'string' is not assignable to type 'undefined'"*,
which explains nothing, and cost a build round each time. There is a real
use for the value — a custom-UI page otherwise inherits whatever title
the HTML shell shipped with — so it is honoured instead of banned.

##### sidebar?

```ts
optional sidebar?: never;
```

##### sidebarWidth?

```ts
optional sidebarWidth?: never;
```

##### tools?

```ts
optional tools?: ToolDisplayConfig;
```

Tool display config: icon and label overrides keyed by tool name.

Allowed here for the same reason as `name` above, and it was found the
same way: four starters across an eval run wrote
`client({ component, tools })` and lost a build round each time to
*"Type '{ … }' is not assignable to type 'undefined'"*.

Unlike `sidebar`/`sidebarWidth`, this is not a property of the default
shell. `client()` below wraps BOTH tiers in `ToolConfigContext.Provider`
from `config.tools ?? {}`, and the consumer is `ToolCallBlock` — which a
custom component renders as soon as it uses `MessageList` or `ChatView`,
the usual way to build one. So the value was always honoured at runtime;
only the type refused it.

***

### ConfigTier

```ts
type ConfigTier = BaseOptions & {
  component?: never;
  name?: string;
  sidebar?: ComponentType;
  sidebarWidth?: string;
  tools?: ToolDisplayConfig;
};
```

Tier 1: config-only options — no `component`. Renders the default shell
(StartScreen + ChatView).

#### Type Declaration

##### component?

```ts
optional component?: never;
```

##### name?

```ts
optional name?: string;
```

Agent name shown in the header and start screen.

##### sidebar?

```ts
optional sidebar?: ComponentType;
```

Optional sidebar component rendered alongside the chat view.

##### sidebarWidth?

```ts
optional sidebarWidth?: string;
```

CSS width of the sidebar. Defaults to `"18rem"`.

##### tools?

```ts
optional tools?: ToolDisplayConfig;
```

Tool display config: icon and label overrides keyed by tool name.

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
onSubmit: (values: FormValues) => void | Promise<void>;
```

Called with the collected values. May be async — the form stays disabled
for the duration, so a double-click cannot submit twice.

###### Parameters

###### values

[`FormValues`](#formvalues)

###### Returns

`void` \| `Promise`\<`void`\>

***

### FormValues

```ts
type FormValues = Record<string, unknown>;
```

One submitted form, as a plain object keyed by field name.

`unknown` values rather than `string`: see the module doc — a number field
yields a number and a file field yields a [FileValue](#filevalue).

***

### MarkdownVariant

```ts
type MarkdownVariant = "default" | "compact";
```

Type scale for [Markdown](#markdown): `"default"` is the deployed agent UI's
scale, `"compact"` a notch smaller for denser surfaces (the studio's chat
transcript). Colors are unaffected — they come from the theme either way.

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

### SessionCoreOptions

```ts
type SessionCoreOptions = VoiceSessionOptions;
```

Options accepted by `createSessionCore` — an alias of
[VoiceSessionOptions](#voicesessionoptions), which documents every field. Two names, one
type: `client()` and `createSessionCore` share the same session options.

***

### SessionError

```ts
type SessionError = {
  code: SessionErrorCode;
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

##### error

```ts
readonly error: SessionError | null;
```

##### messages

```ts
readonly messages: ChatMessage[];
```

##### recording

```ts
readonly recording: boolean;
```

True while the microphone is live and streaming to the server.

##### running

```ts
readonly running: boolean;
```

##### started

```ts
readonly started: boolean;
```

##### state

```ts
readonly state: AgentState;
```

##### toolCalls

```ts
readonly toolCalls: ToolCallInfo[];
```

##### userTranscript

```ts
readonly userTranscript: string | null;
```

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

Values are [DefaultToolResult](aai/index.md#defaulttoolresult) — `any` — for the same reason a tool
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

What [WorkflowSubmission.upload](#upload-2) reports while the bytes are going.

The SDK's per-request [UploadProgress](aai/workflow-api.md#uploadprogress) plus WHICH file it describes,
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

### UseWorkflowProgressResult

```ts
type UseWorkflowProgressResult<T> = {
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
type UseWorkflowRunResult<R> = {
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
type UseWorkflowRunsResult<R> = {
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
type UseWorkflowStreamOptions = {
  api?: WorkflowApi;
  intervalMs?: number;
  key?: string;
  parallel?: UploadParallel;
};
```

Options for [useWorkflowStream](#useworkflowstream).

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

##### parallel?

```ts
optional parallel?: UploadParallel;
```

Send the file as concurrent parts instead of in one streaming request.

It COMPOSES with what this hook is for rather than competing with it: the run
still starts before the bytes, and the store still publishes how far the file
is readable — that number is the CONTIGUOUS prefix, so a run reading ahead of
the uplink sees the same growing file whether one connection or four are
filling it. What changes is only how fast it grows.

**On by default.** `false` opts out, `{ partBytes, concurrency }` tunes it.
See `UploadOptions.parallel`.

***

### UseWorkflowSubmitOptions

```ts
type UseWorkflowSubmitOptions = {
  api?: WorkflowApi;
  intervalMs?: number;
  key?: string;
  parallel?: UploadParallel;
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
signal to add a `WorkflowClient` method server-side, never to grow this into
an engine with reads of its own. See the "no engine here" section of
`host/workflow-api.ts`.

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
}): Promise<WorkflowRunSnapshot[]>;
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

`Promise`\<[`WorkflowRunSnapshot`](aai/workflow-api.md#workflowrunsnapshot)[]\>

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

`AsyncIterable`\<[`WorkflowRunSnapshot`](aai/workflow-api.md#workflowrunsnapshot)\>

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
  \| [`WorkflowRunSnapshot`](aai/workflow-api.md#workflowrunsnapshot)
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

`Promise`\<[`WorkflowRunSnapshot`](aai/workflow-api.md#workflowrunsnapshot)[]\>

##### start()

```ts
start(
   workflow: string, 
   input?: unknown, 
   options?: {
  key?: string;
}): Promise<string>;
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
}): Promise<WorkflowRunSnapshot>;
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

`Promise`\<[`WorkflowRunSnapshot`](aai/workflow-api.md#workflowrunsnapshot)\>

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
and the run carries [UploadRef.id](aai/workflow-api.md#id), which a step reads windows of with
`readUpload`.

A `File` from an `<input type="file">` needs no second argument: its own
`name` and `type` are what get stored. Anything else — a `Blob`, a
`Uint8Array` — should name the file it is, since a step's failure messages
and the download link are all the name it will ever have.

One request for the whole body, so a file past `MAX_WORKFLOW_UPLOAD_BYTES` is
a 413 rather than a truncation; [UploadOptions.onProgress](aai/workflow-api.md#onprogress) draws a bar.
`{ parallel: true }` sends it as concurrent parts instead, which is what a
recording over a long link wants — see [UploadOptions.parallel](aai/workflow-api.md#parallel).

###### Parameters

###### file

[`UploadBody`](aai/workflow-api.md#uploadbody)

###### options?

[`UploadOptions`](aai/workflow-api.md#uploadoptions)

###### Returns

`Promise`\<[`UploadRef`](aai/workflow-api.md#uploadref)\>

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

`Promise`\<[`UploadInfo`](aai/step.md#uploadinfo)\>

##### uploadStream()

```ts
uploadStream(
   id: string, 
   file: UploadBody, 
options?: UploadOptions): Promise<UploadRef>;
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

[`UploadBody`](aai/workflow-api.md#uploadbody)

###### options?

[`UploadOptions`](aai/workflow-api.md#uploadoptions)

###### Returns

`Promise`\<[`UploadRef`](aai/workflow-api.md#uploadref)\>

##### wake()

```ts
wake(runId: string): Promise<number>;
```

End a run's `sleep()` early, resolving how many pending sleeps were
interrupted.

`0` is an answer, not a failure — the run finished, was never sleeping, or is
gone. Same shape as [WorkflowApi.cancel](#cancel-1) answering false, and for the
same reason: two tabs pressing "send it now" is ordinary.

###### Parameters

###### runId

`string`

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

### WorkflowOutputOf

```ts
type WorkflowOutputOf<D> = D extends WorkflowDef<ToolInputSchema, infer R> ? Awaited<R> : never;
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
export const transcribe = workflow({ input: …, run: transcribeFlow });

// client.tsx — `import type` is erased, so nothing server-side is bundled.
import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import type { transcribe } from "./agent.ts";

const run = useWorkflowRun<WorkflowOutputOf<typeof transcribe>>(runId, { api });
if (run?.status === "completed") console.log(run.output.text); // typed
```

`Awaited` because a body may be sync or async and the snapshot always holds
the settled value.

***

### WorkflowRun

```ts
type WorkflowRun<R> = WorkflowRunSnapshot<R>;
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

### WorkflowStreamSubmission

```ts
type WorkflowStreamSubmission<R> = {
  error: string | undefined;
  pauseUpload: () => void;
  pending: boolean;
  reset: () => void;
  resumeUpload: () => void;
  run: WorkflowRun<R> | undefined;
  submit: (input: unknown) => Promise<void>;
  upload: UploadStatus | undefined;
};
```

What [useWorkflowStream](#useworkflowstream) returns.

#### Type Parameters

##### R

`R` = `unknown`

#### Properties

##### error

```ts
error: string | undefined;
```

The submit's own failure (a rejected input, or an upload that would not store).

##### pauseUpload

```ts
pauseUpload: () => void;
```

Park the upload where it is, stopping the bytes in flight.

The RUN keeps going — it is watching an upload id, and a paused upload is one
whose `size` has stopped growing, which is exactly what a slow uplink looks
like. So a pause costs nothing until the workflow's own idle bound decides the
uploader is gone (five minutes in `transcription-workflow`).

###### Returns

`void`

##### pending

```ts
pending: boolean;
```

True from `submit()` until the run reaches a terminal status.

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

The run, from the moment it EXISTS — which here is before its bytes are in.

That is the whole difference from `useWorkflowSubmit`, and what lets a page
render `<WorkflowProgress>` beside the upload bar rather than after it.

##### submit

```ts
submit: (input: unknown) => Promise<void>;
```

Start a run and stream this input's file into it.

Resolves when the upload finishes, NOT when the run does — the run's own
progress arrives through `run`. It resolves rather than rejecting on a failed
upload; the failure is reported through `error`, the way a form expects.

###### Parameters

###### input

`unknown`

###### Returns

`Promise`\<`void`\>

##### upload

```ts
upload: UploadStatus | undefined;
```

How far the upload has got, while it is still going.

***

### WorkflowSubmission

```ts
type WorkflowSubmission<R> = {
  error: string | undefined;
  pauseUpload: () => void;
  pending: boolean;
  reset: () => void;
  resumeUpload: () => void;
  run: WorkflowRun<R> | undefined;
  submit: (input: unknown) => Promise<void>;
  upload: UploadStatus | undefined;
};
```

What [useWorkflowSubmit](#useworkflowsubmit) returns.

#### Type Parameters

##### R

`R` = `unknown`

#### Properties

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
submit: (input: unknown) => Promise<void>;
```

Start a run with this input. Resolves once the run EXISTS — progress
arrives through `run` — so a `<Form>`'s handler can await it to know the
submission was accepted.

###### Parameters

###### input

`unknown`

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

***

### WorkflowSummary

```ts
type WorkflowSummary = {
  description?: string;
  inputSchema?: unknown;
  name: string;
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
const Controls: MemoExoticComponent;
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

**className**

Additional CSS class names applied to the container.

***

### DEFAULT\_PROGRESS\_POLL\_MS

```ts
const DEFAULT_PROGRESS_POLL_MS: 1000 = 1000;
```

How often a live run's progress is re-read once a bounded read has ended.

***

### DEFAULT\_WORKFLOW\_POLL\_MS

```ts
const DEFAULT_WORKFLOW_POLL_MS: 2000 = 2000;
```

How often [useWorkflowRun](#useworkflowrun) re-reads a live run when it has to poll.

***

### Markdown

```ts
const Markdown: MemoExoticComponent;
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

***

### MAX\_MISSING\_READS

```ts
const MAX_MISSING_READS: 3 = 3;
```

Consecutive "no such run" reads [useWorkflowRun](#useworkflowrun) tolerates before giving
up on the id.

Small on purpose: a 404 is a stable answer, so the budget exists only to
absorb a first read that races the run's creation — not to keep hoping.
Unbounded, a stale id polls (and, on the platform, BROKERS) for as long as the
tab is open.

***

### MessageList

```ts
const MessageList: MemoExoticComponent;
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

**className**

Additional CSS class names applied to the outer list container.

***

### TRANSCRIBING\_PLACEHOLDER

```ts
const TRANSCRIBING_PLACEHOLDER: "…" = "\u2026";
```

Placeholder for "listening, no words yet" — the `""` case above.

A one-character ellipsis rather than three dots, because it is read by a
screen reader as an ellipsis and it does not reflow the row when the first
real word replaces it.

***

### VOICE\_CAPTURE\_CONSTRAINTS

```ts
const VOICE_CAPTURE_CONSTRAINTS: MediaTrackConstraints;
```

`getUserMedia` audio constraints for every capture path in this package.

Defined once because four copies of this object drifted apart trivially, and
the flags are not cosmetic — each one rewrites the signal before STT (and
before the sync path's energy VAD) ever sees it:

- **`autoGainControl: false`** — AGC continuously retargets level, which
  means riding the noise floor up through silence. An energy VAD calibrated
  against a moving floor is calibrated against nothing.
- **`noiseSuppression: false`** / **`voiceIsolation: false`** — both discard
  signal to make speech sound cleaner to a human, and both can gate a quiet
  room to *exact* zeros, which is also what a dead microphone looks like
  (see `MIC_SILENCE_PROBE_MS`).
- **`echoCancellation: true`** — this one stays on. The mic is open while
  the agent speaks (barge-in needs it), so without AEC the agent hears
  itself and interrupts its own reply.

Cast because `voiceIsolation` is newer than TypeScript's DOM lib.

Public so a custom client that opens its own microphone gets the same
signal the built-in capture paths do.

## Functions

### AutoScroll()

```ts
function AutoScroll(children: {
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

##### children

The scrollable content.

###### children

`ReactNode`

###### className?

`string`

###### contentClassName?

`string`

###### initial?

`"instant"` \| `"smooth"`

###### resize?

`"instant"` \| `"smooth"`

###### scrollClassName?

`string`

###### style?

`CSSProperties`

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
function Button(variant: {
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

##### variant

\{
  `children?`: `ReactNode`;
  `className?`: `string`;
  `size?`: [`ButtonSize`](#buttonsize);
  `variant?`: [`ButtonVariant`](#buttonvariant);
\} & `Omit`\<`ButtonHTMLAttributes`\<`HTMLButtonElement`\>, `"className"`\>

Visual style (`"default"` | `"secondary"` | `"ghost"`). Defaults to `"default"`.

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
function ChatView(icon: {
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

##### icon

Optional element rendered in place of the logo in the header.

###### className?

`string`

###### icon?

`ReactNode`

###### title?

`string`

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
function CheckboxField(__namedParameters: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "className" | "type">): Element;
```

A checkbox. Contributes a BOOLEAN to [FormValues](#formvalues).

#### Parameters

##### \_\_namedParameters

[`FieldShell`](#fieldshell) & `Omit`\<`InputHTMLAttributes`\<`HTMLInputElement`\>, `"name"` \| `"className"` \| `"type"`\>

#### Returns

`Element`

***

### client()

```ts
function client(config: ClientConfig): ClientHandle;
```

Define and mount a client UI for a voice agent.

**Tier 1 (config-only):** Pass options without `component` to get the
default shell (StartScreen + ChatView, optional sidebar).

**Tier 2 (custom component):** Pass `component` to render a fully custom
root component inside the providers. In this tier a provided `name` also
sets `document.title` (there is no shell header to show it in).

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

**Tier 1**

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

**Tier 2**

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

#### Returns

[`WorkflowApi`](#workflowapi)

***

### Field()

```ts
function Field(__namedParameters: {
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

##### \_\_namedParameters

###### children

`ReactNode`

###### className?

`string`

###### hint?

`string`

###### htmlFor?

`string`

Id of the control this labels.

###### label?

`string`

#### Returns

`Element`

***

### FileField()

```ts
function FileField(__namedParameters: FieldShell & {
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
input — a CSV of ids, a config — and the size is the author's to check.

#### Parameters

##### \_\_namedParameters

[`FieldShell`](#fieldshell) & \{
  `read?`: [`FileRead`](#fileread);
  `upload?`: `boolean`;
\} & `Omit`\<`InputHTMLAttributes`\<`HTMLInputElement`\>, `"name"` \| `"className"` \| `"type"`\>

#### Returns

`Element`

***

### Form()

```ts
function Form(__namedParameters: FormProps): Element;
```

A form that hands its values to `onSubmit` as one object.

Native validation still applies — a `required` field blocks the submit and the
browser says so, which is better than anything this could render.

#### Parameters

##### \_\_namedParameters

[`FormProps`](#formprops)

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

  \| [`WorkflowRunSnapshot`](aai/workflow-api.md#workflowrunsnapshot)\<`R`\>
  \| `undefined`

#### Returns

`run is TerminalWorkflowRun<R>`

***

### NumberField()

```ts
function NumberField(__namedParameters: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "className" | "type">): Element;
```

A number input. Contributes a NUMBER to [FormValues](#formvalues), or nothing when
left empty.

#### Parameters

##### \_\_namedParameters

[`FieldShell`](#fieldshell) & `Omit`\<`InputHTMLAttributes`\<`HTMLInputElement`\>, `"name"` \| `"className"` \| `"type"`\>

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
function SelectField(__namedParameters: FieldShell & {
  options?: readonly (
     | string
     | {
     label: string;
     value: string;
  })[];
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "name" | "className">): Element;
```

A dropdown. Pass `options`, or `children` for full control over the
`<option>` elements.

#### Parameters

##### \_\_namedParameters

[`FieldShell`](#fieldshell) & \{
  `options?`: readonly (
     \| `string`
     \| \{
     `label`: `string`;
     `value`: `string`;
  \})[];
\} & `Omit`\<`SelectHTMLAttributes`\<`HTMLSelectElement`\>, `"name"` \| `"className"`\>

#### Returns

`Element`

***

### SidebarLayout()

```ts
function SidebarLayout(__namedParameters: {
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

##### \_\_namedParameters

###### children

`ReactNode`

###### className?

`string`

###### sidebar

`ReactNode`

###### sidebarPosition?

`"left"` \| `"right"`

###### sidebarWidth?

`string`

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
function StartScreen(__namedParameters: {
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

##### \_\_namedParameters

###### buttonText?

`string`

###### children

`ReactNode`

###### className?

`string`

###### icon?

`ReactNode`

###### subtitle?

`string`

###### title?

`string`

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
function SubmitButton(__namedParameters: {
  children?: ReactNode;
  className?: string;
  pending?: boolean;
  pendingLabel?: string;
  size?: ButtonSize;
}): Element;
```

The form's submit button, disabled and relabelled while a submit is in
flight.

#### Parameters

##### \_\_namedParameters

###### children?

`ReactNode`

###### className?

`string`

###### pending?

`boolean`

Whether the WORK this form started is still going. Separate from the
submit itself, which [Form](#form) disables on its own: a workflow run
outlives its `POST`, and the button should stay busy until the run is done.

###### pendingLabel?

`string`

###### size?

[`ButtonSize`](#buttonsize)

#### Returns

`Element`

***

### TextAreaField()

```ts
function TextAreaField(__namedParameters: FieldShell & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "name" | "className">): Element;
```

A multi-line text input.

#### Parameters

##### \_\_namedParameters

[`FieldShell`](#fieldshell) & `Omit`\<`TextareaHTMLAttributes`\<`HTMLTextAreaElement`\>, `"name"` \| `"className"`\>

#### Returns

`Element`

***

### TextField()

```ts
function TextField(__namedParameters: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "className">): Element;
```

A single-line text input.

#### Parameters

##### \_\_namedParameters

[`FieldShell`](#fieldshell) & `Omit`\<`InputHTMLAttributes`\<`HTMLInputElement`\>, `"name"` \| `"className"`\>

#### Returns

`Element`

***

### ToolCallRow()

```ts
function ToolCallRow(__namedParameters: ToolCallRowProps): ReactNode;
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

##### \_\_namedParameters

[`ToolCallRowProps`](#toolcallrowprops)

#### Returns

`ReactNode`

***

### UploadProgressBar()

```ts
function UploadProgressBar(upload: {
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

##### upload

What `useWorkflowSubmit` reports. `undefined` renders nothing,
  so a page may pass its state straight through.

###### className?

`string`

###### onPause?

() => `void`

###### onResume?

() => `void`

###### upload?

[`UploadStatus`](#uploadstatus)

#### Returns

`ReactNode`

#### Example

```tsx
import { Form, SubmitButton, UploadProgressBar, useWorkflowSubmit, WorkflowFields } from "@alexkroman1/aai-ui";

function TranscribeForm() {
  const { submit, upload, pending, error } = useWorkflowSubmit("transcribe");
  return (
    <Form onSubmit={(values) => submit(values)} error={error}>
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
function useAgentState<S>(): S | null;
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

[`StateProjection`](aai/index.md#stateprojection)\<`V`\>

The same `slot.projection(view)` the agent declares as
  `syncState`. Export it from the module that declares the slot so the two
  ends cannot drift.

##### Returns

`V`

#### Call Signature

```ts
function useAgentState<S>(fallback: S): S;
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

### useEvent()

```ts
function useEvent<T>(event: string, callback: (data: T) => void): void;
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

##### isEqual?

(`a`: `T`, `b`: `T`) => `boolean`

#### Returns

`T`

***

### useTheme()

```ts
function useTheme(): Required<ClientTheme>;
```

Read the resolved theme (every [ClientTheme](#clienttheme) field filled with its
default) from the nearest theme context. Returns the default theme when no
provider is present, so components can call it unconditionally.

#### Returns

`Required`\<[`ClientTheme`](#clienttheme)\>

***

### useToolCallStart()

#### Call Signature

```ts
function useToolCallStart(toolName: string, callback: (toolCall: ToolCallInfo) => void): void;
```

Fire a callback when a tool call starts (before its result arrives).
Optionally filter by tool name.

##### Parameters

###### toolName

`string`

###### callback

(`toolCall`: [`ToolCallInfo`](#toolcallinfo)) => `void`

##### Returns

`void`

#### Call Signature

```ts
function useToolCallStart(callback: (toolCall: ToolCallInfo) => void): void;
```

Fire a callback when a tool call starts (before its result arrives).
Optionally filter by tool name.

##### Parameters

###### callback

(`toolCall`: [`ToolCallInfo`](#toolcallinfo)) => `void`

##### Returns

`void`

***

### useToolResult()

#### Call Signature

```ts
function useToolResult<R>(toolName: string, callback: (result: R, toolCall: ToolCallInfo) => void): void;
```

Fire a callback when a tool call settles, with the tool's JSON result.

For new code prefer explicit events — `ctx.send(event, data)` in the tool
paired with [useEvent](#useevent) here — over listening to tool results.

##### Type Parameters

###### R

`R` = `any`

The result shape. Defaults to [DefaultToolResult](aai/index.md#defaulttoolresult)
  (`any`) so the ordinary untyped spelling compiles; pass the shape —
  `useToolResult<Quote>(…)` — for real checking.

##### Parameters

###### toolName

`string`

###### callback

(`result`: `R`, `toolCall`: [`ToolCallInfo`](#toolcallinfo)) => `void`

##### Returns

`void`

#### Call Signature

```ts
function useToolResult<R>(callback: (name: string, result: R, toolCall: ToolCallInfo) => void): void;
```

Fire a callback when a tool call settles, with the tool's JSON result.

For new code prefer explicit events — `ctx.send(event, data)` in the tool
paired with [useEvent](#useevent) here — over listening to tool results.

##### Type Parameters

###### R

`R` = `any`

The result shape. Defaults to [DefaultToolResult](aai/index.md#defaulttoolresult)
  (`any`) so the ordinary untyped spelling compiles; pass the shape —
  `useToolResult<Quote>(…)` — for real checking.

##### Parameters

###### callback

(`name`: `string`, `result`: `R`, `toolCall`: [`ToolCallInfo`](#toolcallinfo)) => `void`

##### Returns

`void`

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
function useWorkflowProgress<T>(runId: string | undefined, opts?: {
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
function useWorkflowRun<R>(runId: string | undefined, opts?: {
  api?: WorkflowApi;
  intervalMs?: number;
}): UseWorkflowRunResult<R>;
```

Watch one run until it reaches a terminal status.

A watch rather than a subscription because a run is durable and the page is
not: it can complete while the tab is closed, on a different sandbox, hours
later. There is no session to reconnect — the id is the whole state.

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

##### opts?

###### api?

[`WorkflowApi`](#workflowapi)

###### intervalMs?

`number`

#### Returns

[`UseWorkflowRunResult`](#useworkflowrunresult)\<`R`\>

***

### useWorkflowRuns()

```ts
function useWorkflowRuns<R>(workflow: string | undefined, opts?: UseWorkflowRunsOptions): UseWorkflowRunsResult<R>;
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

#### Returns

[`UseWorkflowsResult`](#useworkflowsresult)

***

### useWorkflowStream()

```ts
function useWorkflowStream<R>(workflow: string, opts?: UseWorkflowStreamOptions): WorkflowStreamSubmission<R>;
```

Start a workflow run and stream a file into it while it works.

The workflow declares which input property carries the upload
(`workflow({ uploads: ["recording"] })`) — the same declaration
`useWorkflowSubmit` reads, because what the property carries is an upload id
either way. What differs is only WHEN the id becomes valid.

#### Type Parameters

##### R

`R` = `unknown`

The workflow's output type, which is what makes
  `run.status === "completed"` narrow to a typed `run.output`. Derive it with
  `WorkflowOutputOf<typeof myWorkflow>`.

#### Parameters

##### workflow

`string`

##### opts?

[`UseWorkflowStreamOptions`](#useworkflowstreamoptions)

#### Returns

[`WorkflowStreamSubmission`](#workflowstreamsubmission)\<`R`\>

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
function useWorkflowSubmit<R>(workflow: string, opts?: UseWorkflowSubmitOptions): WorkflowSubmission<R>;
```

Start a workflow from a form, and follow the run it creates.

#### Type Parameters

##### R

`R` = `unknown`

The workflow's output type, which is what makes
  `run.status === "completed"` narrow to a typed `run.output`. Derive it with
  `WorkflowOutputOf<typeof myWorkflow>`.

#### Parameters

##### workflow

`string`

##### opts?

[`UseWorkflowSubmitOptions`](#useworkflowsubmitoptions)

#### Returns

[`WorkflowSubmission`](#workflowsubmission)\<`R`\>

#### Example

```tsx
import { Form, SubmitButton, TextField, useWorkflowSubmit } from "@alexkroman1/aai-ui";

function DigestForm() {
  const { submit, run, pending, error } = useWorkflowSubmit("digest");
  return (
    <Form onSubmit={(values) => submit(values)} error={error}>
      <TextField name="url" label="Link" type="url" required />
      <SubmitButton pending={pending}>Digest</SubmitButton>
      {run?.status === "completed" && <p>Done.</p>}
    </Form>
  );
}
```

***

### WorkflowFields()

```ts
function WorkflowFields(__namedParameters: {
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

##### \_\_namedParameters

###### workflow?

`string` \| [`WorkflowSummary`](#workflowsummary)

#### Returns

`Element` \| `null`

#### Example

```tsx
import { Form, SubmitButton, WorkflowFields, useWorkflowSubmit }
  from "@alexkroman1/aai-ui";

function StartRun() {
  const { submit, pending, error } = useWorkflowSubmit("transcribe");
  return (
    <Form onSubmit={(values) => submit(values)} error={error}>
      <WorkflowFields workflow="transcribe" />
      <SubmitButton pending={pending}>Transcribe</SubmitButton>
    </Form>
  );
}
```

***

### WorkflowProgress()

```ts
function WorkflowProgress(runId: {
  api?: WorkflowApi;
  className?: string;
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

##### runId

The run to read. `undefined` renders nothing, so a page may
  pass its state straight through before a run exists.

###### api?

[`WorkflowApi`](#workflowapi)

###### className?

`string`

###### placeholder?

`ReactNode`

###### runId?

`string`

#### Returns

`ReactNode`

#### Example

```tsx
import { WorkflowProgress } from "@alexkroman1/aai-ui";

function RunPanel({ runId }: { runId: string }) {
  return <WorkflowProgress runId={runId} />;
}
```
