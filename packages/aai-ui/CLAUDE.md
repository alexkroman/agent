# packages/aai-ui — browser client guide

The browser client (`@alexkroman1/aai-ui`): session, audio, React UI. Repo-wide
conventions and testing rules live in the root `CLAUDE.md`.

## Package exports

- `.` — default React UI component + session + client helpers
- `./styles.css` — default styles
- `./default-client/*` — prebuilt default client assets (`dist/default-client/`)
- `./client-dir` — **Node only**: `defaultClientDir()`, the filesystem path of
  those assets, for passing to `createRuntimeServer`/`createAgentServer` as
  `clientDir`. Its own subpath because it imports `node:module`/`node:path`,
  which must never reach the browser barrel. It is a FUNCTION, not a constant:
  resolution throws when the package is missing, and a module-level constant
  would move that failure to import time, firing for callers that never wanted
  the client. `aai-cli`'s dev server and every self-hosted example used to
  carry their own copy of the three-line resolve.

## The authoring surface is versioned in epochs

**This package's exports are authored code, and they are contracted the same way
the SDK's are.** The mechanism, the classification workflow (`--retain` /
`--drop`), and why an epoch obliges a frozen compiling example all live in
`docs/CLAUDE.md`'s "The authoring surface is versioned in epochs" (moved there
from the root when `AGENTS.md` hit its cap); what is local to
here is the naming. `contracts/entrypoints/` declares **nine capabilities**, and
between them they must name every `@public` export of `.` and `/client-dir` — a
new one fails `pnpm check:api-contracts` until it joins one:

| Capability | What it promises |
| --- | --- |
| `client` | the voice mount — `client()`, the one flat `ClientConfig` it takes, the handle |
| `page` | the workflow-app mount — `page()`, with no session under it, plus `fetchClientConfig()`: the lookup `client()` does for itself and a page must ask for |
| `session` | the live call: `SessionCore`, the snapshot, `useSession`, `useUserTranscript`, `useConversation` + `ConversationItem`, the errors |
| `hooks` | what a client reads off the AGENT: `useAgentState`, the two tool hooks, `useEvent` |
| `components` | the design system a custom chrome is assembled from, `ConsoleShell` included. The three memoized components (`Markdown`, `Controls`, `MessageList`) each name an exported props type, which is what makes their props render at all — see below |
| `forms` | `<Form>`, the field components, `<WorkflowFields>` |
| `workflow` | `createWorkflowApi`, `useWorkflowRun`, `useWorkflowProgress`, `<WorkflowProgress>`, `useWorkflowSubmit`, `useWorkflows`, `useDownloadUrl`, `WORKFLOW_STATUS_LABELS`, `WorkflowRunStatus`. At **epoch 1** — the reset collapsed its history; the change worth knowing is that the requests moved to the SDK: `WorkflowApi` is re-exported from `@alexkroman1/aai/workflow-api` rather than declared here, which adds no name and makes a client from either factory the same type. That re-export is also what carries `follow`/`followOutput` here for free — this package's own readers do NOT use them, because a hook needs the raw `Response` to see a 404 and fall through to its poll |
| `theme` | `ClientTheme` + `useTheme`, and the five `--aai-*` CSS variables `ThemeProvider` writes — its own contract because a token is a name in somebody's CSS |
| `client-dir` | `defaultClientDir()`, the one export a SERVER calls |

Three things to know before touching them.

**A capability id is qualified — `aai-ui:forms`, not `forms`.** `workflow`
names a capability of both packages (the SDK declares a workflow, this reaches
one over HTTP) and they version independently, so the CLI refuses a bare
ambiguous name rather than guessing.

**A compatibility fixture here would be `.tsx`** — a frozen example for a
component library is JSX or it is not evidence — and `pnpm typecheck` is what
runs one, so a break in this package's types surfaces as a compile error inside
`contracts/compatibility/<capability>/v<N>.tsx` naming the epoch it broke. There
are none today: with no external consumers every superseded epoch is `--drop`ped
rather than retained, so the directory does not exist. Two findings came out of
writing the first set anyway: `WorkflowApiOptions.token` cannot take an explicit
`undefined` under `exactOptionalPropertyTypes`, and `api.get` is deliberately
untyped (`useWorkflowRun<R>` is where a page names the shape).

**Four tuning CONSTANTS followed the eight, and they are the case the tag never
marked.** `TRANSCRIBING_PLACEHOLDER`, `DEFAULT_PROGRESS_POLL_MS`,
`DEFAULT_WORKFLOW_POLL_MS` and `MAX_MISSING_READS` were `@public` on the root
barrel. Each appeared in `etc/index.api.md` as its own `export const` and in no
other line — no public signature names one — and no file outside this package
named one either. They are the same category as `aai`'s
`PLAYBACK_CONCEAL_FLOOR` and `MIC_SILENCE_PROBE_MS`: a framework decision with
no field to set, in a `client.tsx` author's autocomplete. The hooks that own the
two intervals take them as an OPTION, which is the authoring surface for the
same choice and stays public. Moving them cost `aai-ui:session` and
`aai-ui:workflow` an epoch each, both `--drop`ped.

It also surfaced the coupling worth watching when a name goes internal:
`UseUserTranscriptResult.text` documented itself with
`{@link TRANSCRIBING_PLACEHOLDER}`, so the move broke `pnpm check:docs-md`
(`treatWarningsAsErrors` makes an unresolvable link an error). The fix is the
right one anyway — a public type's doc now spells the value out rather than
linking a name a reader cannot import.

`WebSocketConstructor` was the near miss and STAYED: it looks like the same
category and `VoiceSessionOptions.WebSocket?` names it, so moving it would have
made a public field's type unnameable. Read the report, not the name.

**The `@internal` ratchet here stands at ZERO**, and `internal.ts` is what paid
it off. It stood at eight — `SessionProvider`, `ThemeProvider`,
`ToolConfigContext`, the three URL chips (`ApiUrlChip`, `UiUrlChip`,
`SessionUrlChips`) and two thirds of the client-config trio (`buildAgentUrl`,
`loadClientConfig`) — every one importable from the root and sitting in a
client author's autocomplete beside `client()`, `<Form>` and `useWorkflowRun`
while no capability contract covered it. `client()` and the default client
install all eight, so deleting them was never the option; the tag was the only
thing marking them, and a tag is not a boundary.

**The mechanism is a subpath, because a tag on a re-export is not one.** API
Extractor reads `@internal` at the DECLARATION site, so a tag written on a
member of an `export { … } from` clause is silently ignored and the name stays
`@public` in `etc/index.api.md`. The exemption in
`contracts/internal-surface.json` is per SUBPATH, which is the same fact from
the other side: a name on the root barrel earns an entry on that ratchet no
matter how it is tagged. So the eight moved to
`@alexkroman1/aai-ui/internal` (`internal.ts`), which
`NON_AUTHORING_SUBPATHS` in `scripts/_api-contracts-tree.mjs` deny-lists — the
third package to do this, after `aai` (71 → 0) and `aai-runtime`. Nothing
in-package changed at the import sites: every one of the eight was already
imported from its own module (`context.ts`, `components/url-chips.tsx`,
`client-config.ts`), never through the barrel.

**The rule that comes with it, and it runs both ways.** A name that wants to be
PUBLIC gets its `@internal` tag removed and joins a capability contract; it does
not stay on the root barrel wearing a tag. A name that is genuinely internal
goes on `/internal`; it does not stay on the root barrel wearing a tag either.
The ratchet is at zero, so there is no third option left — a new `@internal`
export reachable from the root fails `pnpm check:api-contracts` outright rather
than adding a line to a list.

Two wiring notes for anything added to `internal.ts`. It is a published subpath,
so it needs its `exports` triple in `package.json` and its entry in
`tsdown.config.ts`, whose entry list is HARDCODED here (unlike `aai-runtime`,
which derives one). And it is deliberately NOT a typedoc entry point:
`UNDOCUMENTED_SUBPATHS` in `scripts/docs-markdown.mjs` carries the reason, and
that gate fails BOTH ways — documenting a subpath and deny-listing it is an
error, so the entry there is what makes the absent entry point legal.

**`fetchClientConfig` is what came off it, and the reason generalizes.** It was
tagged `@internal` while a `@public` doc comment in the SDK
(`sdk/agent-params.ts`) told a workflow-app author to call it — "a page that
wants `name`/`greeting` calls `fetchClientConfig()` itself" — so the published
reference instructed a reader to use a symbol it excluded, and its return type
`ClientConfigResponse` was a contracted public type no public signature could
produce. It is `@public` now and belongs to the `page` capability, `page()`
being the mount that makes the lookup a caller's job — which is the first half
of the rule above, applied before there was a subpath to apply the second half
to. The other two stay internal and are on `/internal`:
`loadClientConfig`'s `null`-vs-`{}` distinction is a session implementation
detail, and `buildAgentUrl` is a two-line path join.

**`SessionCoreOptions` is gone**, and epoch 1 of `session` went with it. It was
an exact alias of `VoiceSessionOptions` with one referent —
`createSessionCore`'s parameter, which names `VoiceSessionOptions` directly now
— and `client()` never took it, so the "two names, one type" note the alias
carried was an argument for having one.

## A memoized component must NAME its props type

`Markdown`, `Controls` and `MessageList` are `export const X = memo(fn)`, and
for as long as that type was INFERRED the published reference described all
three as taking nothing: `const Markdown: MemoExoticComponent;` was the entire
declaration, so `text` — a REQUIRED prop — was named nowhere a reader could
find it.

The cause is not `memo` and not the props being an inline object type. It is
the shape `tsc` emits for an inferred type: `import("react").MemoExoticComponent<…>`,
and `typedoc-plugin-markdown` drops the type ARGUMENTS of an `import(…)`
reference. Measured against the plugin directly: the same declaration written
with a NAMED import renders its arguments in full, in every combination —
inline function type, `FunctionComponent<Props>`, anything.

So each of the three carries an explicit annotation
(`MemoExoticComponent<FunctionComponent<MarkdownProps>>`) written from imported
names, which is what `tsc` then emits verbatim. The props types are exported
because `treatWarningsAsErrors` refuses a named-but-unexported type on a public
signature, and they are the `ToolCallRowProps` pattern the package already used
— a named props type renders every property with its own prose.

Two consequences worth knowing before adding a component here:

- **An INTERSECTION in a parameter position loses per-property prose.** A pure
  inline object type expands into a documented property list; `A & Omit<B, …>`
  is flattened to one type expression and every property's doc comment is
  dropped. Measured, and unchanged by `typeDeclarationVisibility` — it is the
  plugin, not a config choice. So the field components
  (`TextField`, `SelectField`, `FileField`, … — all `FieldShell & Omit<…HTMLAttributes>`)
  document their extras in the component's own prose, and the shared four are
  documented once on `FieldShell`, which is a NAMED type and therefore renders.
- **`@param <prop>` on a destructured parameter is silently discarded.** TypeDoc
  takes the FIRST `@param`'s name as the name of the whole object and drops the
  rest, so `AutoScroll` rendered as `AutoScroll(children: {…})` with six of its
  seven prop docs gone, and `Button` as `Button(variant: {…})` — which invites
  `<Button variant={{ variant: "ghost" }}>`. One `@param props` plus JSDoc on
  each property inside the object type is the spelling that works; a component
  with no `@param` at all renders the compiler's `__namedParameters`.

## Key files

- `index.ts` — main exports, React UI component
- `internal.ts` — the `/internal` subpath: the eight names `client()` installs
  for itself, kept off the root barrel so the contracted surface and the
  importable one are the same list. See "The `@internal` ratchet" above
- `session-core.ts` — WebSocket session management + reactive snapshot
  (`createSessionCore`); split across `session-core-messages.ts`
  (message/history handling) and `session-core-types.ts`
- `context.ts` — SessionProvider, useSession, useSessionCore,
  useSessionSelector, ThemeProvider, useTheme
- `hooks.ts` — useToolResult, useToolCallStart, useEvent
- `audio.ts` — PCM encoding/decoding, AudioWorklet management
- `define-client.tsx` — client mount helper, and the two pieces `page()` shares
  with it: `resolveContainer` (the default `#app` selector and its error
  sentence) and `mountRoot` (the root, the `flushSync`, and the disposable
  handle). Both mounts were written out in full, comments included; what
  actually differs between them is only the tree
- `default-client.tsx` / `build-default-client.ts` — the default UI shipped
  to agents with no `client.tsx`, and its build step
- `_workflow-api-ref.ts` / `_repeat-until.ts` — the two scaffolds the workflow
  hooks are built out of: the client-in-a-ref preamble (five copies) and the
  "bounded read, re-armed from the settled read" loop (two)
- `types.ts` — UI type definitions
- `components/` — UI components (console-shell, chat-view, controls,
  message-list, auto-scroll, start-screen, sidebar-layout, tool-call-block,
  button, aai-logo, tool-config-context)

## `useConversation` is the conversation; `MessageList` is one renderer of it

`<MessageList>` used to own four decisions behind a single `className` prop, so
a client that wanted its own bubble markup dropped all four at once:

- the message/tool-call **interleave** (a tool call renders after its
  `afterMessageId` anchor; an orphan whose anchor slid out of the 200-message
  window leads),
- the **streaming** agent bubble,
- the live **transcript** row, with the `null`-vs-`""` protocol distinction,
- the **thinking** indicator's suppression rule (off while a tool call is
  pending, off once a trailing agent message has landed with nothing after it).

