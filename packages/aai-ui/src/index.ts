// Copyright 2025 the AAI authors. MIT license.
/**
 * The browser client for aai agents — React 19 hooks and components over a
 * framework-agnostic session core (WebSocket + microphone + playback).
 *
 * ## Start with a mount
 *
 * A client is one `client.tsx` calling one mount, and WHICH mount is the only
 * structural decision on this surface — it follows the agent's front door:
 *
 * | The agent is | The page calls | It talks to |
 * | --- | --- | --- |
 * | a voice agent (the default) | {@link mountClient} | a live session: socket, microphone, playback |
 * | a `workflowApp()` / `agent({ mode: "workflow-app" })` | {@link mountPage} | the workflow HTTP API — no session, no socket, no mic |
 *
 * There is no route to write and no glue file: the agent server already serves
 * both, so a component talks to a live agent directly. {@link createBrowserSession}
 * is the same session core with no React, for a page built on something else.
 *
 * ## Then the hook that answers your question
 *
 * The hooks are grouped by what they read, and within a group the narrow one
 * exists so a component re-renders on its own slice rather than on every frame:
 *
 * | Reading | Hooks |
 * | --- | --- |
 * | the call itself | {@link useSession} (everything), {@link useSessionStatus}, {@link useSessionError}, {@link useSessionActions}, {@link useSessionSelector} |
 * | who the client is | {@link useSessionId}, {@link useClientId}, {@link browserClientId}, {@link createLinkedClient} |
 * | a run reaching the page later | {@link useInbox} (a reminder, a finished job — played when it lands) |
 * | what was said | {@link useConversation}, {@link useUserTranscript}, {@link useConversationLog} (across sessions, persisted) |
 * | the talk button | {@link useTapToTalk} (tap on, tap off), {@link usePushToTalk} (hold, for `turnTaking: { detection: "manual" }`) |
 * | the agent's own `/api` routes | {@link useRoute}, {@link useRouteMutation}, {@link routeFetch}, {@link useClientRuns} (a `clientRunsRoutes()` pair) |
 * | what this browser remembers | {@link useStoredValue} / {@link createStoredValue}, {@link phoneE164} |
 * | what the agent projects | {@link useAgentState} — pass the `slot.projected` the agent declared under its slot name in `syncState`, and it selects that slot, types it AND supplies the frame rendered before the first push; {@link selectAgentState} is the same slot as a `useSessionSelector` selector |
 * | tools, as they run | {@link useToolCallStart}, {@link useToolResult}, {@link useEvent} |
 * | a durable run | {@link useWorkflowSubmit} (start one), {@link useWorkflowRun} (watch one), {@link useWorkflowRuns} / {@link useWorkflows} (list), {@link useWorkflowProgress} / {@link useWorkflowStream} (its output as it arrives) |
 * | page chrome | {@link useTheme}, {@link useCopy}, {@link useFlash}, {@link useDownloadUrl}, {@link useRunKey} |
 *
 * Everything else here is a COMPONENT — chat chrome ({@link MessageList},
 * {@link ChatView}, {@link Controls}, {@link StartScreen}), workflow forms
 * ({@link Form}, {@link WorkflowFields}, the `*Field` set), and the small
 * primitives pages kept re-writing ({@link AutoScroll}, {@link Markdown},
 * {@link Facts}, {@link ToolCallRow}). None is required: the hooks are the API
 * and the components are one rendering of it.
 *
 * ## Two things worth knowing before the reference below
 *
 * **Several names are re-exported from `@alexkroman1/aai`** —
 * {@link WorkflowInputOf}, {@link WorkflowOutputOf}, {@link WorkflowSummary} and
 * {@link AgentClient}, plus {@link isTerminal} and {@link ClientConfigResponse}.
 * They are one declaration with two reference pages, not two types; a page takes
 * them from here, an `agent.ts` from there.
 *
 * **{@link createWorkflowApi} is the browser's client, and there is one other.**
 * `createAgentClient` (`@alexkroman1/aai/workflow-api`) is the same
 * {@link AgentClient} for a caller with no page to default its base URL from — a
 * script, a cron job, a server. Reach for the one here whenever the code runs in
 * a page the agent serves; it delegates to that factory, so there is one
 * implementation of the routes and one `config()`. (It used to answer the
 * narrower `WorkflowApi`, which made a page wanting the agent's own name build a
 * second client for one read.)
 *
 * @module
 */

