// Copyright 2025 the AAI authors. MIT license.

// Pre-connection client-config lookup (name + greeting). `fetchClientConfig`
// is the PUBLIC half — a workflow app's replacement for the lookup `client()`
// makes for itself, since `page()` makes none. The default client's and the
// session's own plumbing (`buildAgentUrl`, `loadClientConfig`) is on
// `@alexkroman1/aai-ui/internal`.
export {
  type ClientConfigResponse,
  fetchClientConfig,
} from "./client-config.ts";
// Components
export { AutoScroll } from "./components/auto-scroll.tsx";
export { Button, type ButtonSize, type ButtonVariant } from "./components/button.tsx";
export { ChatView } from "./components/chat-view.tsx";
// The chrome UNDER `ChatView` — header, announced error banner, card, footer —
// for a client that owns the conversation but not the frame. Published because
// every custom chrome that rebuilt it lost the banner's `role="alert"`.
export { ConsoleShell, type ConsoleShellProps } from "./components/console-shell.tsx";
export { Controls, type ControlsProps } from "./components/controls.tsx";
// Forms — what a workflow app's front door is made of. See `components/form.tsx`
// for why the values come off the DOM rather than out of React state.
export {
  CheckboxField,
  Field,
  type FieldShell,
  FileField,
  type FileRead,
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
// `client()` installs it into is internal — see `internal.ts`.
export type { ToolDisplayConfig } from "./components/tool-config-context.ts";
// The bar over the one wait a run cannot describe — storing a form's files, which
// happens BEFORE the run that carries their ids exists.
export { UploadProgressBar } from "./components/upload-progress.tsx";
// A form generated from a workflow's own declared input schema.
export { WorkflowFields } from "./components/workflow-fields.tsx";
// The rendered half of `useWorkflowProgress` — what a run has SAID, as against
// where it has got to.
export { WorkflowProgress } from "./components/workflow-progress.tsx";
export type { Session } from "./context.ts";
// Context & hooks. The two PROVIDERS `client()` mounts around the tree
// (`SessionProvider`, `ThemeProvider`) are on `@alexkroman1/aai-ui/internal`.
export { useSession, useSessionSelector, useTheme } from "./context.ts";
export type { ClientConfig, ClientHandle } from "./define-client.tsx";
// Entry
export { client } from "./define-client.tsx";
export { useAgentState, useEvent, useToolCallStart, useToolResult } from "./hooks.ts";
// Workflow apps — the `workflowApp()` half of this package. `page()`
// is the mount (no session, no audio, no socket) and the two workflow exports
// are what its component talks to the agent with, in place of `useSession()`.
export { type PageConfig, type PageHandle, page } from "./page.tsx";
// Session core (for advanced use)
export { createSessionCore } from "./session-core.ts";
export type {
  AgentCustomEvent,
  SessionCore,
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
