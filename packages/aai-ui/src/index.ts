// Copyright 2025 the AAI authors. MIT license.

// The seven default state words, so a chrome overrides the one it has a better
// term for instead of writing a ternary chain over the whole union. Same shape
// and same argument as `WORKFLOW_STATUS_LABELS` below.
export { AGENT_STATE_LABELS } from "./agent-state-labels.ts";
// Pre-connection client-config lookup (name + greeting). `fetchClientConfig`
// is the PUBLIC half — a workflow app's replacement for the lookup `mountClient()`
// makes for itself, since `mountPage()` makes none. The default client's and the
// session's own plumbing (`buildAgentUrl`, `loadClientConfig`) is on
// `@alexkroman1/aai-ui/internal`.
export {
  type ClientConfigResponse,
  fetchClientConfig,
} from "./client-config.ts";
// Components
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
// The announced error banner, WITHOUT the frame that used to come with it —
// `ConsoleShell` composes this one rather than carrying a second copy. Every
// full-bleed chrome rebuilt the banner because it could not adopt the shell,
// and the three that did had already drifted on whether to show the code.
export {
  SessionErrorBanner,
  type SessionErrorBannerProps,
} from "./components/session-error-banner.tsx";
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
// The rendered half of `useWorkflowProgress` — what a run has SAID, as against
// where it has got to.
export { WorkflowProgress } from "./components/workflow-progress.tsx";
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
export type { ClientConfig, ClientHandle } from "./define-client.tsx";
// Entry
export { mountClient } from "./define-client.tsx";
export { useAgentState, useEvent, useToolCallStart, useToolResult } from "./hooks.ts";
// Workflow apps — the `workflowApp()` half of this package. `mountPage()`
// is the mount (no session, no audio, no socket) and the two workflow exports
// are what its component talks to the agent with, in place of `useSession()`.
export { type PageConfig, type PageHandle, mountPage } from "./page.tsx";
// Session core (for advanced use)
export { createBrowserSession } from "./session-core.ts";
export type {
  AgentCustomEvent,
  BrowserSession,
  SessionSnapshot,
} from "./session-core-types.ts";
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
// The conversation with nothing rendered — what `MessageList` is now built
// from, so a custom chrome inherits the interleave, the streaming row, the
// transcript's null-vs-empty distinction and the thinking rule instead of
// re-deriving four of them badly.
export {
  type ConversationItem,
  type UseConversationResult,
  useConversation,
} from "./use-conversation.ts";
// An upload id a run PRODUCED, as a URL a DOM element accepts — with the
// object-URL revoke and the stale-run guard that two templates had each
// re-derived.
export {
  type UseDownloadUrlOptions,
  type UseDownloadUrlResult,
  useDownloadUrl,
} from "./use-download-url.ts";
// The opaque, storage-backed key `useWorkflowSubmit` looks a run up by. It
// mints one of these for itself now, so this is for the page that wants a
// different one — an account's id, or a key that outlives the tab.
export { useRunKey } from "./use-run-key.ts";
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
// The five default status lines, so a page overrides the one word it has a
// better term for instead of restating the union.
export { WORKFLOW_STATUS_LABELS } from "./workflow-status-labels.ts";