Three template chromes did exactly that and shipped a worse conversation each —
`retail` runs FIFTEEN tools and rendered none of them, because tool calls live
in a second array nothing in that page read; `dispatch-center` eight;
`infocom-adventure` its eight `game_state_*` calls and every partial of the
narrator's reply.

`useConversation()` (`use-conversation.ts`) is that data with nothing rendered:
`{ items, streaming, transcript, thinking }`, where `items` is a discriminated
union of `{ kind: "message" }` / `{ kind: "tool" }`. **`<MessageList>` is a thin
consumer of it now, and that is the acceptance test rather than a tidiness
argument** — a hook the package's own list cannot be rebuilt from is a hook a
custom chrome will find a hole in.

It subscribes with per-field `useSessionSelector` calls, never whole-page
`useSession()`, and that is half the value: the three hand-rolled chromes all
called `useSession()`, which re-renders on EVERY snapshot change, so a dispatch
board re-rendered at STT-partial rate. `use-conversation.test.tsx` pins it — an
`apiUrl` + `recording` update produces no render.

**The ACTIONS are the other half, and `useSessionActions()` is the answer.** The
only public route to `start`/`toggle`/`end` used to be `useSession()` — a
whole-snapshot subscription for four methods, so four components across three
templates re-rendered at STT-partial rate. It is `useSessionCore` narrowed to
the eight methods: no subscription, no store on the object it returns. Pair it
with a one-field `useSessionSelector`, or with `useSessionStatus()` /
`useSessionError()`, the only two fields more than one chrome selects.

`retail` and `dispatch-center` are the worked examples of the conversion: both
were a single `App()` mapping `session.messages`, and both split into `Row` /
`Conversation` / `StatusReadout` / `ErrorBanner` / `Controls`, which is what
leaves `App` holding only `useAgentState(projection)`.

### `ConsoleShell` is public, `role="alert"` is why — and no template adopted it

`ConsoleShell` already had exactly the right prop shape (`icon, title, state,
pulsing, children, footer`) and was `@internal`, so each custom chrome
rebuilt the frame too — and every one of them re-derived the error banner
WITHOUT the `role="alert"` that `console-shell.tsx` argues is load-bearing: per
the `fatalError` latch in `session-core.ts` the banner is the only remaining
signal, the state eyebrow beside it having gone back to reading like a live
session. Reach for `ConsoleShell` when the conversation is yours and the frame
is not; reach for `ChatView` when both are ours.

