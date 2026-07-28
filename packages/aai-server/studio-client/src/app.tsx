// Copyright 2025 the AAI authors. MIT license.
// Studio layout — TanStack Query owns all server state (projects, files,
// status); invalidation after agent turns / deploys keeps panes in sync.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, api, type ProjectData, parseSecrets, type StudioStatus } from "./api.ts";
import { ChatPanel } from "./chat.tsx";
import { EditorPane } from "./editor.tsx";

type AppProps = { apiKey: string; onSignOut: () => void };

export function App({ apiKey, onSignOut }: AppProps) {
  const queryClient = useQueryClient();
  const [project, setProject] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [newProject, setNewProject] = useState("");
  const [secrets, setSecrets] = useState("");

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

  // Default file selection follows the loaded workspace.
  useEffect(() => {
    if (currentFile && currentFile in files) return;
    const entry = "agent.ts" in files ? "agent.ts" : (Object.keys(files)[0] ?? null);
    setCurrentFile(entry);
  }, [files, currentFile]);

  const invalidateWorkspace = () => {
    void queryClient.invalidateQueries({ queryKey: ["project", project] });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
  };

  const createProject = useMutation({
    mutationFn: (name: string) => api.createProject(apiKey, name),
    onSuccess: (created) => {
      setNewProject("");
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

  const deploy = useMutation({
    mutationFn: () => api.deploy(apiKey, project as string, parseSecrets(secrets)),
    onSuccess: invalidateWorkspace,
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <h1 className="m-0 text-[15px] font-semibold">
          <span className="text-accent">AAI</span> Studio
        </h1>
        <div className="flex-1" />
        <button type="button" className="btn" onClick={onSignOut}>
          Change key
        </button>
      </header>
      <main className="flex min-h-0 flex-1">
        <div className="flex w-52 flex-col gap-2 border-r border-line bg-panel p-2.5">
          <h2 className="pane-title">Projects</h2>
          <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
            {(projects.data ?? []).map((name) => (
              <button
                type="button"
                key={name}
                className={`cursor-pointer rounded-md border-none px-2 py-1 text-left text-[13px] ${
                  name === project ? "bg-accent text-white" : "bg-transparent hover:bg-ink"
                }`}
                onClick={() => setProject(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            <input
              className="field min-w-0 flex-1"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newProject.trim()) {
                  createProject.mutate(newProject.trim());
                }
              }}
              placeholder="new-project-name"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn"
              title="Create project"
              disabled={createProject.isPending}
              onClick={() => newProject.trim() && createProject.mutate(newProject.trim())}
            >
              +
            </button>
          </div>
        </div>
        <EditorPane
          files={files}
          currentFile={currentFile}
          onSelectFile={setCurrentFile}
          onSave={async (path, content) => {
            await saveFile.mutateAsync({ path, content });
          }}
          deploy={{
            busy: deploy.isPending,
            ...(deploy.error && {
              error: deploy.error instanceof Error ? deploy.error.message : String(deploy.error),
            }),
            ...(workspace.data?.deployedSlug && { deployedSlug: workspace.data.deployedSlug }),
            secrets,
            onSecretsChange: setSecrets,
            onDeploy: () => deploy.mutate(),
          }}
        />
        {project ? (
          <ChatPanel
            key={project}
            apiKey={apiKey}
            project={project}
            llmStatus={status.data ?? { llm: false }}
            onWorkspaceChanged={invalidateWorkspace}
          />
        ) : (
          <div className="flex flex-1 flex-col gap-2 p-2.5">
            <h2 className="pane-title">Coding agent</h2>
            <p className="text-dim">Create a project to start.</p>
          </div>
        )}
      </main>
    </div>
  );
}
