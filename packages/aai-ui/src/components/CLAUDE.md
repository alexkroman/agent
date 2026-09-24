---
summary: >-
  The React component kit: memoized-props and TypeDoc rules, the conversation
  view and chrome pieces, `AutoScroll`, forms and `<WorkflowFields>`, and the
  workflow-page components (progress, run panel, upload bar, audio result).
read_when: >-
  adding or changing a component in `src/components/`, or a form or
  workflow-page component.
---

# `src/components/` — the component kit

Hooks these components render from (`useConversation`, `useSessionActions`,
`useWorkflowSubmit`, …) are in `../CLAUDE.md`.

## A memoized component must NAME its props type

Enforced by `ui-memoized-component-props` (`konsistent.json`): `Markdown`,
`Controls` and `MessageList` carry an explicit
`MemoExoticComponent<FunctionComponent<XProps>>` annotation with `XProps`
exported — typedoc drops an inferred one. Two TypeDoc traps no gate checks:

- **An intersection in a parameter position loses per-property prose.**
  `A & Omit<B, …>` renders as one type expression. So the field components
  (`FieldShell & Omit<…HTMLAttributes>`) document their extras in the
  component's own prose, and the shared four once on the NAMED `FieldShell`.
- **`@param <prop>` on a destructured parameter is discarded** — TypeDoc names
  the whole object after the first `@param` (`Button(variant: {…})`). Write one
  `@param props` plus JSDoc on each property of the object type.

## Conversation and chrome

- **`<ConversationView>` is the structure over `useConversation()`, every bubble
  a render slot**: pinned `AutoScroll`, empty-state guard, the interleave with
  prefixed keys (`m<id>` / `t<callId>` — a message id and a call id with the same
  digits must not collide), the streaming row (default: `renderMessage` over a
  synthetic assistant message, `id: -1`), a `role="status"` thinking row, and the
  transcript inline or `transcriptPosition="below"`.
- **`<MessageList>` is `<ConversationView>` with stock bubbles**
  (`useCallback`-hoisted renderers so per-row memo holds; default `renderTool` is
  `<ToolCallRow variant="compact">`). It must stay rebuildable from the public
  hook — that is the test that the hook has no holes.
- **Subscribe per field** (`useSessionSelector`, `useSessionStatus`,
  `useSessionError`), never whole `useSession()`, in anything that renders at
  STT-partial rate. `use-conversation.test.tsx` pins that unrelated snapshot
  fields cause no render.
- **`ConsoleShell` is public; its error banner must keep `role="alert"`** —
  under the fatal latch the banner is the only signal a call ended (the state
  eyebrow reads live again). The banner is `<SessionErrorBanner>`, COMPOSED into
  the shell (no `error` prop), so a full-bleed chrome can take it without the
  frame. Use `ConsoleShell` when the conversation is yours and the frame is not;
  `ChatView` when both are ours. No template adopts `ConsoleShell` (it is a
  whole centred frame) — an open question for the coverage gate.
- **`<SessionStateDot colors>`**: the palette (`satisfies Record<AgentState,
  string>`) is the PROP; the component owns the exhaustive lookup, the
  `AGENT_STATE_LABELS` fallback and the pulse. `ConsoleShell`'s dot is the same
  `StateDot` coloured from the theme.
- **`<SessionControls>`** decides which buttons exist and what each presses
  (New Conversation is `end(); start()`, not `reset()`); `renderButton` decides
  the look. `useSessionControls()` underneath is for chromes too unusual for the
  slot.
- `.aai-scroll` (`styles.css`) is the shared thin scrollbar, coloured via
  `--aai-scrollbar-thumb` / `--aai-scrollbar-track`.

## `AutoScroll` is the only scroll-pinning implementation

`auto-scroll.tsx` wraps `use-stick-to-bottom`; everything pins through it
(exported for custom chromes). Never hand-roll a `scrollIntoView()` effect: it
fights a reader scrolled up, misses growth that is not a new message, and needs
a synthetic dependency to fire. The outer container **must have a bounded height**
(`flex-1 min-h-0`, `h-full`, fixed) or nothing pins.

## Theme in components

