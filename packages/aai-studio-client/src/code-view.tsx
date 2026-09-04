// Copyright 2025 the AAI authors. MIT license.
// Code view — a directory-grouped file sidebar plus a CodeMirror editor.
// (Files used to be horizontal tabs, which assumed a one-or-two-file
// workspace; a template-sized project made the strip an endless horizontal
// scroll.) Server refreshes (agent edits) update the buffer unless the
// user has unsaved changes.

import { useFlash } from "@alexkroman1/aai-ui";
import { javascript } from "@codemirror/lang-javascript";
import CodeMirror from "@uiw/react-codemirror";
import clsx from "clsx";
import { errorText } from "./api-error.ts";
import type { FileBufferState } from "./file-drafts.ts";

const extensions = [javascript({ typescript: true })];

type FileBufferProps = {
  path: string | null;
  /**
   * This file's buffer, owned by the project view rather than by this
   * component. It has to outlive both the `key={path}` remount below and the
   * pane switcher unmounting `CodeView` entirely — see file-drafts.ts.
   */
  buffer: FileBufferState;
  onEdit: (path: string, value: string) => void;
  onSave: (path: string, content: string) => Promise<void>;
};

/** One open file. Keyed by path so CodeMirror itself resets on a file switch. */
function FileBuffer({ path, buffer, onEdit, onSave }: FileBufferProps) {
  const { draft, dirty, conflict } = buffer;
  const { value: saveState, flash: flashSaveState } = useFlash<string>();

  const save = async () => {
    if (!path) return;
    try {
      await onSave(path, draft);
      flashSaveState("saved");
    } catch (err) {
      // `errorText`, not a local `instanceof Error` ternary: react-query and
      // `fetch` both reject with values that carry a message without being
      // `Error` instances, and the ternary rendered those as "[object Object]".
      flashSaveState(errorText(err) ?? "save failed");
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <CodeMirror
          value={draft}
          onChange={(value) => {
            if (path !== null) onEdit(path, value);
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
        {conflict && (
          <span className="text-xs text-err">
            changed on the server — saving will overwrite the agent's version
          </span>
        )}
        <span className="text-xs text-subtle">{saveState ?? ""}</span>
      </div>
    </div>
  );
}

type FileNavProps = {
  paths: string[];
  currentFile: string | null;
  onSelectFile: (path: string) => void;
};

/** File navigation: a directory-grouped sidebar list. */
export function FileNav({ paths, currentFile, onSelectFile }: FileNavProps) {
  // Group by directory, root files first — a flat sorted list interleaves
  // root files with directories, which reads as disorder.
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
  // Sorted entries rather than sorted keys: mapping over them below needs no
  // second `groups.get(dir)` lookup, and so no `?? []` fallback standing in for
  // a miss that cannot happen.
  const dirs = [...groups].sort(([a], [b]) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });

  return (
    <nav
      aria-label="Workspace files"
      className="w-52 shrink-0 overflow-y-auto border-r border-line bg-cream py-1"
    >
      {dirs.map(([dir, entries]) => (
        <div key={dir || "/"}>
          {dir && (
            <div
              className="truncate px-3 pt-2 pb-0.5 font-mono text-[10px] text-subtle"
              title={dir}
            >
              {dir}/
            </div>
          )}
          {entries.map((path) => {
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
  /** The open file's buffer — held by the project view, not by this pane. */
  buffer: FileBufferState;
  onSelectFile: (path: string) => void;
  onEdit: (path: string, value: string) => void;
  onSave: (path: string, content: string) => Promise<void>;
};

export function CodeView({
  files,
  currentFile,
  buffer,
  onSelectFile,
  onEdit,
  onSave,
}: CodeViewProps) {
  const paths = Object.keys(files).sort();
  // min-w-0 matters: without it the nav's intrinsic width propagates up
  // the flex tree and stretches the whole page sideways.
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <FileNav paths={paths} currentFile={currentFile} onSelectFile={onSelectFile} />
      <FileBuffer
        key={currentFile ?? ""}
        path={currentFile}
        buffer={buffer}
        onEdit={onEdit}
        onSave={onSave}
      />
    </div>
  );
}
