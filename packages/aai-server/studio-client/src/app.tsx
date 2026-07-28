// Copyright 2025 the AAI authors. MIT license.
// Studio shell (design 1b "Guided start"): shared top bar, 360px guided
// chat panel on the left, Preview/Code pane on the right. TanStack Query
// owns all server state, invalidated after agent turns / publishes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, api, type ProjectData, parseSecrets, type StudioStatus } from "./api.ts";
import logoUrl from "./assets/assemblyai-logomark.svg";
import { ChatPanel } from "./chat.tsx";
import { CodeView } from "./code-view.tsx";
import { PreviewPane } from "./preview.tsx";

type AppProps = { apiKey: string; onSignOut: () => void };

const NEW_PROJECT_SENTINEL = "__new__";

/** Generated name for the guided "just start typing" flow. */
function generatedProjectName(): string {
  return `voice-agent-${Math.random().toString(36).slice(2, 6)}`;
}

type PublishMenuProps = {
  open: boolean;
  busy: boolean;
  error?: string | undefined;
  deployedSlug?: string | undefined;
  secrets: string;
  onSecretsChange: (value: string) => void;
  onPublish: () => void;
  onClose: () => void;
};

function PublishMenu(props: PublishMenuProps) {
  if (!props.open) return null;
  return (
    <div className="absolute top-14 right-5 z-10 flex w-80 flex-col gap-3 rounded-lg border border-line bg-panel p-5 shadow-md">
      <span className="eyebrow">Publish</span>
      <p className="m-0 text-[13px] leading-5 text-muted">
        Builds the workspace, verifies it in a sandbox, and puts it live. Secrets (like
        ASSEMBLYAI_API_KEY) are stored with the deployment.
      </p>
      <textarea
        className="field h-16 resize-none py-2 font-mono text-xs"
        value={props.secrets}
        onChange={(e) => props.onSecretsChange(e.target.value)}
        placeholder="ASSEMBLYAI_API_KEY=..."
        spellCheck={false}
      />
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
      {props.error && <p className="m-0 text-xs text-err">{props.error}</p>}
      {props.deployedSlug && !props.error && (
        <a
          className="font-mono text-xs text-indigo"
          href={`/${props.deployedSlug}/`}
          target="_blank"
          rel="noreferrer"
        >
          Live at /{props.deployedSlug}/
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
};

/** Shared 60px top bar (all 1x options): brand, switcher, segmented, actions. */
function TopBar(props: TopBarProps) {
  const segClass = (active: boolean) =>
    `seg ${active ? "bg-fg text-cream" : "bg-panel text-muted hover:text-fg"}`;
  return (
    <header className="flex h-[60px] flex-none items-center gap-3.5 border-b border-line bg-panel px-5">
      <div className="flex items-center gap-2.5">
        <img src={logoUrl} alt="AssemblyAI" className="h-5 w-5" />
        <span className="font-serif text-[17px]">AAI Studio</span>
      </div>
      <div className="h-[22px] w-px bg-line" aria-hidden />
      <div className="flex h-[34px] items-center gap-2 rounded-sm border border-line bg-panel pl-3 hover:border-line-strong">
        <span
          className={`h-[7px] w-[7px] flex-none rounded-full ${props.project ? "bg-indigo" : "bg-warm-300"}`}
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
          Preview
        </button>
        <button
          type="button"
          className={`border-l border-line ${segClass(props.tab === "code")}`}
          onClick={() => props.onSelectTab("code")}
        >
          Code
        </button>
      </div>
      <div className="flex-1" />
      {props.deployedSlug && (
        <a
          className="font-mono text-xs text-muted hover:text-indigo"
          href={`/${props.deployedSlug}/`}
          target="_blank"
          rel="noreferrer"
        >
          /{props.deployedSlug}/ ↗
        </a>
      )}
      <button type="button" className="btn" onClick={props.onSignOut}>
        Change key
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
  const [secrets, setSecrets] = useState("");
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

  // Default to the first project once the list arrives.
  useEffect(() => {
    if (!project && projects.data?.[0]) setProject(projects.data[0]);
  }, [projects.data, project]);

  const workspace = useQuery<ProjectData>({
    queryKey: ["project", project],
    queryFn: () => api.getProject(apiKey, project as string),
    enabled: project != null,
  });
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

  const invalidateWorkspace = () => {
    void queryClient.invalidateQueries({ queryKey: ["project", project] });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    // The agent may have redeployed — reload the live preview.
    setPreviewNonce((n) => n + 1);
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
  });

  const publish = useMutation({
    mutationFn: () => api.deploy(apiKey, project as string, parseSecrets(secrets)),
    onSuccess: () => {
      invalidateWorkspace();
      setPublishOpen(false);
      setTab("preview");
    },
  });

  const newProject = () => {
    const name = window.prompt("Project name (lowercase, dashes):");
    if (name?.trim()) createProject.mutate(name.trim());
  };

  // Guided start: typing into the chat before any project exists creates
  // one automatically and forwards the prompt once the panel mounts.
  const startWithPrompt = (prompt: string) => {
    setPendingPrompt(prompt);
    createProject.mutate(generatedProjectName());
  };

  let publishError: string | undefined;
  if (publish.error) {
    publishError = publish.error instanceof Error ? publish.error.message : String(publish.error);
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
        onTogglePublish={() => setPublishOpen((v) => !v)}
      />
      <PublishMenu
        open={publishOpen}
        busy={publish.isPending}
        error={publishError}
        deployedSlug={deployedSlug}
        secrets={secrets}
        onSecretsChange={setSecrets}
        onPublish={() => publish.mutate()}
        onClose={() => setPublishOpen(false)}
      />
      <main className="flex min-h-0 flex-1">
        <ChatPanel
          key={project ?? "no-project"}
          apiKey={apiKey}
          project={project}
          llmStatus={status.data ?? { llm: false }}
          initialPrompt={pendingPrompt}
          onInitialPromptSent={() => setPendingPrompt(null)}
          onStartWithPrompt={startWithPrompt}
          onWorkspaceChanged={invalidateWorkspace}
        />
        {tab === "preview" ? (
          <PreviewPane
            hasProject={project != null}
            deployedSlug={deployedSlug}
            nonce={previewNonce}
            onNewProject={newProject}
          />
        ) : (
          <CodeView
            files={files}
            currentFile={currentFile}
            onSelectFile={setCurrentFile}
            onSave={async (path, content) => {
              await saveFile.mutateAsync({ path, content });
            }}
          />
        )}
      </main>
    </div>
  );
}
