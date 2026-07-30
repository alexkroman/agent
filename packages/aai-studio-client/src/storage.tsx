// Copyright 2026 the AAI authors. MIT license.
// Per-project Storage toggle: gives the app a Supabase Postgres database its
// tools reach via `ctx.db`. Lives in the Publish menu because storage is a
// project-level setting on the *published* agent — a 409 from the server
// means "never published", which this control renders as a hint rather than
// a failure (mirroring how the Live pane explains an unpublished project).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "./api.ts";

export const DISABLE_STORAGE_WARNING =
  "Disable storage? This deletes the app's database and ALL of its data. This cannot be undone.";

type StorageState = {
  enabled: boolean;
  /** Project has never been published — storage is gated on a first publish. */
  unpublished: boolean;
};

export function storageQueryKey(project: string): readonly unknown[] {
  return ["storage", project];
}

type StorageControlProps = { apiKey: string; project: string };

export function StorageControl({ apiKey, project }: StorageControlProps) {
  const queryClient = useQueryClient();

  const storage = useQuery<StorageState>({
    queryKey: storageQueryKey(project),
    queryFn: async () => {
      try {
        const { enabled } = await api.getStorage(apiKey, project);
        return { enabled, unpublished: false };
      } catch (err) {
        // 409 is a state ("publish first"), not a failure — don't retry it
        // or paint it red.
        if (err instanceof ApiError && err.status === 409) {
          return { enabled: false, unpublished: true };
        }
        throw err;
      }
    },
  });

  // Settled, not just success: a failed toggle should re-sync with the
  // server's actual state rather than trust the last render.
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: storageQueryKey(project) });
  const enable = useMutation({
    mutationFn: () => api.enableStorage(apiKey, project),
    onSettled: invalidate,
  });
  const disable = useMutation({
    mutationFn: () => api.disableStorage(apiKey, project),
    onSettled: invalidate,
  });

  const state = storage.data;
  const busy = enable.isPending || disable.isPending;

  const onToggle = () => {
    if (!state || state.unpublished || busy) return;
    if (state.enabled) {
      // Destructive: dropping the database deletes all of the app's data.
      if (!window.confirm(DISABLE_STORAGE_WARNING)) return;
      disable.mutate();
    } else {
      enable.mutate();
    }
  };

  const error = storage.error ?? enable.error ?? disable.error;
  let errorText: string | undefined;
  if (error) {
    errorText = error instanceof Error ? error.message : String(error);
  }

  let buttonLabel = "Enable storage";
  if (busy) buttonLabel = "Working…";
  else if (state?.enabled) buttonLabel = "Disable storage…";

  let statusLabel = "Checking…";
  if (state) statusLabel = state.enabled ? "Enabled" : "Disabled";
  else if (storage.error) statusLabel = "Unavailable";

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex items-center gap-2">
        <span className="eyebrow">Storage</span>
        <span className="ml-auto text-xs text-muted">{statusLabel}</span>
      </div>
      <p className="m-0 text-[13px] leading-5 text-muted">
        Gives this app a Supabase database (ctx.db).
      </p>
      {state?.unpublished && (
        <p className="m-0 text-xs text-muted">Publish the project first to enable storage.</p>
      )}
      <button
        type="button"
        className="btn self-start"
        onClick={onToggle}
        disabled={storage.isPending || state?.unpublished || busy}
        title={state?.unpublished ? "Publish the project first" : undefined}
      >
        {buttonLabel}
      </button>
      {errorText && <p className="m-0 text-xs text-err">{errorText}</p>}
    </div>
  );
}
