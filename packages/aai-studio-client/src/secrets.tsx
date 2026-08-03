// Copyright 2026 the AAI authors. MIT license.
// Deployed-agent secrets panel — its own UI, not part of Publish. Talks to
// the platform's own `/:slug/secret` routes (the exact ones `aai secret`
// uses), so it needs a published slug to attach secrets to. Every change
// posts a note into the chat (values withheld) so the coding agent knows
// which keys exist without ever seeing them.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorText, parseSecrets } from "./api.ts";
import { queryKeys } from "./query-keys.ts";

type SecretsPanelProps = {
  apiKey: string;
  /** The open project's name — the target of the Delete project button. */
  project: string;
  /** The project's published slug; undefined until the first publish. */
  slug: string | undefined;
  /**
   * The project's auto-deployed preview slug, when one exists. Secrets are
   * MIRRORED to it best-effort so the preview agent runs with the same
   * third-party keys as production — the panel itself reads/attaches to the
   * production slug.
   */
  previewSlug?: string | undefined;
  /** Post a note into the chat so the coding agent knows what changed. */
  onNotifyChat: (text: string) => void;
  onClose: () => void;
  /** Delete the project (workspace + chat). The app navigates home after. */
  onDeleteProject: () => void;
  deleting: boolean;
};

export function SecretsPanel({
  apiKey,
  project,
  slug,
  previewSlug,
  onNotifyChat,
  onClose,
  onDeleteProject,
  deleting,
}: SecretsPanelProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");

  const secrets = useQuery({
    queryKey: queryKeys.secrets(slug),
    queryFn: () => api.listSecrets(apiKey, slug as string),
    enabled: slug != null,
  });

  const invalidate = () => {
    if (slug) void queryClient.invalidateQueries({ queryKey: queryKeys.secrets(slug) });
  };

  // Best-effort mirror to the preview agent: a missing preview (not yet
  // deployed, or the preview slug 404s) must never fail the real write.
  const mirrorToPreview = async (fn: (mirror: string) => Promise<unknown>): Promise<void> => {
    if (!previewSlug || previewSlug === slug) return;
    await fn(previewSlug).catch(() => undefined);
  };

  const save = useMutation({
    mutationFn: async (updates: Record<string, string>) => {
      const result = await api.putSecrets(apiKey, slug as string, updates);
      await mirrorToPreview((mirror) => api.putSecrets(apiKey, mirror, updates));
      return result;
    },
    onSuccess: (_data, updates) => {
      invalidate();
      setDraft("");
      const names = Object.keys(updates);
      onNotifyChat(
        `I set the secret${names.length > 1 ? "s" : ""} ${names.join(", ")} on the ` +
          "deployed agent from the Secrets panel (values hidden). They are available " +
          "to the published agent as environment variables via ctx.env.",
      );
    },
  });

  const remove = useMutation({
    mutationFn: async (name: string) => {
      const result = await api.deleteSecret(apiKey, slug as string, name);
      await mirrorToPreview((mirror) => api.deleteSecret(apiKey, mirror, name));
      return result;
    },
    onSuccess: (_data, name) => {
      invalidate();
      onNotifyChat(`I deleted the secret ${name} from the deployed agent via the Secrets panel.`);
    },
  });

  const onSave = () => {
    const updates = parseSecrets(draft);
    if (Object.keys(updates).length === 0 || save.isPending) return;
    save.mutate(updates);
  };

  const message = errorText(secrets.error ?? save.error ?? remove.error);
  const names = secrets.data ?? [];

  return (
    <div className="absolute top-14 right-5 z-10 flex w-80 flex-col gap-3 rounded-lg border border-line bg-panel p-5 shadow-md">
      <span className="eyebrow">Settings · Secrets</span>
      {slug ? (
        <>
          <p className="m-0 text-[13px] leading-5 text-muted">
            Environment variables for the deployed agent (ctx.env). ASSEMBLYAI_API_KEY is set for
            you at publish; add third-party keys here, one KEY=value per line.
          </p>
          {names.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {names.map((name) => (
                <li key={name} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">{name}</code>
                  <button
                    type="button"
                    className="btn px-2 py-1 text-xs"
                    onClick={() => remove.mutate(name)}
                    disabled={remove.isPending}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            className="field h-16 resize-none py-2 font-mono text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="OPENAI_API_KEY=..."
            spellCheck={false}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSave}
              disabled={save.isPending}
            >
              {save.isPending ? "Saving…" : "Save secrets"}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="m-0 text-[13px] leading-5 text-muted">
            Publish the project first — secrets attach to the deployed agent.
          </p>
          <button type="button" className="btn self-start" onClick={onClose}>
            Close
          </button>
        </>
      )}
      {message && <p className="m-0 text-xs text-err">{message}</p>}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <span className="eyebrow">Danger zone</span>
        <p className="m-0 text-[13px] leading-5 text-muted">
          Deletes this project — its files and chat history. Already-published agents stay live.
        </p>
        <button
          type="button"
          className="btn self-start text-err"
          onClick={() => {
            if (window.confirm(`Delete the project "${project}"? This cannot be undone.`)) {
              onDeleteProject();
            }
          }}
          disabled={deleting}
        >
          {deleting ? "Deleting…" : "Delete project"}
        </button>
      </div>
    </div>
  );
}
