// Copyright 2025 the AAI authors. MIT license.
// Studio shell (design 1b): shared top bar. Landing always shows the home
// page — a project sidebar plus a centered hero prompt box (home.tsx) whose
// first message creates a project; opening a project swaps to the 360px chat
// panel on the left with the Preview/Code pane on the right. TanStack Query
// owns all server state, invalidated after agent turns / publishes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AccountMenu } from "./account-menu.tsx";
import {
  ApiError,
  api,
  type ChatSession,
  errorText,
  isTransientSessionError,
  type ProjectData,
  type StudioStatus,
} from "./api.ts";
import { ChatPanel, type NotifyChat } from "./chat.tsx";
import { HomeHero, HomeSidebar } from "./home.tsx";
import { PreviewPane } from "./preview.tsx";
import { queryKeys } from "./query-keys.ts";
import { SettingsPane } from "./settings.tsx";
import { lazyRetry } from "./stale-build.ts";
import { PublishMenu, type StudioTab, TopBar } from "./top-bar.tsx";
import { type StreamHandlers, useEventStream } from "./use-event-stream.ts";

// CodeMirror is the bulk of the bundle and only the Code tab needs it — the
// default (Preview) path shouldn't pay for it.
//
// Wrapped in `lazyRetry` because that laziness is exactly what a deploy
// breaks: the chunk URL is content-hashed and served `immutable`, so a tab
// open across a Modal deploy is holding a name the new containers 404. The
// user clicks Code hours later and, unhandled, `lazy` throws into a tree with
// no boundary — a blank studio. See stale-build.ts.
const CodeView = lazy(
  lazyRetry(() => import("./code-view.tsx").then((m) => ({ default: m.CodeView }))),
);

type AppProps = {
  bearer: string;
  onSignOut: () => void;
  /**
   * Mint a fresh `bearer` after the server rejected the current one — see
   * `useStudioAuth().refresh`. Required rather than optional: an event stream
   * with no way to recover its token retries a dead one forever.
   */
  refreshAuth: () => Promise<void>;
};

// v0-style project URLs: each project lives at /studio/chat/<name>, so a
// build is linkable/bookmarkable. The server serves the same shell for the
// path; the client owns the mapping below (pushState + popstate).
const PROJECT_PATH_RE = /^\/studio\/chat\/([a-z0-9][a-z0-9_-]*)\/?$/;

function projectFromPath(pathname: string): string | null {
  return PROJECT_PATH_RE.exec(pathname)?.[1] ?? null;
}

function projectPath(name: string | null): string {
  return name ? `/studio/chat/${encodeURIComponent(name)}` : "/";
}

/** Stable identity while the workspace loads, so effects keyed on it don't churn. */
const EMPTY_FILES: Record<string, string> = {};

/**
 * How many transient broker failures to ride out before surfacing the
 * retryable error state. With TanStack's default exponential backoff
 * (1s doubling, capped at 30s) this keeps trying for roughly three minutes
 * of delay plus attempt time — enough to span a server restart, so a chat
 * opened mid-restart connects on its own once a sandbox is available.
 */
const CHAT_SESSION_MAX_RETRIES = 10;

