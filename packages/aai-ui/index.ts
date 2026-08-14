// Copyright 2025 the AAI authors. MIT license.

// Pre-connection client-config lookup (name + greeting) — internal plumbing
// used by the default client; see each symbol's own doc.
export {
  buildAgentUrl,
  type ClientConfigResponse,
  fetchClientConfig,
  loadClientConfig,
} from "./client-config.ts";
// Components
export { AutoScroll } from "./components/auto-scroll.tsx";
export { Button, type ButtonSize, type ButtonVariant } from "./components/button.tsx";
export { ChatView } from "./components/chat-view.tsx";
export { Controls } from "./components/controls.tsx";
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
export { Markdown, type MarkdownVariant } from "./components/markdown.tsx";
export { MessageList } from "./components/message-list.tsx";
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
export type { ToolDisplayConfig } from "./components/tool-config-context.ts";
// Tool display config context — installed by `client()` from
// `ClientConfig.tools`; not something component-tier users pass themselves.
export { ToolConfigContext } from "./components/tool-config-context.ts";
export { ApiUrlChip, SessionUrlChips, UiUrlChip } from "./components/url-chips.tsx";
// A form generated from a workflow's own declared input schema.
export { WorkflowFields } from "./components/workflow-fields.tsx";
export type { Session } from "./context.ts";
// Context & hooks
export {
  SessionProvider,
  ThemeProvider,
  useSession,
  useSessionSelector,
  useTheme,
} from "./context.ts";
export type {
  BaseOptions,
  ClientConfig,
  ClientHandle,
  ComponentTier,
  ConfigTier,
} from "./define-client.tsx";
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
  SessionCoreOptions,
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
// Capture constraints, exported so a custom client that opens its own
// microphone gets the same signal the built-in paths do.
export { VOICE_CAPTURE_CONSTRAINTS } from "./types.ts";
export {
  type UseWorkflowSubmitOptions,
  type UseWorkflowsOptions,
  type UseWorkflowsResult,
  useWorkflowSubmit,
  useWorkflows,
  type WorkflowSubmission,
} from "./use-workflow-form.ts";
// `RunProgressReader` stays unexported, like `RunWatcher` next door: both are
// one-method narrowings of the client for their own module's use, not API.
export {
  DEFAULT_PROGRESS_POLL_MS,
  type UseWorkflowProgressResult,
  useWorkflowProgress,
} from "./use-workflow-progress.ts";
export {
  DEFAULT_WORKFLOW_POLL_MS,
  MAX_MISSING_READS,
  type UseWorkflowRunResult,
  useWorkflowRun,
} from "./use-workflow-run.ts";
// The list beside the one — history a page can render instead of asking for a
// run id, which is what a workflow app without it has to do.
export {
  type UseWorkflowRunsOptions,
  type UseWorkflowRunsResult,
  useWorkflowRuns,
} from "./use-workflow-runs.ts";
export {
  createWorkflowApi,
  isTerminal,
  type WorkflowApi,
  type WorkflowApiOptions,
  type WorkflowOutputOf,
  type WorkflowRun,
  type WorkflowSummary,
} from "./workflow-client.ts";