// Re-exported from `@alexkroman1/aai` — one declaration, two reference pages —
// because a page renders a caught error as often as a tool body does, and
// the SDK root is not a page's import.
export {
  type ClientRun,
  type ClientRunStatus,
  type ClientRunsResponse,
  errorMessage,
} from "@alexkroman1/aai";
// The seven default state words, so a chrome overrides the one it has a better
// term for instead of writing a ternary chain over the whole union. Same shape
// and same argument as `WORKFLOW_STATUS_LABELS` below.
export { AGENT_STATE_LABELS } from "./agent-state-labels.ts";
// Pre-connection client-config lookup (name + greeting). `fetchClientConfig`
// is the PUBLIC half — what a page with its own `component` calls, since both
// mounts make this lookup only for the shell they render themselves. Its base
// URL defaults to the page's own. The default client's and the session's own
// plumbing (`buildAgentUrl`, `loadClientConfig`) is on
// `@alexkroman1/aai-ui/internal`.
export {
  type ClientConfigResponse,
  fetchClientConfig,
} from "./client-config.ts";
// Who this browser is to an agent: the id `client: "auto"` mints and keeps,
// and the `session.identity` handle. Published because a page shows the id and
// a link-code flow must name THIS browser even while it sends another id.
export { browserClientId, type SessionIdentity } from "./client-identity.ts";
// The page answering a `clientTool` call — the one hook that talks BACK.
export { useClientTool } from "./client-tool.ts";
// Components
// The player for a file a RUN produced — heading, pending line, announced
// error, `<audio>` with an optional one-cue caption track, download link — over
// a `useDownloadUrl` result. The two audio-round-trip templates had written it
// byte-for-byte.
export {
  AudioResult,
  type AudioResultCaptions,
  type AudioResultProps,
} from "./components/audio-result.tsx";
export { AutoScroll } from "./components/auto-scroll.tsx";
// A run's key points, findings or risks as a disc list. Published because all
// five pages that had written it keyed by the bullet's own TEXT, and these
// lists are model output — a repeated bullet is a duplicate React key.
export { BulletList, type BulletListProps } from "./components/bullet-list.tsx";
export { Button, type ButtonSize, type ButtonVariant } from "./components/button.tsx";
export { ChatView } from "./components/chat-view.tsx";
// The chrome UNDER `ChatView` — header, announced error banner, card, footer —
// for a client that owns the conversation but not the frame. Published because
// every custom chrome that rebuilt it lost the banner's `role="alert"`.
export { ConsoleShell, type ConsoleShellProps } from "./components/console-shell.tsx";
export { Controls, type ControlsProps } from "./components/controls.tsx";
// The conversation's SKELETON over `useConversation` — the pinned scroll, the
// empty state, the interleave with its keys, the streaming row, the announced
// thinking row and the transcript — with every bubble a render slot.
// `MessageList` is this with the stock bubbles filled in.
export {
  ConversationView,
  type ConversationViewProps,
} from "./components/conversation-view.tsx";
// A muted line of run facts joined by `·`. It owns the separator — four of the
// nine sites that wrote it by hand carried a literal `{" "}` to survive a wrap
// — and drops the facts a page decided not to print.
export { Facts, type FactsProps } from "./components/facts.tsx";
// Forms — what a workflow app's front door is made of. See `components/form.tsx`
// for why the values come off the DOM rather than out of React state.
export {
  CheckboxField,
  Field,
  type FieldShell,
  FileField,
  type FileReadMode,
  type FileValue,
  Form,
  type FormProps,
  type FormValues,
  NumberField,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
} from "./components/form.tsx";
export { Markdown, type MarkdownProps, type MarkdownVariant } from "./components/markdown.tsx";
export { MessageList, type MessageListProps } from "./components/message-list.tsx";
// The FULL control row of a custom chrome — Start before the call, then
// Pause/Resume, New Conversation and End — with each button a render slot.
// `Controls` is the stock footer and has neither Start nor End; three chromes
// each wrote this row and the twelve-line `end(); start()` argument beside it.
export {
  type SessionControlAction,
  type SessionControlButton,
  SessionControls,
  type SessionControlsLabels,
  type SessionControlsProps,
} from "./components/session-controls.tsx";
// The announced error banner, WITHOUT the frame that used to come with it —
// `ConsoleShell` composes this one rather than carrying a second copy. Every
// full-bleed chrome rebuilt the banner because it could not adopt the shell,
// and the three that did had already drifted on whether to show the code.
export {
  SessionErrorBanner,
  type SessionErrorBannerProps,
} from "./components/session-error-banner.tsx";
// The live state as a dot and a word, coloured from the CHROME's palette. The
// palette is the prop, which is what keeps the shared part (the exhaustive
// lookup, the label fallback, the pulse rule) from taking it hostage.
export {
  SessionStateDot,
  type SessionStateDotProps,
} from "./components/session-state-dot.tsx";
export { SidebarLayout } from "./components/sidebar-layout.tsx";
export { StartScreen } from "./components/start-screen.tsx";
// The design system's console row for one tool invocation — the shared
// presentational shell behind both the deployed agent UI's tool blocks and
// the studio transcript's tool rows.
export {
  ToolCallRow,
  type ToolCallRowProps,
  type ToolCallRowVariant,
} from "./components/tool-call-row.tsx";
// The value type a caller names to write `ClientConfig.tools`. The CONTEXT
// `mountClient()` installs it into is internal — see `internal.ts`.
export type { ToolDisplayConfig } from "./components/tool-config-context.ts";
// The bar over the one wait a run cannot describe — storing a form's files, which
// happens BEFORE the run that carries their ids exists.
export { UploadProgressBar } from "./components/upload-progress.tsx";
// A form generated from a workflow's own declared input schema.
export { WorkflowFields } from "./components/workflow-fields.tsx";
// The one sentence a page says while a run is pending — three situations, and
// the reload case gets its own words. Six pages had written the function.
export {
  WorkflowPendingNote,
  type WorkflowPendingNoteProps,
} from "./components/workflow-pending-note.tsx";
// The rendered half of `useWorkflowProgress` — what a run has SAID, as against
// where it has got to.
export { WorkflowProgress } from "./components/workflow-progress.tsx";
// The announced line for a run that FAILED. Published for its `role="alert"`:
// the outcome lands minutes after the reader looked away, and `<Form>` announces
// only the submit error.
export {
  WorkflowRunError,
  type WorkflowRunErrorProps,
} from "./components/workflow-run-error.tsx";
// The bordered panel a page shows ONE run in: status line, Clear, narration, a
// live slot, the typed completed body, the announced error — in that order.
export {
  WorkflowRunPanel,
  type WorkflowRunPanelProps,
} from "./components/workflow-run-panel.tsx";
export type { Session, SessionActions } from "./context.ts";
// Context & hooks. The two PROVIDERS `mountClient()` mounts around the tree
// (`SessionProvider`, `ThemeProvider`) are on `@alexkroman1/aai-ui/internal`.
//
// The three NARROW hooks beside `useSession` are what this package's own
// components always had and a `client.tsx` did not: `useSessionActions` is the
// control methods with no snapshot subscription (`useSessionCore` narrowed to
// what a client may legitimately call, minus the store), and the other two are
// the only two snapshot fields more than one custom chrome ever selects. A page
// that needs a third field still writes `useSessionSelector` — these are the
// measured repeats, not the beginning of a hook per field.
export {
  useSession,
  useSessionActions,
  useSessionError,
  useSessionSelector,
  useSessionStatus,
  useTheme,
} from "./context.ts";
// The browser twin of a device keeps its own transcript across the device's
// short resumable sessions: the persisted entries, and the mapping from a
// mirrored inbox frame to a row. The hook is `useConversationLog` below.
export { type ConversationLogEntry, inboxEventToItem } from "./conversation-log.ts";
export type { ClientConfig, ClientHandle } from "./define-client.tsx";
// Entry
export { mountClient } from "./define-client.tsx";
export {
  selectAgentState,
  useAgentState,
  useEvent,
  useToolCallStart,
  useToolResult,
} from "./hooks.ts";
// The client's `WS /inbox` socket — what a run's `stepNotifyClient` reaches
// after the session has closed. `createInbox` is the core; `useInbox` below
// fills it from the session and plays what arrives.
export { type CreateInboxOptions, createInbox, type Inbox } from "./inbox.ts";
export type { InboxEvent, InboxNotice } from "./inbox-protocol.ts";
// Which client a page IS — a device it was linked to, else this browser.
export {
  createLinkedClient,
  type LinkedClient,
  type LinkedClientOptions,
} from "./linked-client.ts";
// Workflow apps — the `workflowApp()` half of this package. `mountPage()`
// is the mount (no session, no audio, no socket), and its `component` is
// OPTIONAL: with none it renders a form per declared workflow, the run's
// progress and its result, out of the exports below. What a component of its
// own talks to the agent with is those same exports, in place of
// `useSession()`.
export { mountPage, type PageConfig, type PageHandle } from "./page.tsx";
// A typed phone number as the E.164 `phone` the session must carry.
export { type PhoneE164Options, phoneE164 } from "./phone.ts";
// The agent's own JSON routes (`agent({ routes })`, under `/api`): one call,
// with `?client=` and the route's `{ error }` sentence. `useRoute` reads,
// `useRouteMutation` writes, `useClientRuns` is `clientRunsRoutes()`' page half.
export { type RouteFetchOptions, type RouteMethod, routeFetch } from "./route-fetch.ts";
export type {
  AgentCustomEvent,
  AgentStateFrame,
  BrowserSession,
  // The seal `BrowserSession` carries. TYPE-ONLY: there is no value to import,
  // which is what stops a hand-written object from satisfying the type.
  browserSessionBrand,
  SendTextOptions,
  SessionSnapshot,
  ToolCallOutcome,
  // `session.userTurn` — push-to-talk's three edges, the `push-to-talk`
  // capability's beside `usePushToTalk`.
  UserTurnControls,
} from "./session/index.ts";
// Session core (for advanced use)
export { createBrowserSession } from "./session/index.ts";
// A clipboard write that reports a REFUSED one instead of doing nothing
// visible, keyed by the copied text so one row's "Copied" does not light up
// every button. Built on `useFlash` below; three hand-rolled copies preceded
// the pair, this package's own URL chips among them.
// A string this browser remembers — a setting, a phone — readable in a getter
// outside React and reactive inside it, synced across holders and tabs.
export {
  createStoredValue,
  type StoredValue,
  type StoredValueOptions,
  useStoredValue,
} from "./stored-value.ts";
// Types
export type {
  AgentState,
  ChatMessage,
  ClientTheme,
  SessionError,
  SessionErrorCode,
  ToolCallInfo,
  VoiceSessionOptions,
  WebSocketConstructor,
} from "./types.ts";
// The runs going on for this client, from a `clientRunsRoutes()` pair.
export {
  type UseClientRunsOptions,
  type UseClientRunsResult,
  useClientRuns,
} from "./use-client-runs.ts";
// The conversation with nothing rendered — what `MessageList` is now built
// from, so a custom chrome inherits the interleave, the streaming row, the
// transcript's null-vs-empty distinction and the thinking rule instead of
// re-deriving four of them badly.
export {
  type ConversationItem,
  type UseConversationResult,
  useConversation,
} from "./use-conversation.ts";
// Everything the page has said and heard, across resumable sessions, persisted
// in `localStorage` — with a resumed session's replay logged once.
export {
  type UseConversationLogOptions,
  type UseConversationLogResult,
  useConversationLog,
} from "./use-conversation-log.ts";
export { type UseCopyResult, useCopy } from "./use-copy.ts";
// An upload id a run PRODUCED, as a URL a DOM element accepts — with the
// object-URL revoke and the stale-run guard that two templates had each
// re-derived.
export {
  type UseDownloadUrlOptions,
  type UseDownloadUrlResult,
  useDownloadUrl,
} from "./use-download-url.ts";
// A value that shows itself for a moment and clears itself — one live timer,
// none after unmount. The primitive under `useCopy`, public in its own right
// for the "Saved" note a chrome writes beside an editor.
export { type UseFlashResult, useFlash } from "./use-flash.ts";
// A notice from a run, played when it lands — busy while a call is on, so it
// never talks over a reply. Every browser app that wanted reminders wrote it.
export { type UseInboxOptions, type UseInboxResult, useInbox } from "./use-inbox.ts";
// A hold-to-speak button for a `turnTaking: { detection: "manual" }` agent — pointer
// capture, key repeat, a lost keyup and an unmount mid-hold, all of which
// otherwise leave the microphone open on a turn nothing will answer.
export {
  type UsePushToTalkOptions,
  type UsePushToTalkResult,
  usePushToTalk,
} from "./use-push-to-talk.ts";
// The opaque, storage-backed key `useWorkflowSubmit` looks a run up by. It
// mints one of these for itself now, so this is for the page that wants a
// different one — an account's id, or a key that outlives the tab.
export { type UseRouteOptions, type UseRouteResult, useRoute } from "./use-route.ts";
export {
  type RouteMutationRunOptions,
  type UseRouteMutationOptions,
  type UseRouteMutationResult,
  useRouteMutation,
} from "./use-route-mutation.ts";
export { useRunKey } from "./use-run-key.ts";
// The two flags and four methods a control row renders from, on two one-field
// subscriptions — what `SessionControls` is built on, for the chrome whose
// buttons are too unusual even for its render slot.
export { type UseSessionControlsResult, useSessionControls } from "./use-session-controls.ts";
// The two ids a page keys things by, current without `onSessionId` wiring.
export { useClientId, useSessionId } from "./use-session-id.ts";
// Tap to go live, tap to hang up — the toggle counterpart of `usePushToTalk`
// for an automatic-turn agent: resumable hang-up, mute unless live, a typed
// turn that opens the session, and the self-hang-up clocks.
export {
  type UseTapToTalkOptions,
  type UseTapToTalkResult,
  useTapToTalk,
} from "./use-tap-to-talk.ts";
// The caller's in-progress turn, with `null` (silent) and `""` (speech
// detected, no words yet) kept apart — see the module doc.
export { type UseUserTranscriptResult, useUserTranscript } from "./use-user-transcript.ts";
export {
  type UploadStatus,
  type UseWorkflowSubmitOptions,
  useWorkflowSubmit,
  type WorkflowSubmission,
} from "./use-workflow-form.ts";
// `RunProgressReader` stays unexported, like `RunWatcher` next door: both are
// one-method narrowings of the client for their own module's use, not API.
export {
  type UseWorkflowProgressResult,
  useWorkflowProgress,
} from "./use-workflow-progress.ts";
export { type UseWorkflowRunResult, useWorkflowRun } from "./use-workflow-run.ts";
// The list beside the one — history a page can render instead of asking for a
// run id, which is what a workflow app without it has to do.
export {
  type UseWorkflowRunsOptions,
  type UseWorkflowRunsResult,
  useWorkflowRuns,
} from "./use-workflow-runs.ts";
export {
  type UseWorkflowStreamOptions,
  useWorkflowStream,
  type WorkflowStreamSubmission,
} from "./use-workflow-stream.ts";
// The listing `<WorkflowFields>` renders a form from — the other half of
// `use-workflow-form.ts` before that file reached its cap.
export {
  type UseWorkflowsOptions,
  type UseWorkflowsResult,
  useWorkflows,
} from "./use-workflows.ts";
export {
  type AgentClient,
  createWorkflowApi,
  isTerminal,
  type WorkflowApi,
  type WorkflowApiOptions,
  type WorkflowInputOf,
  type WorkflowOutputOf,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowSummary,
} from "./workflow-client.ts";
// What `submit()` takes: `WorkflowInputOf<D>`, or `undefined` for a def with no
// input schema. It is in the rendered signature of both submit hooks, so it is
// a name a page can read rather than one it has to re-derive.
export type { SubmitInputOf } from "./workflow-def-types.ts";
// The control-selection rule `<WorkflowFields>` itself runs, published so a
// reader documenting the form-to-JSON correspondence asks the component's own
// decision rather than mirroring the switch by hand.
export { fieldKindFor, type WorkflowFieldKind } from "./workflow-field-kind.ts";
// The five default status lines, so a page overrides the one word it has a
// better term for instead of restating the union.
export { WORKFLOW_STATUS_LABELS } from "./workflow-status-labels.ts";
