// Copyright 2025 the AAI authors. MIT license.
// Code view — file tabs across the top, CodeMirror editor below. A workspace
// is one or two files, so a full sidebar column spent width to list them.
// Server refreshes (agent edits) update the buffer unless the user has
// unsaved changes.

import { javascript } from "@codemirror/lang-javascript";
import CodeMirror from "@uiw/react-codemirror";
import clsx from "clsx";
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
  const paths = Object.keys(files).sort();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Workspace files"
        className="flex shrink-0 overflow-x-auto border-b border-line bg-cream"
      >
        {paths.map((path) => {
          const active = path === currentFile;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={active}
              key={path}
              className={clsx(
                "shrink-0 cursor-pointer border-x-0 border-t-0 border-b-2 px-3 py-2 font-mono text-[11px]",
                active
                  ? "border-indigo bg-panel text-indigo"
                  : "border-transparent bg-transparent text-subtle hover:text-fg",
              )}
              onClick={() => onSelectFile(path)}
            >
              {path}
            </button>
          );
        })}
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
