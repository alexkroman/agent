// Copyright 2026 the AAI authors. MIT license.
// Deployed-agent secrets panel — its own UI, not part of Publish. Talks to
// the platform's own `/:slug/secret` routes (the exact ones `aai secret`
// uses), so it needs a published slug to attach secrets to. Every change
// posts a note into the chat (values withheld) so the coding agent knows
// which keys exist without ever seeing them.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, parseSecrets } from "./api.ts";

export function secretsQueryKey(slug: string): readonly unknown[] {
  return ["secrets", slug];
}

type SecretsPanelProps = {
  apiKey: string;
  /** The project's published slug; undefined until the first publish. */
  slug: string | undefined;
  /** Post a note into the chat so the coding agent knows what changed. */
  onNotifyChat: (text: string) => void;
  onClose: () => void;
};

export function SecretsPanel({ apiKey, slug, onNotifyChat, onClose }: SecretsPanelProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");

  const secrets = useQuery({
    queryKey: slug ? secretsQueryKey(slug) : ["secrets", "unpublished"],
    queryFn: () => api.listSecrets(apiKey, slug as string),
    enabled: slug != null,
  });

  const invalidate = () => {
    if (slug) void queryClient.invalidateQueries({ queryKey: secretsQueryKey(slug) });
  };

  const save = useMutation({
    mutationFn: (updates: Record<string, string>) =>
      api.putSecrets(apiKey, slug as string, updates),
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
    mutationFn: (name: string) => api.deleteSecret(apiKey, slug as string, name),
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

  const error = secrets.error ?? save.error ?? remove.error;
  let errorText: string | undefined;
  if (error) {
    errorText = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className="absolute top-14 right-5 z-10 flex w-80 flex-col gap-3 rounded-lg border border-line bg-panel p-5 shadow-md">
      <span className="eyebrow">Secrets</span>
      {!slug && (
        <p className="m-0 text-[13px] leading-5 text-muted">
          Publish the project first — secrets attach to the deployed agent.
        </p>
      )}
      {slug && (
        <>
          <p className="m-0 text-[13px] leading-5 text-muted">
            Environment variables for the deployed agent (ctx.env). ASSEMBLYAI_API_KEY is set for
            you at publish; add third-party keys here, one KEY=value per line.
          </p>
          {(secrets.data ?? []).length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {(secrets.data ?? []).map((name) => (
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
      )}
      {!slug && (
        <button type="button" className="btn self-start" onClick={onClose}>
          Close
        </button>
      )}
      {errorText && <p className="m-0 text-xs text-err">{errorText}</p>}
    </div>
  );
}
