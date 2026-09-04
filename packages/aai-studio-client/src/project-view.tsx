// Copyright 2026 the AAI authors. MIT license.
// Everything that exists only while a project is open: its workspace, chat
// history and brokered sandbox, the panes, Publish, and the unsaved editor
// drafts.
//
// Split out of app.tsx because `project` is a REQUIRED prop here. In one
// component with the home hero it could only be `string | null`, and the six
// queries and mutations that take a project name all narrowed it with `project
// as string` — a cast standing in for the `enabled:` flag two lines above it,
// which is exactly the kind of agreement nothing checks. Mounted with
// `key={project}`, so every piece of per-project state (the open file, the
// drafts, the tab) resets on a switch without an effect to do it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { lazy, Suspense, useCallback, useState } from "react";
import { api, type ChatSession, type ProjectData, type StudioStatus } from "./api.ts";
import { errorText, isTransientError } from "./api-error.ts";
import { authRejection, useAuthRecovery } from "./auth-recovery.ts";
import { ChatPanel } from "./chat.tsx";
import { DocsPane } from "./docs.tsx";
import { bufferFor, useFileDrafts } from "./file-drafts.ts";
import { hasGithubResult } from "./github-result.ts";
import { LogsView } from "./logs-view.tsx";
import { PreviewPane } from "./preview.tsx";
import { queryKeys } from "./query-keys.ts";
import { SecretsPane } from "./secrets.tsx";
import { SettingsPane } from "./settings.tsx";
import { lazyRetry } from "./stale-build.ts";
import { PublishMenu, type StudioTab, TopBar } from "./top-bar.tsx";
import { type StreamHandlers, useEventStream } from "./use-event-stream.ts";
import { WorkflowsPane } from "./workflows.tsx";

// CodeMirror is the bulk of the bundle and only the Code tab needs it — the
// default (UI) path shouldn't pay for it.
//
// Wrapped in `lazyRetry` because that laziness is exactly what a deploy
// breaks: the chunk URL is content-hashed and served `immutable`, so a tab
// open across a Modal deploy is holding a name the new containers 404. The
// user clicks Code hours later and, unhandled, `lazy` throws into a tree with
// no boundary — a blank studio. See stale-build.ts.
const CodeView = lazy(
  lazyRetry(() => import("./code-view.tsx").then((m) => ({ default: m.CodeView }))),
);

/** Stable identity while the workspace loads, so nothing churns on `{}`. */
const EMPTY_FILES: Record<string, string> = {};

/**
 * Which file the Code pane shows: the user's pick while the workspace still
 * has it, else the workspace's own entry point.
 *
 * A function of the two inputs rather than state kept in step by an effect —
 * a selection that has stopped existing is not a selection, and there is
 * nothing to remember about that.
 */
function openFile(selected: string | null, files: Record<string, string>): string | null {
  if (selected !== null && selected in files) return selected;
  if ("agent.ts" in files) return "agent.ts";
  return Object.keys(files)[0] ?? null;
}

/**
 * How many transient broker failures to ride out before surfacing the
 * retryable error state. With TanStack's default exponential backoff
 * (1s doubling, capped at 30s) this keeps trying for roughly three minutes
 * of delay plus attempt time — enough to span a server restart, so a chat
 * opened mid-restart connects on its own once a sandbox is available.
 */
const CHAT_SESSION_MAX_RETRIES = 10;

type ProjectViewProps = {
  bearer: string;
  /** The open project. Required — that is the whole point of this component. */
  project: string;
  /** `/studio/status`, hoisted: the home hero needs it too. */
  chatStatus: StudioStatus | undefined;
  /** See {@link import("./auth-recovery.ts").useAuthRecovery}. */
  refreshAuth: () => Promise<void>;
  /** Prompt typed into the hero that created this project — sent once. */
  initialPrompt: string | null;
  onInitialPromptSent: () => void;
  /** Back to the home hero (the brand button, and after a delete). */
  onGoHome: () => void;
  onLogOut: () => void;
  accountOpen: boolean;
  onToggleAccount: () => void;
};