export function App({ bearer, onSignOut, refreshAuth }: AppProps) {
  const queryClient = useQueryClient();
  // The URL seeds the initial selection (a shared /studio/chat/<name> link
  // opens that project); after that, selection drives the URL.
  const [project, setProject] = useState<string | null>(() =>
    projectFromPath(window.location.pathname),
  );
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [tab, setTab] = useState<StudioTab>("preview");
  const [publishOpen, setPublishOpen] = useState(false);
  // The two top-bar dropdowns overlap in the same corner, so opening one
  // closes the other.
  const [accountOpen, setAccountOpen] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  // A chat turn is in flight. Publish locks on this: the preview only
  // deploys on the guest's END-OF-TURN workspace sync (mid-turn checkpoints
  // can leave a half-finished tree), and Publish ships the same workspace —
  // so it unlocks on the same turn-settled event the preview builds on.
  const [chatBusy, setChatBusy] = useState(false);

  const status = useQuery<StudioStatus>({ queryKey: queryKeys.status, queryFn: api.status });

  const projects = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => api.listProjects(bearer),
  });

  // The query holds the project state; the SSE subscription below feeds it.
  const workspace = useQuery<ProjectData>({
    queryKey: queryKeys.project(project),
    queryFn: () => api.getProject(bearer, project as string),
    enabled: project != null,
  });

  // Live project state, pushed by the server whenever the workspace or chat
  // row changes (Supabase Realtime behind an SSE relay — see the events
  // routes in studio-routes.ts). This is how a finished auto preview deploy
  // reaches the pane: `previewVersion` changes and the iframe reloads
  // itself. The old polling loop (and its edit-activity window) is gone; a
  // dropped stream resubscribes with a fixed backoff while the project
  // stays open. Pushed chat history refreshes the query cache — the panel
  // in THIS tab owns its live conversation (`useChat` seeds once at mount),
  // so this is what keeps a second tab's next open current.
  useEventStream(
    useCallback(
      (handlers: StreamHandlers) =>
        project == null
          ? () => undefined
          : api.watchProject(bearer, project, {
              onData: (data) => queryClient.setQueryData(queryKeys.project(project), data),
              onChat: (messages) => queryClient.setQueryData(queryKeys.chat(project), messages),
              ...handlers,
            }),
      [bearer, project, queryClient],
    ),
    refreshAuth,
  );

  // Live project LIST for the home sidebar — a project created or deleted
  // on another device shows up without a refresh.
  useEventStream(
    useCallback(
      (handlers: StreamHandlers) =>
        api.watchProjects(bearer, {
          onData: (names) => queryClient.setQueryData(queryKeys.projects, names),
          ...handlers,
        }),
      [bearer, queryClient],
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
    queryFn: () => api.getChat(bearer, project as string),
    enabled: project != null,
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
    queryFn: () => api.createChatSession(bearer, project as string),
    enabled: project != null,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) =>
      failureCount < CHAT_SESSION_MAX_RETRIES && isTransientSessionError(error),
  });

  // Friendly tool labels, served by the sandbox (single source of truth —
  // the guest owns the tool set). Sticky: labels are static per build.
  const toolLabels = useQuery<Record<string, string>>({
    queryKey: queryKeys.toolLabels(chatSession.data?.url),
    queryFn: () =>
      api.sandboxToolLabels(chatSession.data?.token as string, chatSession.data?.url as string),
    enabled: chatSession.data != null,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  // A stale key is the one auth failure worth handling globally — one check
  // over every REST query rather than a copy-pasted effect per query.
  const authError = [projects.error, workspace.error, chat.error].find(
    (err) => err instanceof ApiError && err.status === 401,
  );
  useEffect(() => {
    if (authError) onSignOut();
  }, [authError, onSignOut]);

  // Deliberately no auto-select: landing always shows the hero, and existing
  // projects are one click away in the home sidebar.

  /** Select a project (or null for the home hero) and sync the URL. */
  const selectProject = (name: string | null) => {
    setProject(name);
    setCurrentFile(null);
    const path = projectPath(name);
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  };

  // Back/forward moves between home and projects like any other pages.
  useEffect(() => {
    const onPop = () => {
      setProject(projectFromPath(window.location.pathname));
      setCurrentFile(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const files = workspace.data?.files ?? EMPTY_FILES;
  const deployedSlug = workspace.data?.deployedSlug;
  // "Publish unlocks after your first build" — there must be an agent to ship.
  const hasBuild = project != null && "agent.ts" in files;

  // Default file selection follows the loaded workspace.
  useEffect(() => {
    if (currentFile && currentFile in files) return;
    const entry = "agent.ts" in files ? "agent.ts" : (Object.keys(files)[0] ?? null);
    setCurrentFile(entry);
  }, [files, currentFile]);

  // Refresh server state after agent turns / saves. The project's own data
  // arrives over the event stream (which also covers the preview deploy that
  // follows an edit); the invalidations cover the project list and force an
  // immediate re-read for the edit itself. Deliberately does NOT bump
  // previewNonce: the preview iframe reloads by itself when `previewVersion`
  // changes, and a forced reload here would kill any in-progress voice
  // session for nothing.
  const invalidateWorkspace = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.project(project) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
  };

  const createProject = useMutation({
    // The SERVER names the project — a base derived from the prompt plus a
    // random suffix, v0-style, via the same generator slugless CLI deploys
    // use (aai-server/slug-generate.ts). The client never mints names.
    mutationFn: (prompt: string) => api.createProject(bearer, { prompt }),
    onSuccess: (created) => {
      selectProject(created.name);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    onError: (err) => {
      setPendingPrompt(null);
      alert(errorText(err));
    },
  });

  const saveFile = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.writeFile(bearer, project as string, path, content),
    onSuccess: invalidateWorkspace,
    // The editor's save handler shows the failure inline next to the buffer;
    // log it too so a rejected save is never completely silent.
    onError: (err) => {
      console.error("File save failed:", err);
    },
  });

  // Injected by the mounted ProjectChat: posts a message into the live
  // conversation — how publish output and secret changes reach the coding
  // agent. Silent by default; `{ respond: true }` runs a turn (see NotifyChat).
  const notifyChatRef = useRef<NotifyChat | null>(null);
  const notifyChat: NotifyChat = (text, opts) => notifyChatRef.current?.(text, opts);
  // Stable identity: ProjectChat's registration effect depends on this, and
  // it only writes to a ref, so empty deps are correct.
  const registerNotify = useCallback((fn: NotifyChat | null) => {
    notifyChatRef.current = fn;
  }, []);

  const publish = useMutation({
    mutationFn: () => api.deploy(bearer, project as string),
    onSuccess: (result) => {
      invalidateWorkspace();
      // The PRODUCTION agent changed — reload the pane's production-fallback
      // iframe (projects that predate auto previews frame production).
      setPreviewNonce((n) => n + 1);
      setTab("preview");
      // The CLI's output goes to the chat so the agent knows what shipped
      // (warnings included — e.g. the missing-credential preflight).
      notifyChat(
        `I published the project with the Publish button. aai deploy output:\n\n${result.output}`,
      );
    },
    onError: (err) => {
      // Deploy errors are CLI output too — the coding agent is the one who
      // can fix a failed build or deploy, so it must see them AND act. This
      // one runs a turn rather than waiting to be noticed on the next.
      const message = errorText(err);
      notifyChat(
        `I tried to publish with the Publish button, but aai deploy failed:\n\n${message}`,
        { respond: true },
      );
    },
  });

  const deleteProject = useMutation({
    mutationFn: () => api.deleteProject(bearer, project as string),
    onSuccess: () => {
      // Back to the default pane — the deleted project's Settings page has
      // nothing left to show, and the next project opens on Preview.
      setTab("preview");
      selectProject(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    onError: (err) => alert(errorText(err)),
  });

  // Hero start: typing the first message creates a project (named from the
  // prompt server-side) and forwards it as the first chat turn.
  const startWithPrompt = (prompt: string) => {
    // The hero disables while pending; this guard covers the same-tick
    // race (Enter twice before the re-render) so one prompt never creates
    // two projects.
    if (createProject.isPending) return;
    setPendingPrompt(prompt);
    createProject.mutate(prompt);
  };

  const publishError = errorText(publish.error);
  const publishOutput = publish.data?.output;

  // A failed workspace fetch would otherwise render as an empty project (and
  // a misleading "Publish unlocks after your first build" tooltip).
  const workspaceError = errorText(workspace.error);

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        project={project}
        tab={tab}
        deployedSlug={deployedSlug}
        hasBuild={hasBuild}
        chatBusy={chatBusy}
        publishOpen={publishOpen}
        accountOpen={accountOpen}
        onGoHome={() => selectProject(null)}
        onSelectTab={(next) => {
          setPublishOpen(false);
          setTab(next);
        }}
        onLogOut={onSignOut}
        onTogglePublish={() => {
          setAccountOpen(false);
          setPublishOpen((v) => !v);
        }}
        onToggleAccount={() => {
          setPublishOpen(false);
          setAccountOpen((v) => !v);
        }}
      />
      <AccountMenu open={accountOpen} bearer={bearer} onClose={() => setAccountOpen(false)} />
      <PublishMenu
        open={publishOpen}
        busy={publish.isPending}
        chatBusy={chatBusy}
        output={publishOutput}
        error={publishError}
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
      {project == null ? (
        // Home: previous projects in the sidebar, and the stage is one big
        // prompt box — typing creates a project and forwards the message as
        // its first turn. Landing always starts here (no auto-select).
        <div className="flex min-h-0 flex-1">
          <HomeSidebar projects={projects.data} onSelectProject={selectProject} />
          <HomeHero
            status={status.data}
            creating={createProject.isPending}
            onStart={startWithPrompt}
          />
        </div>
      ) : (
        <main className="flex min-h-0 flex-1">
          <ChatPanel
            key={project}
            // undefined = still loading (the panel must not flash "new chat");
            // a failed fetch degrades to an empty history rather than wedging
            // the panel in its loading state.
            chatHistory={chat.data ?? (chat.isError ? [] : undefined)}
            chatSession={chatSession.data}
            sessionError={chatSession.error}
            toolLabels={toolLabels.data}
            onSessionStale={() =>
              void queryClient.invalidateQueries({ queryKey: queryKeys.chatSessions })
            }
            llmStatus={status.data}
            initialPrompt={pendingPrompt}
            onInitialPromptSent={() => setPendingPrompt(null)}
            onWorkspaceChanged={invalidateWorkspace}
            onBusyChange={setChatBusy}
            registerNotify={registerNotify}
          />
          {tab === "preview" && (
            <PreviewPane
              previewSlug={workspace.data?.previewSlug}
              previewVersion={workspace.data?.previewVersion}
              previewStale={workspace.data?.previewStale}
              previewError={workspace.data?.previewError}
              deployedSlug={deployedSlug}
              unpublished={workspace.data?.unpublished}
              nonce={previewNonce}
              onPublish={() => setPublishOpen(true)}
            />
          )}
          {tab === "code" && (
            <Suspense
              fallback={<div className="flex flex-1 items-center justify-center text-subtle" />}
            >
              <CodeView
                files={files}
                currentFile={currentFile}
                onSelectFile={setCurrentFile}
                onSave={async (path, content) => {
                  await saveFile.mutateAsync({ path, content });
                }}
              />
            </Suspense>
          )}
          {tab === "settings" && (
            <SettingsPane
              bearer={bearer}
              project={project}
              slug={deployedSlug}
              previewSlug={workspace.data?.previewSlug}
              onNotifyChat={notifyChat}
              onDeleteProject={() => deleteProject.mutate()}
              deleting={deleteProject.isPending}
            />
          )}
        </main>
      )}
    </div>
  );
}
