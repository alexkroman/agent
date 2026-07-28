// Copyright 2025 the AAI authors. MIT license.
// Code view — file list on the left, CodeMirror editor on the right.
// Server refreshes (agent edits) update the buffer unless the user has
// unsaved changes.

import { javascript } from "@codemirror/lang-javascript";
import CodeMirror from "@uiw/react-codemirror";
import { useState } from "react";

const extensions = [javascript({ typescript: true })];

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
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <CodeMirror
          value={draft}
          onChange={(value) => {
            setDraft(value);
            setDirty(true);
          }}
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
      <div className="flex items-center gap-2 border-t border-line px-3 py-1.5">
        <button type="button" className="btn" onClick={() => void save()} disabled={!path}>
          Save
        </button>
        <span className="font-mono text-xs text-subtle">
          {path ?? ""}
          {dirty ? " •" : ""}
        </span>
        <span className="text-xs text-subtle">{saveState}</span>
      </div>
    </div>
  );
}

type CodeViewProps = {
  files: Record<string, string>;
  currentFile: string | null;
  onSelectFile: (path: string) => void;
  onSave: (path: string, content: string) => Promise<void>;
};

export function CodeView({ files, currentFile, onSelectFile, onSave }: CodeViewProps) {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-48 flex-col gap-0.5 overflow-y-auto border-r border-line bg-cream p-2">
        {Object.keys(files)
          .sort()
          .map((path) => (
            <button
              type="button"
              key={path}
              className={`cursor-pointer rounded-md border-none px-2 py-1 text-left font-mono text-xs ${
                path === currentFile
                  ? "bg-indigo-50 text-indigo"
                  : "bg-transparent text-fg hover:bg-disabled"
              }`}
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
    </div>
  );
}