export function ProjectView(props: ProjectViewProps) {
  const { bearer, project, chatStatus, refreshAuth } = props;
  const queryClient = useQueryClient();
  // Settings when the GitHub install callback just landed here, so its report
  // is on screen rather than consumed by a pane nobody opened — see
  // `hasGithubResult`. A peek, not a consume: the card owns that.
  const [selectedTab, setSelectedTab] = useState<StudioTab>(() =>
    hasGithubResult() ? "settings" : "preview",
  );
  const [publishOpen, setPublishOpen] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  /** The file the user picked, or null to follow the workspace's default. */
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // A chat turn is in flight. Publish locks on this: the preview only
  // deploys on the guest's END-OF-TURN workspace sync (mid-turn checkpoints
  // can leave a half-finished tree), and Publish ships the same workspace —
  // so it unlocks on the same turn-settled event the preview builds on.
  const [chatBusy, setChatBusy] = useState(false);

  // The query holds the project state; the SSE subscription below feeds it.
  const workspace = useQuery<ProjectData>({
    queryKey: queryKeys.project(project),
    queryFn: () => api.getProject(bearer, project),
  });

  // Live project state, pushed by the server whenever the workspace or chat
  // row changes (Supabase Realtime behind an SSE relay — see the events
  // routes in studio-routes.ts). This is how a finished auto preview deploy
  // reaches the pane: `previewVersion` changes and the iframe reloads
  // itself. Pushed chat history refreshes the query cache — the panel in THIS
  // tab owns its live conversation (`useChat` seeds once at mount), so this is
  // what keeps a second tab's next open current.
  useEventStream(
    useCallback(
      (handlers: StreamHandlers) =>
        api.watchProject(bearer, project, {
          onData: (data) => queryClient.setQueryData(queryKeys.project(project), data),
          onChat: (messages) => queryClient.setQueryData(queryKeys.chat(project), messages),
          ...handlers,
        }),
      [bearer, project, queryClient],
    ),
    refreshAuth,
  );

  // Persisted chat history, re-fetched on every project open. `useChat`
  // owns the live conversation after hydration, but the server rewrites the
  // row as each turn settles — so a cached snapshot goes stale the moment a
  // turn completes, and switching back to a project must re-ask the server
  // or it re-hydrates from the pre-turn cache and drops the newest turns.
  // ProjectChat reads its seed once at mount, so a cached array served
  // before the refetch resolves would hydrate stale and the fresh result
  // would be ignored — gcTime: 0 evicts the cache on switch-away instead,
  // making every open a fresh fetch behind the loading pane. Focus
  // refetches are pointless for the same reason the cache is.
  const chat = useQuery<UIMessage[]>({
    queryKey: queryKeys.chat(project),
    queryFn: () => api.getChat(bearer, project),
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  // The project's coding-agent sandbox. Brokered once per project open and
  // held for the session; a dead sandbox (evicted, replaced) surfaces as a
  // failed chat send, which invalidates this query to re-broker. Transient
  // failures (a restarting server, a timed-out attempt) retry with backoff
  // behind the panel's "Starting sandbox…" state; a 4xx is a real answer
  // and fails immediately.
  const chatSession = useQuery<ChatSession>({
    queryKey: queryKeys.chatSession(project),
    queryFn: () => api.createChatSession(bearer, project),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) =>
      failureCount < CHAT_SESSION_MAX_RETRIES && isTransientError(error),
  });

  // Friendly tool labels, served by the sandbox (single source of truth —
  // the guest owns the tool set). Sticky: labels are static per build.
  const session = chatSession.data;
  const toolLabels = useQuery<Record<string, string>>({
    queryKey: queryKeys.toolLabels(session?.url),
    queryFn: () => api.sandboxToolLabels(session?.token ?? "", session?.url ?? ""),
    enabled: session != null,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  // A rejected bearer is refreshed, never signed out on — see auth-recovery.ts.
  useAuthRecovery(authRejection(workspace.error, chat.error), refreshAuth);

  const files = workspace.data?.files ?? EMPTY_FILES;
  const deployedSlug = workspace.data?.deployedSlug;
  // No pane is gated, so the user's pick IS the pane — there is nothing to
  // derive. The gate that used to sit here, and the shape to copy if one ever
  // comes back, are in this package's CLAUDE.md.
  // "Publish unlocks after your first build" — there must be an agent to ship.
  const hasBuild = "agent.ts" in files;

  // Derived during render rather than held in state behind a sync effect: the
  // default follows the workspace, and a selection the workspace no longer has
  // is not a selection.
  const currentFile = openFile(selectedFile, files);

  // Unsaved editor work, held HERE so that switching panes or files cannot
  // silently throw it away — see file-drafts.ts.
  const drafts = useFileDrafts(files);

  // Refresh server state after agent turns / saves. The project's own data
  // arrives over the event stream (which also covers the preview deploy that
  // follows an edit); the invalidations cover the project list and force an
  // immediate re-read for the edit itself. Deliberately does NOT bump
  // previewNonce: the preview iframe reloads by itself when `previewVersion`
  // changes, and a forced reload here would kill any in-progress voice
  // session for nothing.
  const invalidateWorkspace = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.project(project) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
  }, [queryClient, project]);

  const saveFile = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.writeFile(bearer, project, path, content),
    onSuccess: invalidateWorkspace,
    // The editor's save handler shows the failure inline next to the buffer;
    // log it too so a rejected save is never completely silent.
    onError: (err) => {
      console.error("File save failed:", err);
    },
  });

  // A studio action never writes into the conversation. The CLI's output —
  // success, warnings, a failed build — is reported by the PublishMenu that
  // started it (`publish.data` / `publish.error`), not injected as a user
  // message: the transcript is the user's, and a pane that reports its own
  // outcome does not need the agent to relay it.
  const publish = useMutation({
    mutationFn: () => api.deploy(bearer, project),
    onSuccess: () => {
      invalidateWorkspace();
      // The PRODUCTION agent changed — reload the pane's production-fallback
      // iframe (projects that predate auto previews frame production).
      setPreviewNonce((n) => n + 1);
      setSelectedTab("preview");
    },
  });

  const deleteProject = useMutation({
    mutationFn: () => api.deleteProject(bearer, project),
    onSuccess: () => {
      props.onGoHome();
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    onError: (err) => alert(errorText(err)),
  });

  // The Preview pane's report that the platform is not serving the slug it
  // wants to frame. Not a mutation: nothing on screen waits on it, and the
  // pane owns the one-shot/retry policy — this is just the request.
  const wakePreview = useCallback(() => api.wakePreview(bearer, project), [bearer, project]);

  // A failed workspace fetch would otherwise render as an empty project (and
  // a misleading "Publish unlocks after your first build" tooltip).
  const workspaceError = errorText(workspace.error);

  return (
    <>
      <TopBar
        project={project}
        tab={selectedTab}
        deployedSlug={deployedSlug}
        hasBuild={hasBuild}
        chatBusy={chatBusy}
        publishOpen={publishOpen}
        accountOpen={props.accountOpen}
        onGoHome={props.onGoHome}
        onSelectTab={(next) => {
          setPublishOpen(false);
          setSelectedTab(next);
        }}
        onLogOut={props.onLogOut}
        onTogglePublish={() => setPublishOpen((v) => !v)}
        onToggleAccount={() => {
          setPublishOpen(false);
          props.onToggleAccount();
        }}
      />
      <PublishMenu
        open={publishOpen}
        busy={publish.isPending}
        chatBusy={chatBusy}
        output={publish.data?.output}
        error={errorText(publish.error)}
        deployedSlug={deployedSlug}
        // The disabled button is the UI gate; the guard is the backstop for
        // a menu that was already open when a turn started streaming.
        onPublish={() => {
          if (!chatBusy) publish.mutate();
        }}
        onClose={() => setPublishOpen(false)}
      />
      {workspaceError && (
        <div className="border-b border-line bg-panel px-5 py-2 text-xs text-err">
          Failed to load project: {workspaceError}
        </div>
      )}
      <main className="flex min-h-0 flex-1">
        <ChatPanel
          // undefined = still loading (the panel must not flash "new chat");
          // a failed fetch degrades to an empty history rather than wedging
          // the panel in its loading state.
          chatHistory={chat.data ?? (chat.isError ? [] : undefined)}
          chatSession={session}
          sessionError={chatSession.error}
          toolLabels={toolLabels.data}
          // Re-broker, and hand the panel the lease that came back so the
          // turn that found the sandbox gone can be re-sent on it. Read from
          // the CACHE rather than from `chatSession.data`: this settles
          // before React has re-rendered with the new prop, and a re-read of
          // the render-time value would see the dead lease (see
          // sandbox-transport.ts).
          onSessionStale={async () => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.chatSessions });
            return queryClient.getQueryData<ChatSession>(queryKeys.chatSession(project));
          }}
          chatStatus={chatStatus}
          initialPrompt={props.initialPrompt}
          onInitialPromptSent={props.onInitialPromptSent}
          onWorkspaceChanged={invalidateWorkspace}
          onBusyChange={setChatBusy}
        />
        {selectedTab === "preview" && (
          <PreviewPane
            previewSlug={workspace.data?.previewSlug}
            previewVersion={workspace.data?.previewVersion}
            previewStale={workspace.data?.previewStale}
            // "No preview yet" counts as stale, so the pane needs this to
            // tell a first build in flight from an untouched project.
            hasAgent={hasBuild}
            previewError={workspace.data?.previewError}
            deployedSlug={deployedSlug}
            nonce={previewNonce}
            onPreviewMissing={wakePreview}
          />
        )}
        {selectedTab === "docs" && (
          <DocsPane
            bearer={bearer}
            project={project}
            deployedSlug={deployedSlug}
            previewSlug={workspace.data?.previewSlug}
          />
        )}
        {selectedTab === "workflows" && (
          <WorkflowsPane deployedSlug={deployedSlug} previewSlug={workspace.data?.previewSlug} />
        )}
        {selectedTab === "code" && (
          <Suspense
            fallback={<div className="flex flex-1 items-center justify-center text-subtle" />}
          >
            <CodeView
              files={files}
              currentFile={currentFile}
              buffer={bufferFor(drafts.buffers, currentFile, files)}
              onSelectFile={setSelectedFile}
              onEdit={drafts.edit}
              onSave={async (path, content) => {
                await saveFile.mutateAsync({ path, content });
                drafts.markSaved(path);
              }}
            />
          </Suspense>
        )}
        {selectedTab === "logs" && (
          <LogsView
            bearer={bearer}
            previewSlug={workspace.data?.previewSlug}
            deployedSlug={deployedSlug}
          />
        )}
        {selectedTab === "secrets" && <SecretsPane bearer={bearer} project={project} />}
        {selectedTab === "settings" && (
          <SettingsPane
            bearer={bearer}
            data={workspace.data}
            project={project}
            onDeleteProject={() => deleteProject.mutate()}
            deleting={deleteProject.isPending}
          />
        )}
      </main>
    </>
  );
}
