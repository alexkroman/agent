// Copyright 2025 the AAI authors. MIT license.
// Code view — file navigation plus a CodeMirror editor. Small workspaces get
// file tabs across the top; past FILE_TAB_LIMIT files the tabs become a
// vertical sidebar grouped by directory, because a strip of dozens of tabs
// is unscannable and forces horizontal scrolling. Server refreshes (agent
// edits) update the buffer unless the user has unsaved changes.

import { javascript } from "@codemirror/lang-javascript";
import CodeMirror from "@uiw/react-codemirror";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

const extensions = [javascript({ typescript: true })];

/**
 * Buffer state for one open file: external (agent) updates are adopted
 * unless the user has unsaved edits, in which case `conflict` flags that a
 * save would overwrite the server's newer version. Exported for tests —
 * this is the one place user work can be lost.
 */
export function useFileDraft(serverContent: string): {
  draft: string;
  dirty: boolean;
  /** The file changed on the server while the user had unsaved edits. */
  conflict: boolean;
  edit: (value: string) => void;
  /** The draft was written to the server — it is the new baseline. */
  markSaved: () => void;
} {
  const [draft, setDraft] = useState(serverContent);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [lastServer, setLastServer] = useState(serverContent);

  // "Adjust state during render" (React docs pattern) — no effect needed.
  if (serverContent !== lastServer) {
    setLastServer(serverContent);
    if (dirty) {
      setConflict(true);
    } else {
      // A clean buffer is never in conflict (only markSaved clears `dirty`,
      // and it clears `conflict` too), so adopting is all that's needed.
      setDraft(serverContent);
    }
  }

  return {
    draft,
    dirty,
    conflict,
    edit: (value) => {
      setDraft(value);
      setDirty(true);
    },
    markSaved: () => {
      // Saving is the user's explicit choice — overwrite acknowledged.
      setDirty(false);
      setConflict(false);
    },
  };
}

type FileBufferProps = {
  path: string | null;
  serverContent: string;
  onSave: (path: string, content: string) => Promise<void>;
};

/** One open file. Mounted with `key={path}` so switching files resets the buffer. */
function FileBuffer({ path, serverContent, onSave }: FileBufferProps) {
  const { draft, dirty, conflict, edit, markSaved } = useFileDraft(serverContent);
  const [saveState, setSaveState] = useState("");
  const saveStateTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // One live timer at a time, and none after unmount.
  const flashSaveState = (text: string) => {
    setSaveState(text);
    clearTimeout(saveStateTimer.current);
    saveStateTimer.current = setTimeout(() => setSaveState(""), 1500);
  };
  useEffect(() => () => clearTimeout(saveStateTimer.current), []);

  const save = async () => {
    if (!path) return;
    try {
      await onSave(path, draft);
      markSaved();
      flashSaveState("saved");
    } catch (err) {
      flashSaveState(err instanceof Error ? err.message : "save failed");
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <CodeMirror
          value={draft}
          onChange={edit}
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
        {conflict && (
          <span className="text-xs text-err">
            changed on the server — saving will overwrite the agent's version
          </span>
        )}
        <span className="text-xs text-subtle">{saveState}</span>
      </div>
    </div>
  );
}

/**
 * Above this many files the tab strip becomes a sidebar list. Tabs are the
 * right shape for a handful of files; a template-sized workspace (20+ tool
 * files) turns them into an endless horizontal scroll.
 */
export const FILE_TAB_LIMIT = 8;

type FileNavProps = {
  paths: string[];
  currentFile: string | null;
  onSelectFile: (path: string) => void;
};

/** File navigation: tabs when few files, a directory-grouped sidebar when many. */
export function FileNav({ paths, currentFile, onSelectFile }: FileNavProps) {
  if (paths.length <= FILE_TAB_LIMIT) {
    return (
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
    );
  }

  // Group by directory, root files first — a flat sorted list interleaves
  // root files with directories, which reads as disorder at this size.
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash);
    const entries = groups.get(dir);
    if (entries) {
      entries.push(path);
    } else {
      groups.set(dir, [path]);
    }
  }
  const dirs = [...groups.keys()].sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });

  return (
    <nav
      aria-label="Workspace files"
      className="w-52 shrink-0 overflow-y-auto border-r border-line bg-cream py-1"
    >
      {dirs.map((dir) => (
        <div key={dir || "/"}>
          {dir && (
            <div
              className="truncate px-3 pt-2 pb-0.5 font-mono text-[10px] text-subtle"
              title={dir}
            >
              {dir}/
            </div>
          )}
          {(groups.get(dir) ?? []).map((path) => {
            const active = path === currentFile;
            return (
              <button
                type="button"
                key={path}
                aria-current={active ? "true" : undefined}
                title={path}
                className={clsx(
                  "block w-full cursor-pointer truncate border-0 px-3 py-1 text-left font-mono text-[11px]",
                  dir && "pl-5",
                  active ? "bg-panel text-indigo" : "bg-transparent text-subtle hover:text-fg",
                )}
                onClick={() => onSelectFile(path)}
              >
                {path.slice(path.lastIndexOf("/") + 1)}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
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
  // min-w-0 matters in both modes: without it the nav's intrinsic width
  // propagates up the flex tree and stretches the whole page sideways.
  const sidebar = paths.length > FILE_TAB_LIMIT;
  return (
    <div className={clsx("flex min-h-0 min-w-0 flex-1", sidebar ? "flex-row" : "flex-col")}>
      <FileNav paths={paths} currentFile={currentFile} onSelectFile={onSelectFile} />
      <FileBuffer
        key={currentFile ?? ""}
        path={currentFile}
        serverContent={currentFile ? (files[currentFile] ?? "") : ""}
        onSave={onSave}
      />
    </div>
  );
}
