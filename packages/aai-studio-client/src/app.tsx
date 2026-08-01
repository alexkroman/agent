// Copyright 2025 the AAI authors. MIT license.
// Studio shell (design 1b "Guided start"): shared top bar, 360px guided
// chat panel on the left, Live/Code pane on the right. TanStack Query
// owns all server state, invalidated after agent turns / publishes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import clsx from "clsx";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ApiError, api, type ChatSession, type ProjectData, type StudioStatus } from "./api.ts";
import logoUrl from "./assets/assemblyai-logomark.svg";
import { ChatPanel, type NotifyChat } from "./chat.tsx";
import { PreviewPane } from "./preview.tsx";
import { SecretsPanel } from "./secrets.tsx";

// CodeMirror is the bulk of the bundle and only the Code tab needs it — the
// default (Live) path shouldn't pay for it.
const CodeView = lazy(() => import("./code-view.tsx").then((m) => ({ default: m.CodeView })));

type AppProps = { apiKey: string; onSignOut: () => void };

const NEW_PROJECT_SENTINEL = "__new__";

/** Generated name for the guided "just start typing" flow. */
function generatedProjectName(): string {
  return `voice-agent-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Absolute URL of a deployed agent. The href works either way, but the *text*
 * is what people copy out or paste to a colleague, so it carries the origin
 * rather than a bare "/slug/".
 */
function agentUrl(slug: string): string {
  return new URL(`/${slug}/`, window.location.origin).toString();
}

type PublishMenuProps = {
  open: boolean;
  busy: boolean;
  /** `aai deploy`'s output from the last publish (success or failure). */
  output?: string | undefined;
  error?: string | undefined;
  deployedSlug?: string | undefined;
  onPublish: () => void;
  onClose: () => void;
};

function PublishMenu(props: PublishMenuProps) {
  if (!props.open) return null;
  return (
    <div className="absolute top-14 right-5 z-10 flex w-96 flex-col gap-3 rounded-lg border border-line bg-panel p-5 shadow-md">
      <span className="eyebrow">Publish</span>
      <p className="m-0 text-[13px] leading-5 text-muted">
        Runs <code className="font-mono">aai deploy</code> in the project's sandbox and puts the
        agent live. The CLI output lands in the chat, so the agent can fix any errors. Third-party
        keys live in the Secrets panel.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          onClick={props.onPublish}
          disabled={props.busy}
        >
          {props.busy ? "Publishing…" : "Publish"}
        </button>
        <button type="button" className="btn" onClick={props.onClose}>
          Close
        </button>
      </div>
      {(props.output ?? props.error) && (
        <pre
          className={`m-0 max-h-40 overflow-auto rounded-md border border-line bg-cream p-2 font-mono text-[11px] whitespace-pre-wrap ${props.error ? "text-err" : ""}`}
        >
          {props.error ?? props.output}
        </pre>
      )}
      {props.deployedSlug && !props.error && (
        <a
          className="font-mono text-xs break-all text-indigo"
          href={agentUrl(props.deployedSlug)}
          target="_blank"
          rel="noreferrer"
        >
          Live at {agentUrl(props.deployedSlug)}
        </a>
      )}
    </div>
  );
}

type TopBarProps = {
  project: string | null;
  projects: string[];
  tab: "preview" | "code";
  deployedSlug?: string | undefined;
  hasBuild: boolean;
  onSelectProject: (name: string | null) => void;
  onNewProject: () => void;
  onSelectTab: (tab: "preview" | "code") => void;
  onSignOut: () => void;
  onTogglePublish: () => void;
  onToggleSecrets: () => void;
};

/** Shared 60px top bar (all 1x options): brand, switcher, segmented, actions. */
function TopBar(props: TopBarProps) {
  const segClass = (active: boolean) =>
    `seg ${active ? "bg-fg text-cream" : "bg-panel text-muted hover:text-fg"}`;
  return (
    <header className="flex h-[60px] flex-none items-center gap-3.5 border-b border-line bg-panel px-5">
      <div className="flex items-center gap-2.5">
        <img src={logoUrl} alt="AssemblyAI" className="h-5 w-5" />
        <span className="font-serif text-[16px]">AssemblyAI App Builder</span>
      </div>
      <div className="h-[22px] w-px bg-line" aria-hidden />
      <div className="flex h-[34px] items-center gap-2 rounded-sm border border-line bg-panel pl-3 hover:border-line-strong">
        <span
          className={clsx(
            "h-[7px] w-[7px] flex-none rounded-full",
            props.project ? "bg-indigo" : "bg-warm-300",
          )}
          aria-hidden
        />
        <select
          className="h-full cursor-pointer border-none bg-transparent pr-2 text-[13px] text-muted focus:outline-none"
          value={props.project ?? ""}
          onChange={(e) => {
            if (e.target.value === NEW_PROJECT_SENTINEL) {
              props.onNewProject();
              return;
            }
            props.onSelectProject(e.target.value || null);
          }}
        >
          {!props.project && <option value="">No project yet</option>}
          {props.projects.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value={NEW_PROJECT_SENTINEL}>+ New project…</option>
        </select>
      </div>
      <div className="flex-1" />
      <div className="flex overflow-hidden rounded-sm border border-line">
        <button
          type="button"
          className={segClass(props.tab === "preview")}
          onClick={() => props.onSelectTab("preview")}
        >
          Live
        </button>
        <button
          type="button"
          className={clsx("border-l border-line", segClass(props.tab === "code"))}
          onClick={() => props.onSelectTab("code")}
        >
          Code
        </button>
      </div>
      <div className="flex-1" />
      {props.deployedSlug && (
        <a
          className="font-mono text-xs text-muted hover:text-indigo"
          href={agentUrl(props.deployedSlug)}
          target="_blank"
          rel="noreferrer"
          title={agentUrl(props.deployedSlug)}
        >
          {agentUrl(props.deployedSlug)} ↗
        </a>
      )}
      <button type="button" className="btn" onClick={props.onSignOut}>
        Change key
      </button>
      <button
        type="button"
        className="btn"
        onClick={props.onToggleSecrets}
        disabled={!props.deployedSlug}
        title={props.deployedSlug ? undefined : "Secrets unlock after the first publish"}
      >
        Secrets
      </button>
      <button
        type="button"
        className="btn btn-primary px-[18px]"
        onClick={props.onTogglePublish}
        disabled={!props.hasBuild}
        title={props.hasBuild ? undefined : "Publish unlocks after your first build"}
      >
        Publish
      </button>
    </header>
  );
}

export function App({ apiKey, onSignOut }: AppProps) {
  const queryClient = useQueryClient();
  const [project, setProject] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [publishOpen, setPublishOpen] = useState(false);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  const status = useQuery<StudioStatus>({ queryKey: ["status"], queryFn: api.status });

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(apiKey),
  });

  // A stale key is the one auth failure worth handling globally.
  useEffect(() => {
    if (projects.error instanceof ApiError && projects.error.status === 401) onSignOut();
  }, [projects.error, onSignOut]);

  const workspace = useQuery<ProjectData>({
    queryKey: ["project", project],
    queryFn: () => api.getProject(apiKey, project as string),
    enabled: project != null,
  });

  // Same global handling for the workspace fetch (see projects above).
  useEffect(() => {
    if (workspace.error instanceof ApiError && workspace.error.status === 401) onSignOut();
  }, [workspace.error, onSignOut]);

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
    queryKey: ["chat", project],
    queryFn: () => api.getChat(apiKey, project as string),
    enabled: project != null,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  // The project's coding-agent sandbox. Brokered once per project open and
  // held for the session; a dead sandbox (evicted, replaced) surfaces as a
  // failed chat send, which invalidates this query to re-broker.
  const chatSession = useQuery<ChatSession>({
    queryKey: ["chat-session", project],
    queryFn: () => api.createChatSession(apiKey, project as string),
    enabled: project != null,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // Friendly tool labels, served by the sandbox (single source of truth —
  // the guest owns the tool set). Sticky: labels are static per build.
  const toolLabels = useQuery<Record<string, string>>({
    queryKey: ["tool-labels", chatSession.data?.url],
    queryFn: () => api.sandboxToolLabels(apiKey, chatSession.data?.url as string),
    enabled: chatSession.data?.url != null,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (chat.error instanceof ApiError && chat.error.status === 401) onSignOut();
  }, [chat.error, onSignOut]);

  // Default to the first project once the list arrives.
  useEffect(() => {
    if (!project && projects.data?.[0]) setProject(projects.data[0]);
  }, [projects.data, project]);

  const files = workspace.data?.files ?? {};
  const deployedSlug = workspace.data?.deployedSlug;
  // "Publish unlocks after your first build" — there must be an agent to ship.
  const hasBuild = project != null && "agent.ts" in files;

  // Default file selection follows the loaded workspace.
  useEffect(() => {
    if (currentFile && currentFile in files) return;
    const entry = "agent.ts" in files ? "agent.ts" : (Object.keys(files)[0] ?? null);
    setCurrentFile(entry);
  }, [files, currentFile]);

  // Refresh server state after agent turns / saves. Deliberately does NOT
  // bump previewNonce: only Publish can change what the live iframe shows,
  // and a reload there kills any in-progress voice session.
  const invalidateWorkspace = () => {
    void queryClient.invalidateQueries({ queryKey: ["project", project] });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
  };

  const createProject = useMutation({
    mutationFn: (name: string) => api.createProject(apiKey, name),
    onSuccess: (created) => {
      setProject(created.name);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (err) => {
      setPendingPrompt(null);
      alert(err instanceof Error ? err.message : String(err));
    },
  });

  const saveFile = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.writeFile(apiKey, project as string, path, content),
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

  const publish = useMutation({
    mutationFn: () => api.deploy(apiKey, project as string),
    onSuccess: (result) => {
      invalidateWorkspace();
      // The published agent changed — reload the live iframe.
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
      const message = err instanceof Error ? err.message : String(err);
      notifyChat(
        `I tried to publish with the Publish button, but aai deploy failed:\n\n${message}`,
        { respond: true },
      );
    },
  });

  const newProject = () => {
    const name = window.prompt("Project name (lowercase, dashes):");
    if (name?.trim()) createProject.mutate(name.trim());
  };

  // Guided start: typing into the chat before any project exists creates
  // one automatically and forwards the prompt once the panel mounts.
  const startWithPrompt = (prompt: string) => {
    // The composer disables while pending; this guard covers the same-tick
    // race (Enter twice before the re-render) so one prompt never creates
    // two projects.
    if (createProject.isPending) return;
    setPendingPrompt(prompt);
    createProject.mutate(generatedProjectName());
  };

  let publishError: string | undefined;
  if (publish.error) {
    publishError = publish.error instanceof Error ? publish.error.message : String(publish.error);
  }
  const publishOutput = publish.data?.output;

  // A failed workspace fetch would otherwise render as an empty project (and
  // a misleading "Publish unlocks after your first build" tooltip).
  let workspaceError: string | undefined;
  if (workspace.error) {
    workspaceError =
      workspace.error instanceof Error ? workspace.error.message : String(workspace.error);
  }

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        project={project}
        projects={projects.data ?? []}
        tab={tab}
        deployedSlug={deployedSlug}
        hasBuild={hasBuild}
        onSelectProject={(name) => {
          setProject(name);
          setCurrentFile(null);
        }}
        onNewProject={newProject}
        onSelectTab={setTab}
        onSignOut={onSignOut}
        onTogglePublish={() => {
          setSecretsOpen(false);
          setPublishOpen((v) => !v);
        }}
        onToggleSecrets={() => {
          setPublishOpen(false);
          setSecretsOpen((v) => !v);
        }}
      />
      <PublishMenu
        open={publishOpen}
        busy={publish.isPending}
        output={publishOutput}
        error={publishError}
        deployedSlug={deployedSlug}
        onPublish={() => publish.mutate()}
        onClose={() => setPublishOpen(false)}
      />
      {secretsOpen && (
        <SecretsPanel
          apiKey={apiKey}
          slug={deployedSlug}
          onNotifyChat={notifyChat}
          onClose={() => setSecretsOpen(false)}
        />
      )}
      {workspaceError && (
        <div className="border-b border-line bg-panel px-5 py-2 text-xs text-err">
          Failed to load project: {workspaceError}
        </div>
      )}
      <main className="flex min-h-0 flex-1">
        <ChatPanel
          key={project ?? "no-project"}
          apiKey={apiKey}
          project={project}
          // undefined = still loading (the panel must not flash "new chat");
          // a failed fetch degrades to an empty history rather than wedging
          // the panel in its loading state.
          chatHistory={chat.data ?? (chat.isError ? [] : undefined)}
          chatSession={chatSession.data}
          sessionError={chatSession.isError}
          toolLabels={toolLabels.data}
          onSessionStale={() => void queryClient.invalidateQueries({ queryKey: ["chat-session"] })}
          llmStatus={status.data}
          creating={createProject.isPending}
          initialPrompt={pendingPrompt}
          onInitialPromptSent={() => setPendingPrompt(null)}
          onStartWithPrompt={startWithPrompt}
          onWorkspaceChanged={invalidateWorkspace}
          onUnauthorized={onSignOut}
          registerNotify={(fn) => {
            notifyChatRef.current = fn;
          }}
        />
        {tab === "preview" ? (
          <PreviewPane
            hasProject={project != null}
            deployedSlug={deployedSlug}
            unpublished={workspace.data?.unpublished}
            nonce={previewNonce}
            onNewProject={newProject}
            onPublish={() => setPublishOpen(true)}
          />
        ) : (
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
      </main>
    </div>
  );
}
