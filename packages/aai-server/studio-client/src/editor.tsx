// Copyright 2025 the AAI authors. MIT license.
// File editor pane — CodeMirror with TypeScript highlighting, plus the
// deploy panel. Server refreshes (agent edits) update the buffer unless the
// user has unsaved changes.

import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { useState } from "react";

const extensions = [javascript({ typescript: true })];

type EditorPaneProps = {
  files: Record<string, string>;
  currentFile: string | null;
  onSelectFile: (path: string) => void;
  onSave: (path: string, content: string) => Promise<void>;
  deploy: {
    busy: boolean;
    error?: string;
    deployedSlug?: string;
    secrets: string;
    onSecretsChange: (value: string) => void;
    onDeploy: () => void;
  };
};

type FileBufferProps = {
  path: string | null;
  serverContent: string;
  onSave: (path: string, content: string) => Promise<void>;
};

/**
 * One open file. Mounted with `key={path}` so switching files resets the
 * buffer; external (agent) updates are adopted during render unless the
 * user has unsaved edits.
 */
function FileBuffer({ path, serverContent, onSave }: FileBufferProps) {
  const [draft, setDraft] = useState(serverContent);
  const [dirty, setDirty] = useState(false);
  const [lastServer, setLastServer] = useState(serverContent);
  const [saveState, setSaveState] = useState("");

  // "Adjust state during render" (React docs pattern) — no effect needed.
  if (serverContent !== lastServer) {
    setLastServer(serverContent);
    if (!dirty) setDraft(serverContent);
  }

  const save = async () => {
    if (!path) return;
    try {
      await onSave(path, draft);
      setDirty(false);
      setSaveState("saved");
    } catch (err) {
      setSaveState(err instanceof Error ? err.message : "save failed");
    }
    setTimeout(() => setSaveState(""), 1500);
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-line">
        <CodeMirror
          value={draft}
          onChange={(value) => {
            setDraft(value);
            setDirty(true);
          }}
          theme={oneDark}
          extensions={extensions}
          editable={path != null}
          height="100%"
          style={{ height: "100%" }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault();
              void save();
            }
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn" onClick={() => void save()} disabled={!path}>
          Save
        </button>
        <span className="text-xs text-dim">
          {path ?? ""}
          {dirty ? " •" : ""}
        </span>
        <span className="text-xs text-dim">{saveState}</span>
      </div>
    </>
  );
}

export function EditorPane({ files, currentFile, onSelectFile, onSave, deploy }: EditorPaneProps) {
  return (
    <div className="flex min-w-0 flex-[1.3] flex-col gap-2 border-r border-line p-2">
      <div className="flex flex-wrap gap-1">
        {Object.keys(files)
          .sort()
          .map((path) => (
            <button
              type="button"
              key={path}
              className={`btn font-mono text-xs ${path === currentFile ? "border-accent" : ""}`}
              onClick={() => onSelectFile(path)}
            >
              {path}
            </button>
          ))}
      </div>
      <FileBuffer
        key={currentFile ?? ""}
        path={currentFile}
        serverContent={currentFile ? (files[currentFile] ?? "") : ""}
        onSave={onSave}
      />
      <div className="flex flex-col gap-1.5 rounded-md border border-line p-2.5">
        <h2 className="pane-title">Deploy</h2>
        <textarea
          className="field h-14 resize-none font-mono text-xs"
          value={deploy.secrets}
          onChange={(e) => deploy.onSecretsChange(e.target.value)}
          placeholder="Secrets, one per line: ASSEMBLYAI_API_KEY=..."
          spellCheck={false}
        />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="btn btn-primary"
            onClick={deploy.onDeploy}
            disabled={deploy.busy}
          >
            {deploy.busy ? "Deploying…" : "Build & Deploy"}
          </button>
          <span className="text-[13px]">
            {deploy.error ? (
              <span className="text-err">{deploy.error}</span>
            ) : (
              deploy.deployedSlug && (
                <a
                  className="text-accent"
                  href={`/${deploy.deployedSlug}/`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Live: /{deploy.deployedSlug}/
                </a>
              )
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