**It was published in the same change that converted three custom chromes, and
all three declined it** — record that as the open question it is. It is a whole
FRAME: a centred `max-w-190` column with its own header (icon + title + state
eyebrow) and footer. `retail` and `dispatch-center` are full-bleed
`1fr / 320px` grids whose headers carry things it cannot express ("Verified ·
Olivia Ito", "SYSTEM ALERT: RED"); `infocom-adventure` is a CRT. Adopting it
would replace the design each template exists to demonstrate. What all three
actually needed was the `role="alert"` banner INSIDE it, and that is
`<SessionErrorBanner>` now — its own export, COMPOSED here (so the shell takes
no `error` prop), so a full-bleed chrome takes the announced-error decision
without the frame. The three copies had already drifted, one dropping
`error.code`. By the coverage gate's own rule `ConsoleShell` and
`ConsoleShellProps` are either missing their example or should not be public,
and on this evidence it is the second — worth revisiting before the release
rather than leaving as an allowlist entry nobody reads.

## `AutoScroll` is the only scroll-pinning implementation

`components/auto-scroll.tsx` wraps `use-stick-to-bottom` (pin to the bottom as
content grows, release when the reader scrolls up, re-engage at the bottom).
`MessageList` renders it rather than the library directly, so there is one
owner, and it is EXPORTED because the clients that need it most are the ones
not using `MessageList` — a custom chat chrome (a terminal, a dispatch board)
that would otherwise hand-roll the effect.

The hand-rolled version is a `useEffect` calling
`ref.current?.scrollIntoView()` keyed on `session.messages`, and it fails three
ways that compound: it fights the reader, since scrolling up to re-read is
undone by the next transcript delta; it misses growth that is not a new message
(a streamed reply, an expanding tool block, a markdown reflow all change height
without changing the dependency array); and it needs a synthetic dependency
(`messages.length + transcript.length`) to fire at all, which is where the dead
`if (version < 0) return;` line in `infocom-adventure`'s copy came from. A
`ResizeObserver` on the content has none of those.

The one constraint callers get wrong: the outer container **must have a bounded
height** (`flex-1 min-h-0`, `h-full`, a fixed height). An unbounded one grows
with its content and never scrolls, so nothing pins.

## `null` and `""` are different turns (`useUserTranscript`)

`SessionSnapshot.userTranscript` is `string | null`, and both falsy values mean
something: `null` is silence, `""` is **speech detected with no words back yet**
— where a live session sits for a few hundred milliseconds at the start of every
turn. Read as one falsy check they collapse, and the live-transcript row then
appears a beat late, on the first word rather than on the first sound, which is
the moment it exists for.

`useUserTranscript()` returns that as two named things — `speaking` (render on
this) and `text` (`TRANSCRIBING_PLACEHOLDER` while there are no words) — plus
the raw `partial` for a chrome supplying its own placeholder. The three
custom-chrome templates had each written the ternary by hand, re-deriving a
protocol distinction from the type; nothing told them.

It subscribes narrowly, so a component using it re-renders at STT-partial rate.
That is what it is for and what a whole-page `useSession()` should not do —
`ChatView`'s own comment makes the same point about the shell.

## `useAgentState` takes the PROJECTION, and that closes the round-trip

Three overloads, and the third is the one to reach for. `useAgentState<S>()`
returns `S | null` — nullable because nothing has been pushed before the first
tool call. `useAgentState<S>(fallback)` returns `S`. **`useAgentState(projection)`
returns the projection's own type, defaulted by the projection itself**, and
takes no type argument at all.

Every real consumer wanted the second, and then wrote the third by hand. Four of
the six template clients immediately wrote `?? EMPTY`, and five built `EMPTY` by
running their own `syncState` projection over an empty state —
`slot.projection(view)(undefined)` — which was the documented pattern and the
right one, because a field added to the projection then reaches the first render
instead of being `undefined` in that one frame. What it cost is that **the
projection was composed at BOTH ends**: `agent.ts` declared
`slot.projection(view)` and `client.tsx` built the same expression again, so the
two could name different views of one slot with nothing checking. And **the type
was restated three times** — the view's own return type, the `EMPTY` annotation,
and the hook's type argument — all derivable from the projection.

So the shape to copy is one export from the module that declares the slot, and
both ends importing it:

```ts no-check
// shared.ts — composed once, so the two ends cannot drift.
export const cartProjection = cartSlot.projection(cartView);

// agent.ts
export default agent({ name: "Shop", syncState: cartProjection });

// client.tsx — no type argument, no empty frame to derive.
const cart = useAgentState(cartProjection);
```

**It also memoizes the frame, which the `fallback` overload can only ask for.**
That overload's doc says to hoist `EMPTY` to module scope because the hook does
not memoize; a `slot.projection(view)` spelled inline in a render body silently
got that wrong, returning a fresh object per render and re-firing every
downstream memo and effect. Keyed on the projection's identity, a module-scope
projection now yields one frame for the component's life.

**Discriminating the overloads is `typeof fallback === "function"`**, which is
sound rather than a heuristic: `agentState` is whatever crossed the wire as
JSON, so no legitimate fallback value can be a function. The projection overload
is declared FIRST, and that ordering is load-bearing — `fallback: S` infers `S`
as the projection type and swallows it otherwise, which `hooks.test-d.ts` caught
on the first draft.

The one place to prefer the `fallback` overload is a slot whose `create()` is
EXPENSIVE TO IMPORT. `retail`'s does: its factory pulls a 107 KB `seed.json`, and
the projection overload calls `create()`, so passing the projection would ship
the catalog to the browser. Its client says so in place.

Note the fallback is only substituted for `null`, and an absent argument still
reads back as `null` rather than `undefined` — a client spelling
`state === null` predates the overload. `hooks.test-d.ts` pins all three
signatures, since an overload is a type-level contract a runtime suite cannot
assert; `hooks.test.ts` covers the memoization and the discrimination, which are
the halves that are runtime behaviour.

## The theme is CSS VARIABLES too, and `useTheme()` still exists

`useTheme()` returns a JavaScript object, and `context.ts` admitted outright
that "a Tailwind class cannot see it" — so every styled node in a custom client
carried an inline `style={{ }}`. Measured ratio of `theme.` reads to `style={{`
in the template clients: `night-owl` 10:10, `travel-concierge` 9:8,
`plan-and-execute` 8:8, `pizza-ordering` 8:8, `support-line` 5:5.

The package already knew the fix and used it three times internally (`Button`'s
`--aai-btn-bg` consumed as `bg-(--aai-btn-bg)`, `FileField`'s
`::file-selector-button`, `SidebarLayout`'s `--aai-sidebar-w`) and published
none of the five theme tokens. `ThemeProvider` writes `--aai-bg`,
`--aai-surface`, `--aai-text`, `--aai-border` and `--aai-primary` onto
`document.documentElement`, and `styles.css`'s `@theme` block maps them into
Tailwind's `--color-*` namespace, so `className="bg-aai-surface text-aai-text
border-aai-border"` works. `night-owl` went from 10 reads and 10 style objects
to zero and zero with its custom dark palette unchanged.

Four things to keep:

- **This is ADDITIVE.** `useTheme()` stays: `inkTint`/`primaryTint` in
  `components/_colors.ts` do `color-mix` on the RESOLVED values, and a page is
  entitled to read the object for a `satisfies`-pinned palette.
- **What survives conversion is a value a CSS property needs and a class cannot
  express — usually a multi-value SHORTHAND, not arithmetic.** Every read in the
  five clients measured above was a plain token in a `color`/`background`/
  `border-color` position, ternaries included (`on ? theme.primary :
  theme.surface` is two classes, not a computation). The one genuine survivor
  found across five templates is `scrollbar-color`, which takes TWO values and
  has no utility: `infocom-adventure`'s transcript reads `theme.primary` and
  `theme.surface` for it rather than re-pinning the two hex codes its own
  `client({ theme })` block already declares.
- **The page background is still painted imperatively on `html` AND `body`.** A
  variable only paints where some rule consumes it, and those two elements are
  the ones nothing in this package renders — that is the letterboxing bug
  `usePageBackground` was added for, and `theme-css-vars.test.tsx` holds it.
- **The `styles.css` fallbacks ARE `DEFAULT_THEME`**, so the utilities work on a
  page that mounts no provider. Two copies, so a test compares them directly;
  nothing else can see that drift. The variables are RESTORED on unmount rather
  than removed — a host page may have set its own `--aai-*` before mounting.

## Four `ClientConfig` display fields the shell components already took

`DefaultShell` forwarded three of the seven fields the two components under it
accept: `StartScreen` takes `icon`, `subtitle`, `buttonText`; `SidebarLayout`
takes `sidebarPosition`; none of the four was on `ClientConfig`. So `solo-rpg`
wanted all four, could say none in config, and dropped to the `component:` tier
for a 27-line wrapper whose only job was to re-say what `client()` already knows
how to say — and which dragged `useAgentState` up a level so its `Sidebar` had
to take the projection as a PROP. All four are `ClientConfig` fields now, the
wrapper is deleted and the `Sidebar` subscribes itself.

`sidebarPosition` routes through the same `rootFor` branch that already builds a
`SidebarLayout` beside a `component`, for the reason `sidebar` itself does: the
two branches build the same layout, and a field honoured by only one of them is
the shape this config used to have. `icon` reaches BOTH the start card and the
shell header — they are one mark, and an agent whose start screen shows a pizza
and whose header shows our logo reads as two products. The forwarding bag is a
MAPPED type over `Pick<ClientConfig, …>`, not a bare `Pick`:
`exactOptionalPropertyTypes` is on and every field arrives from a spread that
cannot know which keys the caller wrote.

**Session resume: the default is the fix, and the hand-wired version was worse.**
`solo-rpg` was the one template of fourteen that wired
`onSessionId`/`resumeSessionId` by hand — the shape `session-resume-store.ts`
cites as a default in the wrong place — and the copy used **`localStorage`**, so
it was not duplicating the new default but OVERRIDING it with the wrong store. A
pointer into a live call that survives a new tab and a visit tomorrow suppresses
the greeting (`parseWsUpgradeParams` keys that off the id's mere presence) and
rejoins a conversation whose context is gone. Deleting the four lines is a bug
fix.

## STATE or a MOMENT: which mechanism a tool's answer belongs in

A tool can hand the page STATE or a MOMENT, and there is a different mechanism
for each — `useAgentState(projection)` over a `sessionSlot` for the first,
`useEvent` / `useToolCallStart` for the second. `night-owl` is the template that
puts them side by side deliberately, because it is the first one a reader meets
that leaves `agent.ts` for a `.tsx` file and it is where the choice is easiest
to get wrong.

Its recommendation LOG is state: a slot, projected by `syncState`, read by
`useAgentState(nightProjection)`. It used to be a `useState` in the sidebar
rebuilt from a `ctx.send("recommendations", …)` per call, which made the list
DERIVED — so a page that mounted late or reloaded mid-session started empty
while the session it reconnected to still remembered every pick. That is the
same defect `pizza-ordering` records paying ~45 lines for, by a shorter route.
Its "finding something cozy…" flash and its wind-down nudge are moments:
`useToolCallStart` never replays by construction (a start is about the instant),
and the nudge is a `ctx.send` precisely because re-delivering it on every
reconnect would be nagging.

**The rule: if re-rendering it after a reload would be RIGHT, it is state and
belongs in a slot. If re-rendering it after a reload would be a LIE (a spinner
for a finished call) or a nuisance (a nudge shown twice), it is a moment and
belongs in an event.** Keeping both mechanisms on one screen is better teaching
than splitting them across two templates, which is why `night-owl` still holds
the only demonstration of the event hooks.

## Client audio path (browser ⇄ server)

Both legs carry **raw PCM16 over the session WebSocket** — 384 kbps down at
24 kHz, 256 kbps up at 16 kHz, uncompressed, with the mic streaming
continuously (barge-in needs it open). That budget is the backdrop for
everything below: a jitter buffer absorbs *jitter*, and no size of buffer
fixes a link that cannot carry the bitrate in real time.

**Playback is a jitter buffer with hysteresis, not a startup delay**
(`aai-ui/worklets/playback-processor.ts`). It fills to `PLAYBACK_JITTER_MS`
before a turn speaks, and on an underrun it returns to filling — to the
shorter `PLAYBACK_REFILL_MS`, because mid-reply a long wait is itself a hole
in the speech. The re-arm is the whole point: while the gate only guarded the
*start* of a turn, one stall left `readPos` chasing `writePos` and every later
quantum emitted a few real samples padded with silence, so a single network
hiccup turned the rest of the reply into ~5ms fragments — stutter through
every word rather than one pause. A starved quantum never advances `readPos`,
so buffered audio survives intact.

Gaps are **concealed**, not zero-filled: the worklet loops the retained tail
of played audio under a decay to silence (`PLAYBACK_CONCEAL_FADE_MS`). A hard
zero-fill is a discontinuity mid-word, which is what makes a brief stall sound
like breakage rather than a pause.

**Underruns are reported, in WebRTC's counter shape.** Each turn's `stop`
message carries `concealedSamples`, `silentConcealedSamples` (a subset, as in
`getStats()`), `concealmentEvents`, and `silentConcealmentEvents`, surfaced as
`VoiceIOOptions.onPlaybackStats` (the default session leaves it unwired).
Nothing else marks an underrun — the session still reports `"speaking"` and
`done()` still settles — so this is the only way to tell a turn that needed
its cushion from one that didn't, and the only honest basis for retuning
`PLAYBACK_JITTER_MS`. A high `silentConcealedSamples` share means the stall
outran what concealment can cover, i.e. a bandwidth problem rather than a
tuning one.

**A turn's drain completion is guarded twice, because the drain outlives the
turn.** `done()` resolves when the worklet drains — which also happens the
moment the AudioContext stops rendering — so a reply's completion can land
long after the turn, or the whole session, is over. Both guards were added
after the fuzz harnesses (`aai-ui/fuzz-*.test.ts`) caught the two failures:

- **The turn epoch lives on `ConnState.turn`, not in the message handlers**,
  and `cleanupAudio()` bumps it alongside every committed user turn /
  barge-in / reset. Teardown is a turn boundary: hanging up mid-reply,
  a fatal error, or a reconnect closes the context, the pending
  `settleWhenAudioDrained` continuation resolves a second later, and without
  the bump it wrote `state: "listening"` over the session's own
  "disconnected"/"error" — a dead session claiming a live mic in the header.
- **The worklet's `stop` carries the turn id its `done` named**
  (`playback-processor.ts` echoes it; `audio.ts` only settles the wait whose
  id matches). Dropping `reason: "interrupt"` stops is not enough: a REAL
  drain-stop already in flight when a barge-in flushes is a legitimate stop
  for a turn the host has moved past, and settling on it reported the next
  reply finished while it was still speaking.

**The server paces audio out at a bounded lead** (`aai/host/audio-pacer.ts`,
wired into `ws-handler.ts`'s `ClientSink`). TTS outruns playback, so relaying
each provider frame on arrival put a whole reply into the socket buffer at
once; on a slow link that is seconds of queue the server cannot see into,
bounded only by the `MAX_CLIENT_WS_BUFFERED_BYTES` disconnect.
`CLIENT_AUDIO_LEAD_MS` **must stay above `PLAYBACK_JITTER_MS`** — the lead is
the client's only source of cushion, so pacing at exactly real time would
leave the playback buffer unable to fill. Holding audio back makes two
orderings load-bearing, both enforced by the pacer:

- `audio_done` is queued **behind** pending audio. It is a turn boundary; the
  worklet takes it as "this is all there is", so an early one truncates the
  reply.
- A `cancelled`/`reset` event **discards** held audio. The client flushes its
  own buffer on those events, so anything still held would arrive afterwards
  and play as an orphan fragment.

**Capture runs on its own AudioContext at the STT rate**, and the worklet
converts no rates (`aai-ui/worklets/capture-processor.ts`). The browser's
resampler is band-limited; the linear interpolation this replaced folded
everything above the new Nyquist back into the band as aliasing. Playback
keeps a separate context at the TTS rate, and the two collapse into one when
the rates match. There is deliberately **no fallback resampler**: `audio.ts`
asserts the browser honored both requested rates and fails init otherwise,
because a context at another rate either ships audio to a socket that declared
a different rate or plays PCM at the wrong speed — a loud failure beats
either.

**Capture is raw voice, echo cancellation aside.** Both `getUserMedia`
call sites (the WebSocket mic and `createPttRecorder`) share one
`VOICE_CAPTURE_CONSTRAINTS` (declared in `types.ts`, re-exported on
`/internal`), because copies of the object drifted apart
trivially. `autoGainControl`, `noiseSuppression`, and `voiceIsolation` are all
**off**: each rewrites the signal before STT sees
it — AGC continuously retargets level, so it rides the noise floor up through
silence, while
suppression and isolation discard signal and can gate a quiet room to *exact*
zeros, which is also what a dead mic looks like. `echoCancellation` stays on:
the mic is open while the agent speaks (barge-in needs it), so without AEC the
agent hears itself and interrupts its own reply.

**A dead microphone is detected once per session.** An OS-muted or wrong input
device delivers digital silence, which from every other vantage point is
identical to a user who has not spoken: socket up, session listening, no turn
ever committed. The capture worklet watches the first `MIC_SILENCE_PROBE_MS`
for any nonzero sample (a live mic in a quiet room still carries a noise
floor) and reports once via `VoiceIOOptions.onMicSilent`. It disarms on the
first real sample, so it costs nothing after the window and cannot fire
mid-session.

## Workflow apps

An agent's front door is a microphone or a form, and `AgentDef.page` is the
declaration. `"voice"` (the default; absent means this everywhere) is the whole
product so far. `"static"` declares a **workflow app**: an ordinary web page
over the workflow HTTP API, with no session, no WebSocket and no audio.

This section covers the surface end to end because the author-facing half is
here — `page()`, `createWorkflowApi()`, `useWorkflowRun()` — and
`packages/aai/CLAUDE.md` is at its size cap. The routes themselves are served by
`aai/host/workflow-api.ts`, whose module doc is the authoritative table.

### `workflowApp()` is the server-side half of the same split

An author declares one with `workflowApp({ name, workflows })`
(`@alexkroman1/aai`), not with `agent({ …, page: "static" })`. It returns the
same `AgentDef` — one definition type, one config, one deploy path, and `page`
stays a statement about the front door — so this is an authoring seam, never a
second runtime shape.

**The parameter type is what earns it.** `AgentParams` grew a fourth arm,
`StaticAgentParams`, keyed on the front door rather than on a session mode; it
accepts `name`, `greeting`, `workflows` (REQUIRED — an app whose whole API is
`/workflows/*` and which declares none serves a form that 400s on every submit)
and `requiredEnv`, and types every other field as a `WorkflowAppMisuse` message.
That list is derived from `ProviderField` and `PipelineOnlyField`, so a new
provider stage or voice knob is refused here without anyone remembering to add
it.

**Both halves are load-bearing.** The three voice arms had to start refusing
`page: "static"` from their side (`StaticFrontDoorMisuse`), because an arm every
other arm also matches never bites: with `page` left on `SharedAgentParams`,
`agent({ voice: "michael", page: "static" })` resolved against
`PipelineAgentParams` and configured a TTS voice for an app that never speaks.

**The cost of not having this was already shipped.** `link-digest` carried
`systemPrompt: "Summarize links into three honest points."` — instructions to a
model that never runs, since a static agent has no session and no LLM loop, and
a `"use step"` body calls whatever model client it imports itself. The comment
above it claimed `GET /client-config` served it; that endpoint serves `name`,
`greeting` and `page`, and has never carried a system prompt. Both workflow-app
templates are now three lines and every one of them does something.

`greeting` survives as declarable because it is the one client-config field a
workflow app can still use — but note `page()` does not fetch the endpoint the
way `client()` does, so a page that wants `name`/`greeting` from the agent calls
`fetchClientConfig()` itself rather than receiving them.

### Three factories, and the `Client` suffix is what tells them apart

None of them is a name collision and all three are reachable from a page, which
is why they get read as one: **`createAgentClient`**
(`@alexkroman1/aai/workflow-api`) is the one to reach for — one object over
`config()` and every workflow route; **`createWorkflowApiClient`** is the narrow
SDK factory it wraps; **`createWorkflowApi`** is this package's wrapper over that
narrow one. The SDK's names carry the `Client` suffix; the bare one is ours.

### `page()` is a second mount, not a flag on `client()`

`client()` unavoidably constructs a `SessionCore`, which owns a WebSocket URL
provider, an audio graph and a microphone request. A flag would have to make all
of that conditional, and every session hook would then have to answer "what does
this mean with no session?" — so the honest split is two mounts. Authoring is
otherwise identical: still `client.tsx`, still React, still Tailwind, still the
same theme tokens. `template-page-mount.test.ts` (in aai-templates) correlates
the two, asserting every template's mount matches what its own `agent.ts`
declares — konsistent cannot express "one of two imports", and a rule that
merely accepted either would pass the mistake worth catching.

**The declaration is not decoration on the server side either.** `createRuntimeServer`
declines `/websocket` for a static agent — COMPLETED and then closed with a
protocol error naming the reason, rather than dropped, because a bare socket
drop leaves a client reconnecting against a server that will never answer — and
telephony defaults OFF, since an agent with no `stt`/`llm`/`tts` has nothing to
put on a call. It is reported in `GET /client-config` so a browser knows before
it dials, and `aai dev` and the deployed guest honour it identically: a page
mounted with `client()` by mistake fails locally, not after a deploy.

**A workflow app therefore needs NO provider credential, and two places had to
learn that separately.** An agent declaring no `stt`/`llm`/`tts` gets the
all-AssemblyAI pipeline injected (`defaultProviders`), which for a voice agent
is the whole point and for a page is a credential nothing will ever dial — so
`requiredProviderEnvVars` returns `[]` for `page: "static"` (the preflights: it
had `aai dev` reaching for the logged-in key and dying `not_logged_in`, and the
deploy preflight demanding a key the agent does not use), and `createRuntime`
DEFERS resolving those providers instead of doing it at construction (the
runtime: `resolveLlm` throws on a missing key, so a workflow app could not boot
at all — under `aai dev` it never started, and deployed it is a 500 on the
workflow API of an app whose workflows are fine, which is the case
`workflow-api.ts`'s `engine` doc names). Both templates ship exactly this shape,
so `aai init -t link-digest && aai dev` is the reproduction.

The check keys off `page` rather than the descriptors because by the time a
config reaches the deploy preflight the injection has already happened:
"declared nothing" and "declared the default" are the same object there.
Deferring rather than skipping keeps the honest error for the one path that
can still open a session on a static agent — an embedder passing
`createRuntimeServer({ telephony: true })` — which resolves at session start and
reports the missing key by name.

### The API is `ctx.workflows` spelled over HTTP, and nothing more

```text
GET    /workflows                 → { workflows: WorkflowSummary[] }
POST   /workflows/runs            → { runId }   body: { workflow, input?, key? }
GET    /workflows/runs            → { runs }    ?workflow=&key=&limit=
GET    /workflows/runs/:id        → a WorkflowRunSnapshot
DELETE /workflows/runs/:id        → { runId, cancelled }
GET    /workflows/runs/:id/events → SSE: run | done | missing | idle
GET    /workflows/runs/:id/stream → SSE: chunk | done | missing
                                    ?namespace=&startIndex=
POST   /workflows/runs/:id/wake   → { runId, woken }
```

**`events` and `stream` answer different questions, and a dashboard wants
both.** `events` reports the run's STATE — the status transitions the world
records, which every run has. `stream` reports what the run itself WROTE
through `getWritable()` (imported from `workflow`, like `sleep`), which is the
only way a long run can say anything before it finishes: a snapshot carries a
status and, once terminal, an output, and nothing in between. Chunks are
RETAINED with the run rather than live-only, so `stream` is equally a replay —
a page that reloads mid-run reads the whole thing by default, and `startIndex`
(negative counts back from the end) is for a reader resuming from a known
position. `api.streamOutput()` is the client half, resolving the raw
`Response` for the same reason `watch` does: an agent deployed before the
route existed answers 404, which is a normal path.

**`follow`/`followOutput` are the `for await` iterators over those two routes**,
and they hold the protocol's two continuation rules so that a caller does not
have to: the state stream hands the client back with an `idle` frame after its
own duration cap (a re-open, not an ending), and one output read is bounded by
the tail it saw, so the next resumes from an absolute index. A stream that ends
with the run still unsettled THROWS rather than reading as a run that finished.
`watch`/`streamOutput` stay raw for exactly the caller described above — one
writing its own 404 fallback — and there is deliberately no fallback inside the
iterators. `readEventStream` is the SSE parser under both, public on
`@alexkroman1/aai/workflow-api` so this package carries no second copy; the
private `_sse.ts` is deleted rather than duplicated, and `eventsource-parser`
moved down a layer with it.

**`wake` is what makes a long `sleep()` usable.** `POST /runs/:id/wake` ends a
run's pending sleeps and reports how many (`api.wake()`,
`ctx.workflows.wakeUp()`); `woken: 0` is an answer, not a failure — the run
finished or was never asleep, the same shape as `cancelled: false`. Without it
the only handle on a sleeping run was `cancel`, so "send it now" and "throw it
away" were one button. Both routes ride the platform's already-declared GET
and POST on the `/workflows` prefix, so neither needed a deployment change;
`research-workflow` is the worked example for each.

### Rendering progress (`useWorkflowProgress`)

`useWorkflowProgress(runId)` is the hook over `streamOutput`, and the sibling of
`useWorkflowRun`: that one reports a run's STATE, this one reports what the run
WROTE. A page with only the first shows "Working…" for the length of the run; a
page with only the second cannot tell a finished run from a quiet one. Both are
one stream, ended by the agent when there is nothing left to say.

Four properties, three of them the same ones `useWorkflowRun` documents (the
client in a REF, not an effect dependency; the lazily-built default client;
state cleared synchronously on an id change) and one that is its own — and
that one is the whole reason this route is shaped the way it is:

- **A progress read is BOUNDED, so the hook re-opens rather than holds.** A
  workflow stream signals its end only once it has been CLOSED, and a progress
  channel written by one step after another is never closed: no step knows it is
  the last. So a reader that waits for the end waits forever, *including on a
  finished run* — which is the case a page hits most. That is not hypothetical:
  `GET /runs/:id/stream` held a response open until a 120-second test timeout on
  a completed two-line run, and no unit test could see it, because a fake stream
  is a closed one. Only `dev-workflow.scenario.test.ts`, against a real
  transform and a real world, reaches it.

  The route therefore bounds each read by `streamTail()` — the last written
  index at the moment the request arrived — and its `done` frame carries
  `complete`, the RUN's own terminal state. The hook re-opens from where it
  left off until a read comes back `complete`. So progress is a durable LOG a
  reader re-reads, not a socket it holds, and each re-read asks only for what
  it has not seen.
- **`supported` is load-bearing for the render.** "This deploy predates progress
  streams" and "the run has written nothing yet" are indistinguishable from
  `progress` alone, and a page needs to hide the section in the first case and
  keep waiting in the second. A dropped read or a thrown fetch is neither — both
  are RETRIED, since a live run's log is still arriving.
- **Chunks REPLAY**, because the run retains them: a page that mounts late — a
  reload, a second tab, a link opened tomorrow — reads from index 0 and arrives
  at the same list as one that watched throughout. That is why the default
  `startIndex` is 0 and not "from now": a tail-only default would make the same
  page show different things depending on when it opened.
- **A negative `startIndex` is resolved by the READER, on its first read.** "The
  last N" names no position a later read can resume from — the tail it counts
  back from moves with every line the run writes — so carrying it into the
  re-open meant asking from 0 and dropping `seen` chunks off the FRONT, which is
  a different set entirely: a reader that opened at `-3` on a ten-line log held
  lines 7-9 and was then handed lines 3 onwards, four it never asked for
  followed by the three it already had. So the FIRST read is issued from 0 and
  trimmed to the window, and every read after it is the ordinary absolute case.
  The first read costs the whole log, which is exactly what the default already
  does.

**One React commit per READ, not per line.** `consumeFrames` drains a whole
bounded read anyway, so it returns the chunks and the hook appends them in one
update; a per-chunk callback re-rendered the page once per progress line and
rebuilt the list each time, which for a fan-out writing a line per segment is an
O(n²) copy of a log the reader can only see one frame of at a time.

The write half is the author's, and it is `getWritable()` from `workflow`
(imported directly, like `sleep`) called from a STEP and never from the body —
the body replays from the top, so a line written there is re-emitted on every
resume. Both page templates carry the same six-line `stepReport()` helper, which is
best-effort deliberately: a run must not fail because its narration could not be
written, and that is also what keeps a step callable from a spec, where there is
no run and `getWritable()` throws by design.

**`<WorkflowProgress runId>` is the rendered half**, and it holds the three
rules a page kept re-deriving: render nothing until the agent HAS a stream and
the run has written to it (`supported` is what separates those two), render the
lines as TEXT rather than as elements — they are append-only and legitimately
repeat, so there is no stable per-line key, and joining sidesteps that instead
of suppressing the lint rule that asks about it — and let them replay. Two
templates had it byte-identical, both comments included. `className` REPLACES
the default rather than extending it, so a custom chrome is not fighting a
default it did not ask for, and `placeholder` covers the pre-first-line frame.

`link-digest` deliberately keeps the raw hook: it renders the newest line only
(a compact status), which is what `latest` is for, and it is this package's
example of the primitives underneath. `transcription-workflow` and `redline`
render the whole log through the component, because their fan-out and their
rounds are where the history is worth seeing.

`ctx.workflows.start()` only covers the case where a VOICE TURN starts a run; a
page and a programmatic caller (`aai workflow`, a script, a cron job) had no
surface at all. Mounted on `createRuntimeServer`, so `aai dev`, a self-hosted server
and every deployed agent serve it identically — the same reasoning `/phone` is
mounted there rather than bolted onto the platform. On the platform the page's
calls land on `/:slug/workflows/*` and are brokered (`aai-server/
workflow-handler.ts`), because `createWorkflowApi` builds every URL from
`location` and has no broker step of the kind the voice session gets.

**The CLIENT half lives in the SDK** (`createWorkflowApiClient`,
`@alexkroman1/aai/workflow-api`), and `createWorkflowApi` here is a wrapper
that supplies one thing: the base URL, defaulted to the page's own origin +
path. That is the only part of it a browser owns — everything else (each
route, the query encoding, the bearer, the `wait` clamp, and the rule that a
404 from `GET /runs/:id` is an ANSWER rather than a failure, and the 404
`wake` reads as "nothing was sleeping") had been written three times over,
here plus `aai workflow` plus the studio's Workflows card, each a different
SUBSET, disagreeing on exactly the things a reader cannot check by eye. So: no
route logic in this package. A page that needs a knob the wrapper does not
pass through should get it from the SDK client's options, not a second `fetch`
here — and a NEW route is added to the SDK client, where `useWorkflowProgress`
and the studio's card reach it too, never here.

`WORKFLOW_API_PREFIX` moved with it, which is why the SDK declares the literal
and `aai/host/workflow-api.ts` re-exports it: the server, the `aai dev` proxy
table and now the client all resolve one string, and a browser cannot import the
`host/` half.

**Every RUN route is one `WorkflowClient` call, and the type says so**: the
API's engine IS `WorkflowClient`, not a wider "engine" with run-store reads of
its own. That width is what would let route code drift into the journal, which
belongs to the Workflow DevKit — so a route needing more than a tool can do is
the signal to add a client method, never to widen this. Hence what is
deliberately absent: no `/signals/:token` (a waitpoint is `createWebhook()`'s,
and the platform already proxies its URL), and no `/retry` (resuming a terminal
run is the WDK's business, and a route would have to invent what "again" means).

### Uploads — the one pair that is not about runs

```text
POST /workflows/uploads?name=x  → { id, …, complete: true }   body: the file
PUT  /workflows/uploads/:id     → the same, under an id the CALLER chose
GET  /workflows/uploads/:id     → the bytes, `Range` honoured
GET  /workflows/uploads/:id/info → { id, name, type, size, complete }
```

This section used to say a `/blobs` route was deliberately absent, and that
"bytes belong behind a URL or in the app's own storage". The second half was
right and the first half left a hole every workflow app falls into on its first
form: a run's input is journaled and replayed, so bytes may not travel in one —
and an app with no storage of its own could only ask for a URL, which is fine
for a recording that is already hosted and useless for a person with a file on
their laptop. `transcription-workflow` shipped exactly that, and its own
`<FileField>` described a file nothing ever read.

So the app gets a place to put them. The pair touches the STORE and never the
engine, which is what keeps the rule above meaning what it says.

**Bytes go in once and are read by window.** The body is the file itself — the
name rides in `?name=`, the type in `Content-Type`, so there is no multipart
envelope to parse and one chunk is in memory at a time. A step then reads what
it needs with `stepReadUpload(id, { start, end })` (`@alexkroman1/aai/utils`), which
is IN-PROCESS: the DevKit dispatches a step to the same server that stored the
upload, so the store is handed over through a `Symbol.for` slot exactly as the
agent env is (`publishUploadReader`, published by `createRuntimeServer`). Sixty steps
therefore move a recording once between them, and a resumed run re-reads only
its own window.

**An upload needs the database, and this is the one part of a workflow app
that does.** Runs themselves fall back to the Local World with none
(`aai/host/workflow-world.ts`), but an upload's RECORD is a row and its bytes
are objects, so a deployment missing either half gets a store that refuses by
name (`createUnavailableUploadStore`) rather than a fallback. It used to write
**files** under `.workflow-data/uploads` beside the Local World's own state,
which stored a dev upload perfectly and lost it by the time a resumed run
reached segment 27, with nothing reporting a thing — `aai/host/_upload-blobs.ts`
carries why that backend was deleted rather than fixed. Bytes are chunked
(`UPLOAD_CHUNK_BYTES`) and a range read slices at the STORE, so a 64 KB header
probe moves 64 KB. The metadata row is written LAST, so an interrupted upload
reads as "no such upload" rather than as a file that is silently short.

**The cap is 2 GiB, and `AAI_MAX_UPLOAD_BYTES` moves it.** The first number was
256 MB, sized off a two-hour 16 kHz MONO recording — which describes a file
made deliberately for transcription and not the one people have: the same call
in stereo at 44.1 kHz is ~1.2 GB. A cap that refuses the ordinary file makes the
feature look broken, and `upload exceeds 268435456 bytes` gives nobody a way to
tell a policy from a limit. It bounds storage, not memory or the wire — both
stream.

**A form takes a file with no upload code in it.** Three pieces, and each is
the SDK's:

- `workflow({ uploads: ["recording"] })` declares which input properties carry
  an upload id. Declared on the workflow rather than in the schema, because the
  schema may be any Standard Schema and a marker inside one would only work for
  the library that carried it — the property stays an ordinary `z.string()`,
  which is what the run really receives.
- `<WorkflowFields>` renders a `<FileField upload>` for those properties. It
  cannot be derived from the schema: an upload property IS a string there, and
  "type a recording id" is exactly the wrong control.
- `useWorkflowSubmit` stores every `File` in the submitted values through
  `api.uploadStream()` — under an id it MINTS — and substitutes that id before
  starting the run. That is the one place holding both the chosen file and the
  client that can store it; a `<FileField upload>` contributes the `File` UNREAD
  for the same reason (describing a 200 MB recording would mean holding it in
  memory).

  **The call is `uploadStream` rather than `upload`, and the id is the whole
  reason.** The two differ only in who mints it, and that decides whether an
  interrupted upload can be picked up again: an `upload` mints its own at the
  END, so a caller whose upload died has nothing to name what was stored and must
  send the file again. Nothing else about the submission changes — the run is
  still started after the last byte lands, so the incomplete record a streamed
  upload leaves along the way is one nobody reads.

**Storing the file is a WAIT nothing else on the page can describe, and
`<UploadProgressBar>` is what draws it.** A run does not EXIST until its input is
stored, so from submit until the last byte lands there is no run id, no status
and nothing for `<WorkflowProgress>` to read — which for a 200 MB recording is
minutes of a page showing a disabled button and no other sign of life.
`useWorkflowSubmit` therefore reports the bytes as they go
(`WorkflowSubmission.upload`) and drops the report the moment the last one lands,
so the two bars are disjoint by construction: this one covers the upload, the
progress component covers the run. Three rules are baked into the component
rather than left to each page — it renders NOTHING when there is nothing to
describe (so a form with no files never shows a bar, and the prop can be passed
unguarded), an unknown total is INDETERMINATE rather than a bar pinned at 0%, and
the file is NAMED and counted, because files are stored one after another and an
unlabelled bar appears to restart from zero partway through.

**The byte counts come from `XMLHttpRequest`, and that is not a legacy
accident.** `fetch` cannot observe a request body — the streaming request form
(`duplex: "half"`) is one engine's extension that rejects outright on the others
— so `UploadOptions.onProgress` is what makes the SDK's upload call swap
transports, and only where an `XMLHttpRequest` exists. Everywhere else (Node, a
worker without it) the call stays on `fetch` and the reports degrade to the two
ends: sending, then sent. `sdk/workflow-upload-client.ts` owns that, including
why the XHR answer is converted back into a `Response` at the boundary — one
error vocabulary and one JSON guard above both paths, rather than two ways for
this route to describe the same 413.

### A run can PRODUCE a file, and `api.download` is how a page plays it

Every upload above travels one way — a person's file, in. The store serves the
other direction too, and it is what makes a workflow app whose answer is not
text possible at all: a run's OUTPUT is read back as JSON, so a step that made
audio, an image or a PDF stores it with `stepWriteUpload` and returns the ID, and
`api.download(id)` reads the bytes back as a `Blob`.

**A `Blob` rather than a URL, and the reason is one a page cannot discover on
its own.** `GET /workflows/uploads/:id` takes the same `Authorization` header
every other route here does, and neither `<audio src>` nor `<a href>` can send
one — so a page written as `src={`/workflows/uploads/${id}`}` works against
`aai dev`, where there is no token, and 401s the moment the agent has one.
`URL.createObjectURL(blob)` is what those two elements take, and it makes
`download` on the anchor work as a bonus, the bytes already being in the tab.

**`useDownloadUrl(api, id)` owns the object-URL lifecycle, and both templates
that exist because of the audio round trip call it** — `spoken-summary` and
`call-audit` had written the same 38 lines byte-for-byte, doc paragraph
included, and this package exported no download helper at all. The two lines
worth centralizing are the two the four are wrapped in: `URL.revokeObjectURL`
on cleanup (an object URL pins its blob for the life of the DOCUMENT, so a page
that summarized five recordings holds five files it can no longer reach) and a
`cancelled` flag (a second run settling while the first download is in flight
otherwise renders the first run's audio under the second run's output). Both
failure modes are tested. Both copies also faked `pending` as "neither `url` nor
`error`", which cannot tell a download in flight from no id at all; `pending` is
its own field now, and both pages render it.

### `useWorkflowSubmit` / `useWorkflowStream` hand back `wake` and `cancel`

They held a run id and would not give it back, so a page that wanted "file it
now" or "stop" kept a module-scope `api` purely to write `api.wake(runId)` — a
page carrying the transport to make up for a hook withholding its own state.
Both return `wake()` and `cancel()` bound to the run they are following
(`_run-controls.ts`, shared, because `WorkflowStreamSubmission` is an ALIAS of
`WorkflowSubmission` and a field on one and not the other is a lie in the type).
Both ANSWER rather than fail when there is no run — `0` sleeps ended, `false`
this call did not end it — which is the SDK's own contract for them.
`reset()` and `cancel()` stay distinct: `reset()` puts the FORM back and leaves
the run running.

### `<WorkflowProgress lines={n}>` and `WORKFLOW_STATUS_LABELS`

`undefined` = the whole log, `1` = the newest line, `0` = the placeholder. The
two raw-primitive pages had each hand-rolled a newest-line version carrying the
same six-line comment about how dropping the `supported` check leaves the page
blank forever against an older agent. Narrowing the window is not a reason to
re-derive that rule, so the window is a prop on the component that already owns
it; the slice happens BEFORE the emptiness test, so a computed `lines` of zero
cannot silently invert into "everything".

`WORKFLOW_STATUS_LABELS` is the byte-identical `Record<WorkflowRun["status"],
string>` two pages carried, differing only in the `running` label — exported
with a neutral `running: "Working…"`, so a page writes
`{ ...WORKFLOW_STATUS_LABELS, running: "Writing…" }`. The exhaustiveness
argument both copies were written for moves to the SDK boundary: it is a
`Record<WorkflowRunStatus, string>`, so a status added upstream is a compile
error in one place every page inherits, and spreading a complete record cannot
drop a key. `WorkflowRunStatus` is re-exported from `workflow-client.ts` for the
same reason `WorkflowRun` is.

### Starting a run BEFORE its file has finished uploading

Everything above is the `POST` path, and it forces one order: store the whole
file, then start the run. That is not a limitation of the form layer — a `POST`
can only answer with an id once the last byte is in, because the store writes an
upload's record LAST so that "incomplete" and "no such upload" are the same
answer. For a long recording that order is most of the wall clock.

`PUT /workflows/uploads/:id` inverts it with one change: **the caller names the
upload.** So the id exists before the bytes are sent, which is all a run input
needs. The record then exists from the first byte with `complete: false` and a
`size` that grows as chunks land, and the run reads whatever has arrived —
`stepReadUpload` already clamped its window to what is stored, which is why almost
nothing else had to change.

`useWorkflowStream(workflow)` is the browser half, and it is a drop-in sibling
of `useWorkflowSubmit`: same return fields, same `<Form>`, same
`<UploadProgressBar>`, same `<WorkflowProgress>`. What it does differently is
three things a page should not have to own — it mints the id, puts it in the
input where the workflow's own `uploads` list says, and **wakes the run once the
upload lands** (a run waiting on an upload is asleep between polls, so without
that it learns the file is finished a poll interval late, every time). A failed
upload CANCELS the run, because a run left waiting for bytes that will never
come fails on its own abandonment bound minutes after the page already reported
the error.

**Nothing here knows the file is audio.** Where a recording may be divided is
the RUN's business (`planSegments` in `transcription-workflow`), and an earlier
design that had the browser cut the file into parts is gone: it needed a group
token, a part index, a seal call and a cutter callback, all of which the store
publishing `size` replaces. `transcription-workflow` offers both paths over one
form and is the worked example.

### Sending one file over SEVERAL connections

Both upload paths above are ONE request, so the file moves at one connection's
throughput — which over any distance is a fraction of the link, and for a
recording that is the wait a person is sitting through. So a file is CUT by
default: both `useWorkflowSubmit` and `useWorkflowStream` hand the SDK
megabyte-aligned parts and it sends eight at once against
`POST|PUT /workflows/uploads/:id/parts`. `parallel` is the option that tunes it
(`{ partBytes, concurrency }`) or turns it off (`false`).

Three things worth knowing at a call site:

- **It composes with the streaming flow rather than competing with it.** What the
  run polls is the store's `size`, which for a parts upload is the CONTIGUOUS
  prefix — so a run reading ahead of the uplink sees the same growing file
  whether one connection or four are filling it, and only the rate changes.
- **A failed upload is RESUMED, and the loop is the SDK's.** A round that fails
  for a reason that looks like an outage is re-entered with `resume: true`,
  filling in only the windows the store does not already have
  (`UploadInfo.ranges`), on a budget sized to outlast a redeploy —
  `aai/sdk/_upload-resume.ts` owns it and carries what "looks like an outage"
  excludes. The run is still waiting on the same id, so a resume that works is
  invisible to it. `useWorkflowStream` used to hand-roll one such retry with no
  wait in front of it, which covers a dropped connection and cannot cover the
  case that actually strands people: the agent restarting underneath the upload.
- **`parallel` splits ONE file; a form's files stay sequential.** Two recordings
  sent at once would compete for the same link with two bars to explain it, which
  is the shape `uploadFiles` was written to avoid.
- **It degrades rather than failing** — a small file, a string body, or an agent
  deployed before the `/parts` routes existed all send the single request instead
  — which is what makes it safe as the default rather than something each page
  opts into. It is also the only upload path that RETRIES a dropped part, so
  opting out costs recoverability as well as speed.
  `sdk/workflow-upload-parts.ts` owns the causes.

### A long upload can be PAUSED, and it is the same mechanism

Both hooks return `pauseUpload`/`resumeUpload`, `UploadStatus` carries `paused`,
and `<UploadProgressBar>` draws the control when handed both — never one, since
a pause with no resume is a one-way door drawn as a toggle.

**Nothing new is stored to make it work.** Pausing is an abort plus an id: the
windows already sent are in the store under an id the hook minted, so resuming
reads back which ranges landed and sends the rest. That is the SDK's outage
resume, asked for — which is why the store cannot tell the two apart and needs no
new route, and why the feature arrived with the auto-resume rather than after it.

Three things a page should know:

- **`submit()`'s promise stays unresolved across a pause**, because the
  submission genuinely has not finished — the run does not exist until the last
  byte lands, so resolving would tell a `<Form>` the work was accepted when
  nothing was started.
- **The RUN is untouched.** In the streaming flow the run is already watching the
  id, and to a run a paused upload is one whose `size` stopped growing — exactly
  what a slow uplink looks like. The workflow's own idle bound is what eventually
  calls it abandoned (five minutes in `transcription-workflow`), so a pause is
  free until then and fatal after.
- **`reset()` ABANDONS rather than pauses**, and reports no error for it: a form
  put back to its initial state has no submission to fail, and an error there
  would be the page reporting the person's own button back to them.

`_upload-session.ts` is the gate both hooks share. Its one subtle rule is that the
uploader keys off the ABORT rather than off `gate.paused`: a pause and an
immediate resume — a double-click — reopens the gate before the rejection the
abort caused has landed, so a `paused` check would read false and rethrow an
`AbortError` as though the upload had failed.

`transcription-workflow` renders it as a checkbox beside the mode radios,
deliberately: it describes the UPLOAD, and all three of its flows have one.

**Measured, on a 10-minute 48 kHz stereo recording (115 MB, 7 segments) at 2
MB/s:** six of seven segments were transcribed before the upload finished, the
first at 24% of the file. The saving over the classic path is ~2s of 59s —
bounded by one segment's latency, because the last segment cannot start until
its bytes land — so what this really buys is that a page shows real progress
while the bytes are moving, not a proportional speedup. `workflows/stream.ts` in
that template carries the whole table.

A file input is also the one control whose BUTTON the browser draws, and left
to the user agent it inherits the field's colours — which can come out as
invisible text on the surface it sits on. `<FileField>` therefore styles
`::file-selector-button` explicitly in the theme's colours, passed to the
pseudo-element as CSS custom properties (a Tailwind class cannot read a
JavaScript theme object, and a React `style` prop cannot reach a
pseudo-element).

On the platform the pair is proxied like the rest of `/:slug/workflows/*` —
which took two header-allowlist entries, `Range` in and `Content-Range` /
`Accept-Ranges` back, without which a caller asking for 64 KB of a 200 MB
recording is answered with the whole thing, correctly and uselessly.

### A RELOAD picks the upload back up too

Pausing works because a streamed upload's id outlives the attempt that began it.
A reload is the same interruption with one difference: it takes the id with it.
Everything else was already in place — the windows were still stored, the agent
could still name them (`UploadInfo.ranges`), and the id was minted in the browser
— so a person who refreshed at 90% of a 200 MB recording sent the whole file
again, which is the interruption they are most likely to cause on purpose.

`_upload-recall.ts` writes the id down. It is `sessionStorage`, the same call
`session-resume-store.ts` makes for a session id and for a stronger reason here:
a reload and a same-tab navigation are what this is for, and an id from yesterday
names an upload the agent's sweep has very likely collected. It is what
tus-js-client's `urlStorage` and Uppy's Golden Retriever sell, at about a hundred
lines and no dependency.

Two things about it are load-bearing.

**The key is a FINGERPRINT, and the AGENT is what decides.** A picked file
carries no path and no handle, so the entry is keyed on what tus-js-client
fingerprints: size, last-modified, type and name. Two different files can agree
on all four — so a recalled id is a CANDIDATE, and `claimId` in
`_upload-files.ts` reads `uploadInfo` before a byte is sent to it. Three answers:
complete means the transfer is skipped outright and the run starts on the id
(the refresh that costs one `GET` instead of a second upload); unfinished WITH
windows is resumed, and the first attempt must pass `resume` because the id was
claimed by a load that is gone; anything else — a 404, a failure, or an
unfinished upload reporting NO windows — takes a fresh id. That last case is the
one worth stating: no windows means a partial single `PUT`, which the store
answers a second `PUT` to with a **409** rather than an append, so reusing that
id would turn a reload into a failure the person cannot clear.

**The id is written before the first byte leaves**, not when the last one lands,
because the reload this exists for happens in between.

It follows that re-submitting a file already stored in this tab reuses that
upload instead of sending it again — the same mechanism seen from the other side,
and correct, since an upload is content rather than part of a run. A spec that
wants a second transfer needs a second file, which is why both submit suites
clear `sessionStorage` between specs — the hook half of this lives in
`use-workflow-form-recall.test.ts`, the store's own in `_upload-recall.test.ts`.

`useWorkflowStream` deliberately does NOT recall: its id goes into a run input,
so reusing one across a reload would start a second run against the first run's
upload. Its pause and its outage resume are unchanged.

### And the RUN is picked back up too, by default

The other half of that reload. `useWorkflowSubmit` mints an opaque per-page
correlation key into `sessionStorage` (`use-run-key.ts`), records every run
under it, and asks `find(workflow, key)` once as it mounts — so a refresh comes
back to the same result, progress log and controls rather than an empty form
beside a live run nothing can name. It was `key` + `recover: true` at the call
site, and six of six page templates wrote both: the same "default in the wrong
place" `session-resume-store.ts` names on the voice side, which is why the two
now make the same promise with nothing written.

`key` still overrides — an ACCOUNT's id, so a run follows the person to another
device; `useRunKey({ storage: "local" })` for a run that outlives the tab, which
is `podcast-digest` and the only template that still names the hook. `recover:
false` opts the LOOKUP out and keeps the key. `useWorkflowStream` has neither,
for the reason above: its key would be read back by nobody.

### The run a page just started, and the ones before it

`useWorkflowRun` watches ONE run by id, which is right for the run a form just
started and useless for everything before it — a reload drops the id.
`useWorkflowRuns(workflow, { limit, key })` is the other half, over
`GET /workflows/runs`: history a page can render.

It reads once and hands back `refresh` rather than polling. The run a page
cares about right now is already being watched; a second loop over the whole
history would broker N requests a minute to re-learn what the first one knows.
A page calls `refresh` when its own run settles, which is exactly when the
list is stale. `transcription-workflow` is the worked example, and it replaced
a text box asking the reader to paste a run id they would have had to write
down.

**Every read carries a `createEpoch()` generation, and the READ bumps it — not
only the unmount.** With the cleanup as the sole bumper, two `refresh()` calls
captured the same generation, so whichever settled last won: a slow earlier read
overwrote a newer one's answer with a staler list, which for the
"my run finished, re-read the history" call is routinely the wrong way round.
Reach for the primitive rather than a `useRef(0)` counter — see "Concurrency
primitives" in the root guide.

### `stepReport()` writes to the page AND the server log

`stepReport(line)` (`@alexkroman1/aai/utils`) is what a step says about itself. It
replaced the twelve-line `getWritable()` helper each of the three workflow
templates had copied — this guide's own note said extracting it was not worth
minting a subpath for, which was true of the helper and false of the FEATURE:
a workflow app answered requests and then did minutes of work with nothing in
the server log naming any of it, so "is it stuck, or is segment 41 of 60 slow?"
was unanswerable without a browser open.

One call reaches both readers. The stream half is unchanged (`getWritable()`,
read back by `useWorkflowProgress`); the log half is a `logger.info` line on the
same server. `host/workflow-report.ts` is the published half and
`createRuntimeServer` publishes it, so the two mechanisms have one wiring point — the
same slot trick uploads use, and for the same reason (`/utils` is on the CLI's
zero-dependency startup path and may not import the DevKit).

**The ATTEMPT is part of the line, not just the log.** `getStepMetadata()` names
the step and its attempt, and past the first the reporter appends
`(attempt N)` — without it a fan-out that is retrying prints the same sentence
as one that is succeeding, sixty times, and a reader cannot tell a slow run from
a wedged one.

### `stepEmit()` is the other channel, and it makes a run's ANSWER streamable

`stepReport()` writes a sentence for a person. **`stepEmit(namespace, chunk)`** writes a
VALUE for a program, into a stream named by the caller — which is what lets a long
fan-out hand over each result as it lands. Without it a run's partial results have
nowhere to go: a snapshot carries a status and, once terminal, an output, so a
sixty-segment transcription that has finished forty of them has forty answers and
no way to show any of them.

The READ half already existed and needed nothing: `streamOutput({ namespace })`
and `useWorkflowProgress<T>(runId, { namespace })` have taken one since they were
written. What was missing was the write.

**The namespace is REQUIRED, and that is the point of the argument.** The default
stream is `stepReport()`'s, and a page renders those chunks verbatim — an object in
there is `[object Object]` in the middle of the progress log. A named stream is
also what lets `useWorkflowProgress<T>` be typed at all, since a subscription
then carries one shape.

Everything else is `stepReport()`'s rule: call it from a STEP (a body replays), it is
best-effort, and the chunks are RETAINED with the run so a reader that arrives
late gets the whole stream. It is NOT logged — a structured chunk per item would
bury the narration beside it — which is the one place the two paths differ inside
`host/workflow-report.ts`.

`transcription-workflow` is the worked example on both ends: each segment is
emitted as it lands, and the page stitches whatever has arrived with the RUN's own
seam function, so the live transcript and the stored one cannot become two
different transcripts of one recording. `stubReporter()`
(`@alexkroman1/aai/testing`) is how a spec asserts either half.

Two more things a step should reach for rather than hand-roll, both on
`/utils`: `isTransientStatus(status)` (the 408/429/5xx split every template had
its own copy of) and `retryAfter(response)`, which is what carries a rate
limit's own `Retry-After` into `RetryableError` — the difference between
draining a provider's 429s and re-collecting them four at a time on a backoff
the server did not choose.

**The surface is as public as `/websocket` beside it.** A page carries no
credential — it is served to anyone with the URL, exactly like the voice
client — so requiring one by default would mean no static page could ever
work. What is genuinely worse here is the COST SHAPE: a run outlives the
request that started it, so a loop of cheap POSTs queues far more work than a
loop of voice sessions. An operator who wants it closed sets
`AAI_WORKFLOW_API_TOKEN` in the agent env and every route requires it as a
bearer; the platform forwards the header, and `aai workflow --token` and the
studio's runs card present it. Fail-OPEN when unset is the documented default,
and the platform's per-IP limits (`WORKFLOW_IP_RATE_LIMIT`, and a much tighter
one on `POST /runs`) are what bound the cost in the meantime.

### Two vocabularies use the word "name", and mixing them is silent

A WDK run record's `workflowName` is the COMPILER's identifier —
`workflow//./workflows/digest//digestFlow`, the same string as `workflowId`,
which the DevKit's own docs call machine-readable and hand to
`parseWorkflowName()` before showing anyone. Ours is the key in
`agent({ workflows })`, which is what `WorkflowRunBase.workflow` promises.
`workflow-client.ts` translates in both directions, and both were once missing:
the keyless read (`GET /workflows/runs` with no `key`, i.e. `ctx.workflows
.recent`) filtered by the DECLARED name, which matches no stored run, so it
answered `[]` for every workflow and `aai workflow runs <name>` printed "No runs
of X yet" for every agent — while every snapshot reported the machine id as its
`workflow`, which `research-workflow`'s status tool reads down the phone. `find`
was
unaffected: it goes through our own key index, which is keyed by declared name.

Neither could be caught by a stub, which is the reusable part: a fake adapter
answers with whatever name the test wrote, so `workflow-client.test.ts`'s fake
now stores runs under the compiler id and filters by it.

### Watching a run

`useWorkflowRun(runId)` tries the event stream first and falls back to polling.
The poll is the honest DEFAULT — a run outlives the page, so re-reading the id
is the simplest correct implementation — and the stream is an optimisation over
it, because on the platform every polled read BROKERS: N open tabs at
`DEFAULT_WORKFLOW_POLL_MS` (2 s) is N/2 brokered requests a second, each able to
boot a sandbox. So every way the stream can fail — an older agent with no
`/events` route, a proxy that buffers, a dropped connection — degrades to the
thing that works, and `watchRunEvents` calls back exactly once when it does.

`EventSource` is not used, for two reasons that both bite: it cannot send an
`Authorization` header (an agent with a token would be unreachable) and it
reconnects on its own schedule, which would fight the caller's.

Four properties are load-bearing and each covers a bug that is silent:

- **The client is held in a REF, not named as an effect dependency.** The
  natural spelling passes a new object every render; as a dependency that is an
  unbounded request loop against the agent, with `error` wiped before anything
  can read it — presenting as "the page polls forever" rather than as a mistake
  at the call site. Hoist the client out of the component anyway. All five
  workflow hooks get this from **`useWorkflowApiRef(api)`** — the ref, the
  lazily-built default behind it, and one copy of the argument, which had been
  written out five times with four copies of the same paragraph. It returns a
  STABLE getter read per request, so a caller swapping clients mid-watch (a
  token arriving after login) is picked up without the watch restarting.
- **A 404 is a STABLE answer**, so the poll gives up after `MAX_MISSING_READS`.
  Unbounded, a stale id (restored from `localStorage`, or belonging to an agent
  redeployed onto a fresh database) polls — and BROKERS — for as long as the tab
  is open.
- **`polling` cannot be derived from the snapshot alone.** Giving up on a
  missing id leaves `run` undefined, which reads as "still waiting", so the
  hook tracks the stop explicitly. **A caller must READ it rather than re-derive
  its own**: `useWorkflowSubmit` computed `pending` as
  `runId !== undefined && !isTerminal(run)`, dropped the stop, and so left the
  submit button disabled and reading "Working…" for the life of the page once
  the watch gave up — with the correct error rendered directly above it. It is
  `starting || tracked.polling` now, and this bullet is why that term exists.
- **Every stream ending is NAMED** — `done` (terminal), `missing` (will never
  exist), `idle` (the stream hit its own duration cap, because a run can sleep
  for hours and a connection held that long is one nothing is maintaining). A
  client can tell "finished" from "dropped" without guessing, and only `idle`
  hands back to the poll.

`WorkflowOutputOf<typeof myWorkflow>` is what makes `run.status === "completed"`
narrow to a TYPED `run.output`: a type-only import of `agent.ts` is erased, so
naming the agent's own type pulls no server graph into the browser bundle.
`link-digest` in `packages/aai-templates/templates/` is the worked example.

### One request in, one result out (`wait`)

Both read paths take a wait budget — `POST /workflows/runs` from the body,
`GET /workflows/runs/:id` from `?wait=` — and answer when the run reaches a
terminal status or when the budget expires, whichever is first. The loop is
`aai/host/workflow-api-wait.ts`; on the client it is `api.startAndWait(workflow,
input, { wait })` and `api.get(runId, { wait })`.

The asynchronous shape stays the DEFAULT, because it is the honest one: a run is
durable and deliberately unfinished when the request returns, and a page has
`useWorkflowRun` to watch with. What had no surface at all is everything else
that talks to an agent — a shell script, a cron job, another service, a form
whose only job is to show an answer — each of which otherwise writes the same
poll loop against `GET /runs/:id`. So `wait` is additive and nothing changes
without it: a bare `POST` still answers `{ runId }` at 202, and with a wait it
adds `run` beside the same `runId`.

Four properties, each covering something that is silent when it goes wrong:

- **Giving up is an ANSWER.** An expired budget answers the RUNNING snapshot at
  202 — never an error, never a cancel. The run is real and the caller holds its
  id, so a 5xx would throw away the one thing they cannot rebuild. That is what
  makes the cap safe to ENFORCE rather than a trap: `clampWorkflowWait`
  (`aai/sdk/workflow-run.ts`, `MAX_WORKFLOW_WAIT_MS` = 60 s) is applied at both
  ends, so a client cannot ask an agent to hold a socket longer than the agent
  will, and asking degrades to the behaviour that was already there.
- **The loop watches the RESPONSE, not the request** (`CallerLink`). An
  `IncomingMessage` is `destroyed` as soon as its body has been read — already
  true on a `POST` by the time the wait starts — so a loop watching the request
  reads "the caller gave up" on its first pass and answers 202 immediately. The
  status is legal and the run really is still going, so nothing about that
  failure is visible.
- **An unknown id answers at once**, after one read. A 404 is a stable answer,
  and spending a 60 s budget on one is how a stale id from a previous deploy
  holds a request open for a minute.
- **It polls, and that is the cheap kind.** The loop runs INSIDE the guest, next
  to the world the run lives in, for the life of one request the caller is
  already holding open — no HTTP hop and no brokering per read, which is what
  makes the SSE stream's interval expensive by comparison. Hence
  `WORKFLOW_WAIT_POLL_MS` (250) being quicker than `RUN_EVENT_POLL_MS`: a
  synchronous call's whole value is that a fast run answers fast.

`useWorkflowSubmit(workflow, { wait })` opts a form in, and still follows the
returned id with `useWorkflowRun` afterwards — the budget bounds the request,
not the run.

### Forms (`components/form.tsx`)

A workflow app's front door is a form, and nothing in this package knew how to
render one — every component here is about a live session (a transcript, a mic
button, a tool-call row) — so each such page hand-rolled labels, inputs, a
submit button and the value collection between them, differently each time.
`<Form>` plus `Field` / `TextField` / `NumberField` / `TextAreaField` /
`SelectField` / `CheckboxField` / `FileField` / `SubmitButton` is that, once.

**Values come off the DOM, not out of React state.** `<Form>` reads its own
`<form>` element on submit and builds one plain object from the named
controls, which is what makes a field here nothing more than a styled
`<input>` — no registration, no controlled-component ceremony, and a bare
`<input name="x">` a caller writes themselves works identically. It also makes
the values TYPED, which `new FormData(form)` cannot: a number field yields a
number, a checkbox a boolean, an empty optional field nothing at all. That is
load-bearing rather than tidy, because these values go straight into a
workflow's input where a zod schema is waiting — `"3"` against `z.number()` is
a rejected run, and the browser is the only place that still knows the control
was `type="number"`.

**What a control contributes is decided per ELEMENT KIND, so every branch owes
the same two checks.** `collectValues` had them on `<input>` alone: a `<select>`
contributed `element.value`, which is the FIRST selected option and nothing more
— so `<SelectField multiple>` (which type-checks, since the props extend
`SelectHTMLAttributes`) handed a list-shaped schema one string — and a disabled
`<SelectField>` or `<TextAreaField>` contributed a value where a disabled
`<TextField>` did not, one form answering the same question two ways. A
multi-select reads `selectedOptions` and contributes `[]` when nothing is
chosen, which is the honest answer for a control that is present and empty as
against one left blank (the number field's omission rule).

**A `<FileField>` describes a file; by default it does not upload one.** It
contributes `{ name, size, type, lastModified }`, and `read="text"` /
`read="dataUrl"` adds `content` for the cases where the bytes really are
small. A workflow's input is serialized into the run record and replayed from
it on every resume, so bytes in there are re-read for the life of the run and
capped by the request-body limit besides; a URL or the app's own storage is
where they belong, fetched inside a `"use step"` function that runs once per
execution.

That is also why **no template exercises it**, and the allowlist records that:
`transcription-workflow` used to open on one, and a form field describing a file
nothing ever read is a worse example than none — it now takes the recording's
URL, which is what the paragraph above says to do.

**`<WorkflowFields>` is ALL-OR-NOTHING per workflow, and that is what to weigh
before converting a hand-written form.** It renders one control per scalar, all
of them, from the JSON Schema — the whole value and the whole constraint. There
is no `exclude`/`only` prop, and `SchemaField` reads only `type`, `enum`,
`description` and `default`, so `podcast-digest`'s conversion cost three things:
its `<textarea rows={3}>` for the comma-separated feed list became a one-line
`<TextField>`, the `min`/`max` on three number inputs stopped reaching the DOM
(the schema still refuses at `start()`), and a param that used to render only
when the webhook URL contained `/triggers/` — so nobody was asked about a Slack
concept they would never meet — is now always rendered. Harmless there, but the
deliberate hiding is gone. **A page that needs a field CONDITIONALLY has to
write that field itself, and `<WorkflowFields>` will render it a second time**:
the mixed shape `redline` uses works only because its hand-written field is one
`<WorkflowFields>` SKIPS (an array).

**`<WorkflowFields workflow="transcribe">` renders the schema half.** It takes
either the workflow's NAME — fetching the listing itself, which is the form a
page normally wants because the alternative is three lines (`useWorkflows()`,
a `.find()` by name, and folding that lookup's error into the form's) whose
only product is this component's argument — or a `WorkflowSummary` the caller
already holds, which fetches nothing (`useWorkflows({ skip: true })`, since
the hook cannot be conditional). It reads the summary that `GET /workflows`
serves and emits one control per SCALAR property — string, number, integer,
boolean, and an enum as a `<SelectField>` — honouring `required`, `default`,
and `description` as the hint, with the label humanized from the property name
(`recordingId` → `Recording id`). It SKIPS objects and arrays deliberately:
there is no honest control for either, and rendering an approximation would be
worse than leaving the field to the caller, who writes it by hand in the same
`<Form>` because every field is a plain named control. So a form is as
declared as its schema allows — all of it when the input is scalars all the
way down, as `transcription-workflow`'s is — and adding a scalar to the
workflow's input schema adds a control with no client edit.

`useWorkflows()` fetches that list (the client held in a ref, read once — same
rule as `useWorkflowRun`) for a page rendering its own chrome from it; no
template exercises it any more, and the allowlist records that.
`useWorkflowSubmit(workflow, options?)` is
`api.start` plus `useWorkflowRun` plus the four pieces of state between them.
Two things it decides that a call site keeps getting wrong: `pending` covers the
RUN, not the POST — a button that re-enabled on the response invites a second
submission of work already in flight — and the previous run id is dropped BEFORE
the next request rather than when it returns, since a finished result sitting
under a form that is already submitting again is the one wrong answer this can
give, and it looks like a correct one.

`transcription-workflow` in `packages/aai-templates/templates/` is the worked
example; `link-digest` is the smaller one and shows the primitives raw
(`createWorkflowApi`, `useWorkflowRun`, a hand-written `<form>`), which is worth
keeping as the thing these hooks compress.

## Surviving a platform restart (`client-config.ts`)

**Every request the session makes needs a deadline of its own, because a
hang is not a failure.** A request issued while the platform is restarting or
saturated can hang rather than fail — the proxy holds the socket open — and a
browser fetch has no timeout of its own, so the promise simply never settles.
Every *failure* path in `loadClientConfig` was already handled (`null`, then
the same-origin fallback); a hang reached none of them.

That is unrecoverable rather than merely slow, and the reason is the call
site: the lookup runs inside the session's WebSocket **URL provider**
(`currentWsUrl`, re-evaluated per attempt so reconnects land on the
replacement sandbox). partysocket awaits that provider under `_connectLock`
and arms its own `connectionTimeout` only AFTER the URL resolves — so a hung
lookup means no socket is ever constructed, no `error`/`close` ever fires,
and none of the 10 reconnect attempts ever happen. Measured with a hung
`client-config`: **zero sockets opened**, session pinned on "connecting"
forever, staying there long after the server came back. Nothing downstream
can time it out, and the state it wedges in is the one that looks healthy.

So `CLIENT_CONFIG_ATTEMPT_TIMEOUT_MS` (10s — the same figure the studio's
gating reads use for the identical hazard) makes a timed-out attempt degrade
exactly like every other failed one: `null`, so `serverIsBroker` stays
unlatched (see `loadClientConfig`'s doc for why latching on a failure is its
own bug) and the attempt falls through to the same-origin `websocket` path,
whose failure re-enters the normal backoff and re-fetches on the next
attempt. `fetchClientConfig` inherits it, which also keeps a hung lookup off
the default client's pre-connection name/greeting render.

## A FATAL error must survive the frames that follow it

**A live socket is not a live session, and every fatal path EMITS on its way
down.** `SessionCore` had two independent rules that both read a later frame
as evidence the failure had been survived: `clearRecoveredError` recovered an
errored session to `listening` on any non-error event, and `reply_done` /
`cancelled` / `reset` each wrote `state: "listening"` unconditionally. The
host's fatal paths all call `terminate()`, and terminating calls
`onCancelled()` — so the frame ANNOUNCING the session's death was also the
frame that wiped the message explaining it, a few hundred milliseconds after
it appeared, leaving a session that looked live and was deaf.

The error that costs most is the one that names the fix: a missing provider
key surfaces as `Cartesia TTS: missing API key. Set CARTESIA_API_KEY in the
agent env.` (`requireApiKey`, `aai/host/providers/_utils.ts`) — reported by
`onProviderError`, which is fatal precisely because it terminates.

So the fatal branch of `handleErrorEvent` latches, every recovery path is
declined while the latch holds, and **exactly one thing clears it: the next
`config` frame.** That is a completed handshake, i.e. a live session — the
one frame a dying session cannot produce, and per CONNECTION rather than per
session, so partysocket's automatic retries reaching a healthy peer are not
pinned to the dead one's banner. A NON-fatal error (`fatal: false`) is
untouched by all of this: the server said the session survived, so later
activity still retires its banner, which is the case the recovery was
written for.

### The latch is a REGION, not a boolean, and that is what closed the last hole

`state` and `error` were two snapshot fields written independently from
thirteen sites across `session-core.ts`, `session-core-messages.ts` and
`session-core-audio-setup.ts`, each deciding for itself whether its write was
legal by reading the snapshot back first — `if (snap.state === "error" || …)`
in `playAudioChunk`, `if (conn.fatalError) return` in `clearRecoveredError`,
`conn.fatalError ? extra : {…}` in `toListening`. That is a rule enforced by
every author remembering it, and **one of them did not**:
`handleUserTranscriptEvent` wrote `state: "thinking"` unconditionally, so a
`user-transcript.committed` arriving behind a fatal error painted a working
state over the banner this whole section exists to protect.

`session-core-state.ts` is the statechart that replaced them. The seven
`AgentState` names are one region and the fatal latch is a SECOND one —
`stateIn({ fatal: "yes" })` rather than a substate of `error`, because the
latch outlives that phase: between the error and the `config` frame the phase
runs `error → connecting → ready` while the latch stays set. A caller now
sends what HAPPENED (`LISTEN`, `ACTIVITY`, `SPEAK`, `THINK`) and folds the
returned projection into its one `updateState` call; whether the transition
was legal is answered once, in the machine.

Two things it turned up that the boolean version could not. **XState falls
through to an ancestor's handler when a child's guard fails** — so a
root-level `ACTIVITY` that cleared the banner ran after `error`'s own
fatal-guarded recovery declined, and `fuzz-session-core.test.ts` shrank it to
four ops reported as "error state carries no error". Both handlers carry the
guard now. And **a declined transition returns the position unchanged**,
which made `updateState` publish a snapshot that differed in nothing: the two
call sites that used to guard that by hand ("clear an error already null",
"announce speaking while already speaking") were the two the churn specs in
`session-core-events.test.ts` pin, so the check moved into `updateState`,
where it covers the other thirty callers too.

**And the banner is ANNOUNCED.** `ConsoleShell` renders it with `role="alert"`,
the same way `Form` renders a submit failure, because the latch above makes this
the ONLY remaining signal: the state eyebrow beside it goes back to reading like
a live session, so a plain `<div>` appearing mid-page told a screen-reader user
nothing at all about a call that had ended.

## A handshake is not a session (`session-core-handshake.ts`)

**An open socket proves the peer answered `101`, nothing more.** The server
builds the session synchronously from its own upgrade callback and sends
`config` at zero RTT, so a socket that has been open for seconds carrying
nothing is not slow — its peer is not a healthy agent server. A tunnel or
proxy answering the `101` while the guest behind it is wedged looks exactly
like this, as does a host that dies between accepting and building the
session.

Nothing else catches it. partysocket's `connectionTimeout` covers only the
handshake and is cleared the instant `open` fires. So the session went to
`state: "ready"` — which `console-shell.tsx` paints with the SAME live
indicator as "listening" — and **stayed there permanently**: no `config`
means `initAudioCapture` never runs, so there is no mic, no error, no retry,
and nothing on screen to say so. Driven against a server that accepts and
then says nothing: `ready` at 34ms, still `ready` and errorless when the
probe gave up. A dead session that looks connected is worse than a visibly
failed one.

`createHandshakeGuard` arms a deadline on every `open` (re-armed per attempt,
since `open` fires again on each partysocket retry) and disarms it on the
`config` frame or the close. On expiry it re-dials — the sandbox behind the
endpoint may have been replaced, and the URL provider re-brokers — and after
`MAX_HANDSHAKE_TIMEOUTS` it surfaces a real `connection` error. Three things
make it correct rather than merely present:

- **The budget is its own.** `forceReconnect` calls partysocket's
  `reconnect()`, which resets `_retryCount` to -1 — so `RECONNECT_OPTIONS.
  maxRetries` cannot bound this failure mode, and without a separate cap a
  wedged peer would be re-dialed every ~10s forever.
- **The budget is CONSECUTIVE, which takes a second method to say.** One guard
  covers a whole `connect()` — partysocket's retries live under it — so a plain
  `disarm()` on the `config` frame left the count standing across every
  successful session in between, making it per-CONNECTION: an hour-long call
  whose socket dropped three times, each drop timing out once before the next
  attempt answered, ended on the permanent "did not complete the session
  handshake" error against a peer that had answered every time. `succeeded()` is
  the completed handshake and resets it; `disarm()` is a socket closing and must
  NOT, because a wedged peer closes and reopens on its own and resetting there
  is the unbounded re-dial this budget exists to bound.
- **The timer is a bare `setTimeout`, so it does NOT come off with the
  connection's `AbortSignal`** the way the socket listeners do. It has to
  disarm on `abort` explicitly, or an explicit disconnect leaves it armed and
  it re-dials a session the user already closed — caught by the existing
  "user disconnect does not reconnect" spec.

## Fuzz harnesses

`packages/aai-ui/src/fuzz-*.test.ts` drive the browser session's four
concurrency-bearing layers with generated operation sequences and assert
INVARIANTS rather than scenarios — `fuzz-session-core` (server frames ×
client control calls × socket lifecycle: snapshot monotonicity, caps, and
quiescence after teardown), `fuzz-voiceio` (enqueue/done/flush/close ×
worklet stops: every `done()` settles, and only for its own turn),
`fuzz-hooks` (commit batches: exactly-once tool-call/event delivery through
the watermark cursor), `fuzz-reconnect` (partysocket + a fuzzed
`client-config`: the broker latch, resume ids, history replay). The
worklet processors have their own equivalent in
`worklets/audio-stress.test.ts`.

Two properties they need to keep paying off, beyond what fast-check gives
every harness (see "Property tests run on fast-check" in the root
`CLAUDE.md`). A harness must be
checked for **sensitivity** — revert the fix and confirm it fails — because
the common outcome is a harness that models the system too politely to reach
the bug: `fuzz-voiceio` silently exercised a DEAD worklet node for many
iterations (the audio mocks accumulate nodes across a test, so
`findWorkletNode` returned the first-ever one) and passed with the bug
present. And the model has to stay **faithful to the protocol** — one
`config` frame per connection, a drain-stop only after a `done`, timers
advanced 1ms per op so a lagged message can cross later operations — or the
"violations" it reports are its own.

## Tuning playback against a REAL reply, not a generated one

`worklets/playback-tuning.test.ts` is where `PLAYBACK_JITTER_MS` and
`PLAYBACK_REFILL_MS` are answered with numbers. It exists because every other
test of the playback worklet supplies its own arrival timing — and
`audio-stress.test.ts` says so in its own header: its chunk sizes outrun the
render loop by an order of magnitude, so "the buffer effectively never starves".
Both are the right tests for what they check, and neither can price a jitter
buffer.

`fixtures/tts-reply-24k.{json,pcm}` is 8 seconds of one real AssemblyAI reply —
the PCM16 bytes plus the millisecond each frame ARRIVED. The `.pcm` is a sidecar
rather than base64 in the JSON so it stays `ffplay`-able and reviewable by its
length; `pcm` is in `KNOWN_BINARY` in `scripts/_ratchet.mjs` for that reason.
Three harnesses sit behind it, all excluded from coverage by the
`_*-harness.ts` glob:

| Harness | Job |
| --- | --- |
| `_tts-trace-harness.ts` | capture (`captureTtsTrace`, needs a live key, takes an INJECTED opener because `resolveTts` is on no published subpath) and replay (`readTtsTraceSync`, keyless and offline) |
| `_playback-bench-harness.ts` | provider frames -> pacer model -> network profile -> the real worklet, on a virtual sample clock. ~3 ms per 17-second render, so a sweep of hundreds of settings is instant and byte-identical every run |
| `_playback-bench-page.ts` | the same thing in a real browser: a real `AudioContext` at the trace's rate, the real worklet, audible output, sliders, and a tap node that captures exactly what reached the destination |

**The browser half is not decoration — it is what makes the offline sweep
believable.** Cross-checked over four link profiles x three settings, concealed
milliseconds agreed within 1-9% and episode counts agreed exactly on eleven of
twelve cells. Where they disagree, the browser is right.

**One fidelity gap, stated because it cannot be closed from here:** the server's
pacer is MODELLED (`pacedSends`). `createAudioPacer` is not on a published
subpath and this package may not import a sibling's internals, so a change to
the real pacer will not fail this file. Re-read it against `pacedSends` if the
pacer moves; exporting the real one and deleting the model is the fix.

### What the measurements say

Recorded against the trace above, the shipped pacing (`CLIENT_AUDIO_LEAD_MS`
1000, `PACER_BURST_MS` 200) and a typical link:

- **TTS synthesizes ~20x faster than it plays** — 4.2 s of speech in 208 ms,
  32.7 s in 1434 ms, first frame at 52-92 ms. So the provider contributes no
  jitter at all, and the arrival pattern the client sees is manufactured
  entirely by the server's pacer.
- **The client's buffer holds ~870 ms mid-reply** (a sawtooth 827-923 ms), never
  anything near the 400 ms fill target. The operative cushion is
  `CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS`. - **Stall resilience is ~867 ms and
  is FLAT in `PLAYBACK_JITTER_MS`** — 859 ms at 100, 906 ms at 800. It tracks
  the pacer's lead almost one-for-one instead (lead 400 -> 250 ms absorbed,
  1000 -> 875 ms, 2000 -> 1844 ms).
- **The whole legal range of `PLAYBACK_JITTER_MS` costs 37 ms of startup**
  (149 ms at 100, 187 ms at 800), because the audio to fill it with has already
  arrived. Its doc's trade — startup for resilience — is real in the abstract
  and worth tens of milliseconds on both sides at these values.
- **The one profile where the fill target earns its keep is a link under the PCM
  bitrate** (350 kbps against the 384 kbps 24 kHz PCM16 needs), and there it
  points the other way: deeper is strictly better, 4 concealment episodes at 100
  against 0 at 800.
- **`PLAYBACK_REFILL_MS` is inert on a stall** (identical output from 50 to 600)
  and decides stutter-versus-pause only under sustained starvation, which is
  exactly the failure the re-arm was added for: at 25 ms the reply degrades into
  hundreds of fragments, at 200 ms into a handful of audible pauses.
- **`PACER_BURST_MS` is spent out of the CLIENT's resilience one-for-one** —
  ~100 ms more absorbed stall at 50 than at 200 — a trade neither constant's doc
  prices, since the burst exists to save timer wakeups on the server.

### `PLAYBACK_JITTER_MS` is redundant BY CONSTRUCTION

The strongest result, and it is structural rather than a property of this trace:
**`{jitterMs: 0, refillMs: R}` renders byte-identically to `{jitterMs: R,
refillMs: R}`** — same startup, same concealed samples, same episode count, on a
healthy link, a 900 ms-jitter link and a starved one alike.

On a turn's FIRST render the ring is empty, so `avail` (0) is under one quantum
and the underrun branch fires before any audio exists — setting `fillTarget =
refillSamples`. Every turn therefore waits for the REFILL target regardless of
what the jitter target said, and `PLAYBACK_JITTER_MS` can only act by being
LARGER. Its entire effect is to make a turn's first wait longer than every later
recovery's, which is the opposite of the argument the refill step rests on (mid
-reply a long wait is itself a hole in the speech).

Collapsing to one target at today's `PLAYBACK_REFILL_MS` (200) is strictly
better than the shipped pair on every link that can carry the bitrate —
startup drops 16 ms on a typical link, 54 ms on mobile, 118 ms at 400 ms of
jitter and 208 ms at 900 ms, with concealment unchanged at zero — and behaves
the same under starvation. Collapsing BELOW 200 is what must not happen: at 50
ms the reply degrades into 99 fragments, which is the stutter the re-arm
exists to prevent.

### The pacer is a cost to playback, not a contributor

Measured across leads including no pacing at all, **startup is 155 ms at every
one of them** — the fill target is met by the first frames either way. Everything
the pacer does to the audio is subtraction:

| lead / burst | absorbs a freeze of | peak in flight | ear behind forwarded |
| --- | --- | --- | --- |
| 1000 / 200 (shipped) | 820 ms | 46 KiB | 848 ms |
| 1000 / 100 | 914 ms | 46 KiB | 955 ms |
| 1500 / 100 | 1453 ms | 68 KiB | 1456 ms |
| 2000 / 100 | 1945 ms | 93 KiB | 1947 ms |
| unpaced | the whole reply | 354 KiB | 4149 ms |

So the pacer earns its keep on backpressure (`MAX_CLIENT_WS_BUFFERED_BYTES` is
4 MiB, so even unpaced this reply is nowhere near it — the guard is for a genuinely
slow link) and on heard-cursor accuracy, NOT on audio. Its `burstMs` is the cheap
win: it is spent out of the client's cushion one-for-one, and the wakeup rate it
was sized against ("~50/second") is ~12.5/second at this provider's 3840-byte
frames.

**The last column is NOT why the lead cannot be raised**, and believing it was
cost this branch a second commit. `HEARD_AUDIO_LAG_MS` (originally 750) was
documented as `PLAYBACK_JITTER_MS` (400) plus a sub-second network hop, and the
measurement above refutes that decomposition: the cushion the client holds is
the pacer's LEAD, moving one-for-one with it and barely at all with the fill
target. The tempting conclusion — derive the ear-lag from the lead — is ALSO
wrong, and was briefly shipped.

**Why: the playback clock already subtracts the buffer.** `heardMs()` in
`aai/host/transports/pipeline-heard.ts` is
`audioMs - clock.remainingMs() - lagMs`, and `endsAtMs` inside that clock
accumulates from `max(endsAtMs, now())` — so it runs ahead by whatever the lead
is, and `remainingMs()` already reports the client's unplayed backlog. Anything
the constant adds on top double-counts it. Driving the host's own arithmetic
against the audio the ear really received (`heardErrorMs` in the test):

| `lagMs` | perfect | typical | mobile |
| --- | --- | --- | --- |
| 0 | +8 ms | +55 ms | +130 ms |
| 150 (shipped) | -142 ms | -95 ms | -20 ms |
| 750 (the old value) | -742 ms | -694 ms | -619 ms |
| 950 (`lead - burst/2`) | -942 ms | -894 ms | -819 ms |

Positive means the cursor runs AHEAD of the ear — over-keeping, the failure
`pipeline-heard.ts` names. At zero it is already accurate to tens of
milliseconds, and the error is IDENTICAL at leads of 1000, 1500 and 2000, which
is the evidence that what is left for the term is the one-way network hop and
nothing else. The old 750 left the cursor ~694 ms early on a typical link — ~10
words at English narration rates rather than the "word or two of redundancy" the
asymmetry argument budgets for, pushing toward exactly the repetition
`buildTailResumePrompt` exists to fix.

**`PIPELINE_PLAYBACK_GRACE_MS` (750) is likewise fine and likewise
lead-independent.** The requirement — how long after `endsAtMs` the caller is
still hearing audio, so a smaller value misses a tail barge-in — measures 15 ms
on a loopback link, 63 ms typical, 138 ms mobile, identical at every lead. It has
~5x margin over the worst of those.

The rule this leaves behind, since two derivations broke on it: **neither
constant is the client's buffer depth.** Measure `heardMs()` against the ear, not
the buffer against the lead.

### What was changed, and what deliberately was not

Three of those findings were acted on; the tests above are what keep them true.

- **`PLAYBACK_JITTER_MS` is deleted**, and with it the worklet's `fillTarget`
  indirection — with one target, that field was always equal to `fillSamples`.
  The survivor is `PLAYBACK_FILL_MS` (200), initialized EXPLICITLY rather than
  left to the pre-roll underrun that used to arm it, so the wait no longer
  depends on whether a write happened to land before the first render callback.
- **`PACER_BURST_MS` is 100**, up from a 200 that cost ~94 ms of absorbed freeze
  for four timer fires a second.
- **`HEARD_AUDIO_LAG_MS` is 150**, down from 750, because it covers only the
  residual the playback clock cannot see — the one-way network hop. It and
  `PIPELINE_PLAYBACK_GRACE_MS` live in `aai/sdk/playback-timing-constants.ts`,
  which exists to keep the trap they share in one place.
- **`CLIENT_AUDIO_LEAD_MS` is 1500**, up from 1000: the longest absorbed link
  freeze goes 914 ms -> 1453 ms at no latency cost. What bounds it is bandwidth
  rather than correctness — a mid-reply barge-in discards ~1.3 s of pushed speech
  instead of ~0.85 s, paid on the metered links that can least afford it.

**The bench grew a barge-in instrument to settle that**, because the claim that
the grace blocked the lead was arithmetic rather than measurement, and wrong.
`playoutVsHost` (in `_playback-bench-host.ts`) replays a render against the
host's own playback-clock arithmetic and reports how long after its estimate the
ear was still receiving audio, for a client that reports its backlog and one that
does not. That is what turned "the grace is ~200 ms short" into "the requirement
is 15-138 ms and the grace has 5x margin", and it is what unblocked the lead.

**The pacer itself stays.** Removing it is the best thing that could happen to
playback quality in isolation — unpaced, the client rides out any freeze — and
it is still wrong on three counts, two of which are measured here: the peak
client-socket queue becomes the whole undelivered reply (356 KiB for 8 s, ~2.7
MiB extrapolated to 60 s, against a 4 MiB disconnect), a mid-reply barge-in
throws away ~3.9 s of pushed speech instead of ~0.85 s, and the ear-lag becomes
proportional to reply length, which no constant or formula can model. Note also
that on a link which cannot carry 384 kbps the pacer changes nothing at all
(identical episode and silence counts at 350 and 250 kbps) — the link is
already the pacer. Its cost is paid on good links and its protection earned on
bad ones, which is coherent.

## The capture worklet (`worklets/capture-processor.ts`)

The single mic-capture processor. It flushes a `slice()` copy and keeps its own
buffer (re-reading a just-transferred view is how a mic once went
permanently deaf), with start/stop gating, a stop → flush → `stopped`-ack
protocol, and the dead-mic probe. Two guards remain load-bearing:
`instantiateWorklet`'s harness honors the transfer list (`structuredClone`
with `transfer`, which really detaches) and caps posted messages so a
runaway loop is a named failure rather than a hang, and
`worklets/capture-processor.test.ts` exercises the processor source.

## Consuming the client config

How the browser client reads `GET /client-config`. The endpoint itself is
the SDK's — see "Pre-connection client config" in `packages/aai/CLAUDE.md`.

`client()`'s config tier renders `DefaultRoot`, which fetches the config
(any failure degrades to the empty default, so older servers keep working)
and mounts the chat shell; the shell uses the server-declared `name` unless
`client({ name })` overrides it. A custom `component` ignores all of it.

**It skips the lookup entirely when `client({ name })` named the agent**, because
the response's only consumer there is that fallback — and on the platform this
endpoint is the BROKER, so the discarded request is one that can boot a sandbox.
The SESSION's lookup is a separate question and is deliberately left as it is:
it re-brokers per connection ATTEMPT, which is what makes a reconnect land on a
REPLACEMENT sandbox, so it may not be served from an answer this render already
holds — the two are minutes apart (the session only connects from the Start
button), and a memo spanning them would hand the socket a `sessionUrl` naming an
evicted sandbox, turning a first-attempt connect into a failed attempt plus a
retry.

**The session's per-attempt broker lookup uses `loadClientConfig`, not
`fetchClientConfig`** — it returns `null` for a lookup that produced no
answer, keeping that distinct from a server that answered and named no
`sessionUrl`. Degrading both to `{}` is fine for name/greeting and wrong
here: `session-core.ts` latches `serverIsBroker = false` on a config with
no `sessionUrl`, and that latch skips the broker fetch on every later
attempt. So one 503 — a sandbox mid-boot, or one that failed to start —
pinned the client to the platform's `/:slug/websocket`, whose WebSocket
redirect browsers do not follow (sessions go straight to the sandbox now),
with no route back even after the agent recovered. Only an ANSWERED lookup
may set the latch.

**There is no text-only mode.** Every pipeline agent declares a real TTS
provider, and the default `ChatView` always renders the voice `Controls`.
The snapshot's `apiUrl` field carries the programmatic WebSocket endpoint,
shown by `ApiUrlChip`. **It is the LONG-LIVING platform endpoint**
(`wss://host/:slug/websocket`), never the brokered sandbox tunnel URL the
session actually connects to — the tunnel URL dies with the sandbox (idle
eviction, redeploy), so surfacing it hands users a link that rots. The
platform endpoint stays valid: a plain upgrade on it resolves the live
sandbox (booting it like the client-config broker) and answers a 302
redirect to the sandbox's current session URL (`orchestrator-ws.ts`,
query preserved so `?sessionId=` resumes survive). Programmatic WebSocket
clients that follow handshake redirects land on the sandbox; browsers
don't follow WebSocket redirects, which is fine — the browser path is the
client-config broker.
