// Copyright 2026 the AAI authors. MIT license.
/**
 * Unsaved editor work, held ABOVE the editor.
 *
 * This is the one place user work can be lost, and for a long time the state
 * that was supposed to protect it could not: the buffer lived inside
 * `FileBuffer`, which is mounted `key={currentFile}` under a `CodeView` that
 * the pane switcher renders as `{tab === "code" && …}`. So the `dirty` flag and
 * the `conflict` warning were computed by a component that React unmounts —
 * silently, with no confirm and no lift-up — the moment the user clicks
 * Preview or picks another file. Typing into the editor and switching panes
 * threw the edit away and reported nothing.
 *
 * Lifting the buffers here is the fix, over the two alternatives:
 *
 * - **A confirm** needs the dirty flag to have already survived the unmount,
 *   so it is this plus a dialog — and a dialog every time you glance at the
 *   preview is a worse editor than one that just keeps your text.
 * - **Keeping `CodeView` mounted** (hidden) preserves the pane switch and NOT
 *   the file switch, which is half the bug, and it pins CodeMirror — the bulk
 *   of the bundle, and lazily loaded for that reason — into a `display: none`
 *   subtree it has to re-measure on every re-show.
 *
 * The buffers therefore live in the project view, which is mounted for as long
 * as the project is open. `beforeunload` covers what outlives even that (a
 * reload, a closed tab); a project switch is deliberately not guarded, because
 * it is the same navigation the browser prompt covers and the drafts go with
 * the project they belong to.
 *
 * The sync rule is a pure function ({@link syncBuffers}) rather than an effect,
 * so what happens to your text when the agent edits the same file is decided by
 * something a test can call directly.
 */

import { useEffect, useState } from "react";

/** One file's editor state. Absent from the map until the user types. */
export type FileBufferState = {
  /** What the editor shows. */
  readonly draft: string;
  /** The draft differs from the last thing written to the server. */
  readonly dirty: boolean;
  /** The file changed on the server while the user had unsaved edits. */
  readonly conflict: boolean;
  /**
   * The server content this buffer last reconciled against. A CHANGE in it is
   * what triggers an adopt (clean) or a conflict (dirty) — not equality with
   * `draft`, which would clobber a just-saved buffer with the pre-save content
   * every refetch until the workspace catches up.
   */
  readonly lastServer: string;
};

export type FileBuffers = Readonly<Record<string, FileBufferState>>;

/**
 * Reconcile every open buffer against the workspace as the server now has it.
 *
 * A clean buffer ADOPTS the server's version (that is how an agent edit shows
 * up in an editor nobody is typing in); a dirty one keeps the user's text and
 * raises `conflict`, so the Save button says out loud that it will overwrite
 * the agent's newer version. Returns the same object when nothing moved, so
 * the render-time sync below is a no-op on the overwhelming majority of
 * renders.
 */
export function syncBuffers(buffers: FileBuffers, files: Record<string, string>): FileBuffers {
  let changed = false;
  const next: Record<string, FileBufferState> = {};
  for (const [path, buffer] of Object.entries(buffers)) {
    const server = files[path] ?? "";
    if (server === buffer.lastServer) {
      next[path] = buffer;
      continue;
    }
    changed = true;
    next[path] = buffer.dirty
      ? { ...buffer, lastServer: server, conflict: true }
      : { ...buffer, lastServer: server, draft: server };
  }
  return changed ? next : buffers;
}

/** The buffer to render for `path`, defaulted from the server's content. */
export function bufferFor(
  buffers: FileBuffers,
  path: string | null,
  files: Record<string, string>,
): FileBufferState {
  const server = (path === null ? undefined : files[path]) ?? "";
  const held = path === null ? undefined : buffers[path];
  return held ?? { draft: server, dirty: false, conflict: false, lastServer: server };
}

/** Is anything unsaved right now? The question `beforeunload` asks. */
export function anyDirty(buffers: FileBuffers): boolean {
  return Object.values(buffers).some((buffer) => buffer.dirty);
}

export type FileDrafts = {
  readonly buffers: FileBuffers;
  /** The user typed into `path`. */
  readonly edit: (path: string, value: string) => void;
  /** `path`'s draft reached the server — it is the new baseline. */
  readonly markSaved: (path: string) => void;
};

/**
 * Hold every open file's buffer for the life of the project view.
 *
 * `files` is the workspace as the server last reported it; the reconcile is
 * done during render ("adjust state during render", the React docs pattern the
 * old in-component version already used) rather than in an effect, so the
 * editor never paints one frame of the pre-reconcile buffer.
 */
export function useFileDrafts(files: Record<string, string>): FileDrafts {
  const [buffers, setBuffers] = useState<FileBuffers>({});

  const synced = syncBuffers(buffers, files);
  if (synced !== buffers) setBuffers(synced);

  // The last line of defence, and the only one that can cover a reload or a
  // closed tab: everything else about this hook is about surviving an unmount
  // inside the app, which a page teardown is not.
  const dirty = anyDirty(synced);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  return {
    buffers: synced,
    edit: (path, value) =>
      setBuffers((current) => {
        const held = current[path];
        return {
          ...current,
          [path]: {
            draft: value,
            dirty: true,
            // A conflict already raised survives further typing: the user has
            // been told the save will overwrite, and typing is not an
            // acknowledgement of that.
            conflict: held?.conflict ?? false,
            lastServer: held?.lastServer ?? files[path] ?? "",
          },
        };
      }),
    markSaved: (path) =>
      setBuffers((current) => {
        const held = current[path];
        if (held === undefined) return current;
        // Saving is the user's explicit choice — overwrite acknowledged. The
        // draft stays put: the workspace refetch has not landed yet, so
        // adopting `lastServer` here would revert the buffer to the content
        // that was just replaced.
        return { ...current, [path]: { ...held, dirty: false, conflict: false } };
      }),
  };
}
