// Copyright 2025 the AAI authors. MIT license.
// Studio layout (Lovable-style): chat on the left; a Preview/Code pane on
// the right; project picker + Publish in the top bar. TanStack Query owns
// all server state, invalidated after agent turns / publishes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, api, type ProjectData, parseSecrets, type StudioStatus } from "./api.ts";
import { ChatPanel } from "./chat.tsx";
import { CodeView } from "./code-view.tsx";
import { PreviewPane } from "./preview.tsx";

type AppProps = { apiKey: string; onSignOut: () => void };

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
    <div className="absolute top-12 right-4 z-10 flex w-80 flex-col gap-2 rounded-xl border border-line bg-panel p-4 shadow-lg">
      <p className="m-0 text-[13px] font-medium">Publish this agent</p>
      <p className="m-0 text-xs text-dim">
        Builds the workspace, verifies it in a sandbox, and puts it live. Secrets (like
        ASSEMBLYAI_API_KEY) are stored with the deployment.
      </p>
      <textarea
        className="field h-16 resize-none font-mono text-xs"
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
          className="text-xs text-accent"
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

export function App({ apiKey, onSignOut }: AppProps) {
  const queryClient = useQueryClient();
  const [project, setProject] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [publishOpen, setPublishOpen] = useState(false);
  const [secrets, setSecrets] = useState("");
  const [previewNonce, setPreviewNonce] = useState(0);

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
    onError: (err) => alert(err instanceof Error ? err.message : String(err)),
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

  let publishError: string | undefined;
  if (publish.error) {
    publishError = publish.error instanceof Error ? publish.error.message : String(publish.error);
  }

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-accent" aria-hidden />
        <select
          className="field cursor-pointer border-none bg-transparent pl-0 font-medium"
          value={project ?? ""}
          onChange={(e) => {
            setProject(e.target.value);
            setCurrentFile(null);
          }}
        >
          {(projects.data ?? []).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          {(projects.data ?? []).length === 0 && <option value="">no projects</option>}
        </select>
        <button type="button" className="btn" onClick={newProject}>
          + New
        </button>
        <div className="ml-2 flex items-center gap-1 rounded-full border border-line p-0.5">
          <button
            type="button"
            className={`seg ${tab === "preview" ? "seg-active" : ""}`}
            onClick={() => setTab("preview")}
          >
            Preview
          </button>
          <button
            type="button"
            className={`seg ${tab === "code" ? "seg-active" : ""}`}
            onClick={() => setTab("code")}
          >
            Code
          </button>
        </div>
        <div className="flex-1" />
        {deployedSlug && (
          <a
            className="font-mono text-xs text-dim hover:text-accent"
            href={`/${deployedSlug}/`}
            target="_blank"
            rel="noreferrer"
          >
            /{deployedSlug}/ ↗
          </a>
        )}
        <button type="button" className="btn" onClick={onSignOut}>
          Change key
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setPublishOpen((v) => !v)}
          disabled={!project}
        >
          Publish
        </button>
      </header>
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
        {project ? (
          <ChatPanel
            key={project}
            apiKey={apiKey}
            project={project}
            llmStatus={status.data ?? { llm: false }}
            onWorkspaceChanged={invalidateWorkspace}
          />
        ) : (
          <div className="flex w-[400px] shrink-0 flex-col gap-2 border-r border-line p-4">
            <p className="m-0 text-[15px] font-medium">Welcome to AAI Studio</p>
            <p className="m-0 text-[13px] text-dim">Create a project to start building.</p>
            <button type="button" className="btn btn-primary self-start" onClick={newProject}>
              + New project
            </button>
          </div>
        )}
        {tab === "preview" ? (
          <PreviewPane
            deployedSlug={deployedSlug}
            nonce={previewNonce}
            onPublish={() => setPublishOpen(true)}
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