`ThemeProvider` writes the five `--aai-*` tokens and `styles.css` maps them into
Tailwind (`bg-aai-surface`, `text-aai-text`, …) — prefer classes to inline
`style={{ theme.x }}`. Keep `useTheme()` for resolved-value arithmetic
(`inkTint`/`primaryTint` in `_colors.ts`) and multi-value properties a utility
cannot express (`scrollbar-color`). Internal custom properties follow the same
pattern (`--aai-btn-bg`, `--aai-sidebar-w`, `FileField`'s
`::file-selector-button` colours — a `style` prop cannot reach a pseudo-element,
and left unstyled the browser-drawn button can be invisible). The rest of the
theme rules are in `../CLAUDE.md`.

## Forms (`form.tsx`, `form-fields.tsx`, `workflow-fields.tsx`)

`<Form>` plus `Field` / `TextField` / `NumberField` / `TextAreaField` /
`SelectField` / `CheckboxField` / `FileField` / `SubmitButton`.

- **Values come off the DOM, not React state.** `<Form>` reads its own `<form>`
  on submit, so a bare `<input name="x">` works identically. Values are TYPED
  (number → number, checkbox → boolean, empty optional → omitted), which
  `FormData` cannot do and a zod input schema needs.
- **Every element kind in `collectValues` owes the same two checks** (disabled →
  skip; multi-value → list). `<SelectField multiple>` reads `selectedOptions` and
  contributes `[]` when nothing is chosen.
- **A `<FileField>` describes a file; it does not upload by default** —
  `{ name, size, type, lastModified }`, plus `content` with `read="text"` /
  `"dataUrl"` for genuinely small files. Run input is journaled and replayed, so
  bytes do not belong in it. `<FileField upload>` contributes the `File` UNREAD
  for `useWorkflowSubmit` to store.
- **`<WorkflowFields workflow>` renders one control per SCALAR property** of the
  workflow's JSON Schema (string, number, integer, boolean, enum →
  `<SelectField>`), honouring `required`, `default`, `description`, with a
  humanized label; upload properties (`workflow({ uploads })`) get
  `<FileField upload>`. Pass a name (it fetches the listing) or a
  `WorkflowSummary` (it fetches nothing — `useWorkflows({ skip: true })`).
- **It is all-or-nothing and SKIPS objects and arrays.** No `exclude`/`only`;
  `SchemaField` reads only `type`, `enum`, `description`, `default` (no
  `min`/`max`, no `rows`). A conditionally-shown field must be hand-written and
  must be one `<WorkflowFields>` skips, or it renders twice
  (`document-redline-workflow` is the mixed-form example).
- `useFlash`, `useCopy` and `fieldKindFor` exist for the studio's tooling; their
  unexercised names are in `template-api-allowlist.json` on purpose.

## Workflow-page components

- **`<WorkflowProgress runId>`** renders nothing until the agent has a stream AND
  the run has written (`supported` separates the two); renders lines as joined
  TEXT (append-only, legitimately repeating — no stable key); lets them replay.
  `className` REPLACES the default. `lines={n}`: `undefined` = all, `1` =
  newest, `0` = placeholder — slice BEFORE the emptiness test so `0` cannot
  invert into "everything".
- **`WORKFLOW_STATUS_LABELS`** is a complete `Record<WorkflowRunStatus, string>`
  (`running: "Working…"`); override by spreading.
- **`<WorkflowRunPanel run>`**: status line (`statusLabels` spread over the
  defaults), optional Clear, `<WorkflowProgress>`, a `live` slot while
  non-terminal, the completed body from the TYPED output, `<WorkflowRunError>`
  last. Its spec asserts the composition.
- **`<UploadProgressBar>`** covers the upload, `<WorkflowProgress>` the run —
  disjoint by construction. It renders NOTHING with nothing to describe (pass it
  unguarded), shows an unknown total as INDETERMINATE, NAMES and counts the file
  (files go sequentially), and draws pause only when handed BOTH
  `pauseUpload` and `resumeUpload`.
- **`<AudioResult download>`** renders over `useDownloadUrl`: heading, pending
  line, `role="alert"` error, `<audio controls>` and a `download` anchor on the
  object URL. `captions` is optional in both directions.
