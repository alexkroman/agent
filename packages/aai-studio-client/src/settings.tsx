// Copyright 2026 the AAI authors. MIT license.
// The Settings pane — a full page beside the chat panel, selected from the
// top bar's Preview/Code/Settings switcher like the other two. It used to be
// a floating 384px dropdown that scrolled itself; three unrelated sections
// (secrets, the CLI round-trip, delete) never fit that, so it is laid out as
// a real page instead.
//
// Its main section is deployed-agent secrets — its own UI, not part of
// Publish. Talks to the platform's own `/:slug/secret` routes (the exact
// ones `aai secret` uses), so it needs a published slug to attach secrets
// to. Every change posts a note into the chat (values withheld) so the
// coding agent knows which keys exist without ever seeing them. Below it sit
// the project-scoped sections that work without a publish: the Database
// switch (database-card.tsx), the CLI pull commands (cli-commands.tsx), and
// the delete-project button.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, parseSecrets } from "./api.ts";
import { errorText } from "./api-error.ts";
import { CliCommands } from "./cli-commands.tsx";
import { DatabaseCard } from "./database-card.tsx";
import { queryKeys } from "./query-keys.ts";
import { Card } from "./settings-card.tsx";

/**
 * Secrets the PLATFORM manages, which this pane neither lists, deletes, nor
 * sets. `ASSEMBLYAI_API_KEY` is seeded into every deployed agent at publish
 * from the caller's own account key (aai-cli/deploy.ts) — it is not a
 * third-party key the user attached, and deleting it takes the agent off the
 * air (S2S/STT/TTS connect with an empty bearer and AssemblyAI answers
 * `unauthorized`) with nothing in this pane to put it back. Overriding it
 * with a key for a different account stays a CLI action (`aai secret`, or
 * `.env` + `aai publish`), where it is deliberate rather than a Delete button
 * one row away from a third-party key.
 */
const PLATFORM_MANAGED_SECRETS: readonly string[] = ["ASSEMBLYAI_API_KEY"];

type SettingsPaneProps = {
  bearer: string;
  /** The open project's name — the target of the Delete project button. */
  project: string;
  /** The project's published slug; undefined until the first publish. */
  slug: string | undefined;
  /**
   * The project's auto-deployed preview slug, when one exists. Secrets are
   * MIRRORED to it best-effort so the preview agent runs with the same
   * third-party keys as production — the pane itself reads/attaches to the
   * production slug.
   */
  previewSlug?: string | undefined;
  /** Post a note into the chat so the coding agent knows what changed. */
  onNotifyChat: (text: string) => void;
  /** Delete the project (workspace + chat). The app navigates home after. */
  onDeleteProject: () => void;
  deleting: boolean;
};

export function SettingsPane({
  bearer,
  project,
  slug,
  previewSlug,
  onNotifyChat,
  onDeleteProject,
  deleting,
}: SettingsPaneProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  /** Managed key names the last save refused (see PLATFORM_MANAGED_SECRETS). */
  const [rejected, setRejected] = useState<string[]>([]);

  const secrets = useQuery({
    queryKey: queryKeys.secrets(slug),
    queryFn: () => api.listSecrets(bearer, slug as string),
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
      const result = await api.putSecrets(bearer, slug as string, updates);
      await mirrorToPreview((mirror) => api.putSecrets(bearer, mirror, updates));
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
      const result = await api.deleteSecret(bearer, slug as string, name);
      await mirrorToPreview((mirror) => api.deleteSecret(bearer, mirror, name));
      return result;
    },
    onSuccess: (_data, name) => {
      invalidate();
      onNotifyChat(`I deleted the secret ${name} from the deployed agent via the Secrets panel.`);
    },
  });

  const onSave = () => {
    const parsed = parseSecrets(draft);
    // A managed key typed into the box would save and then not appear in the
    // list below, which reads as a failed write — so it is refused by name
    // and said so, rather than accepted and hidden.
    const managed = Object.keys(parsed).filter((name) => PLATFORM_MANAGED_SECRETS.includes(name));
    setRejected(managed);
    const updates = Object.fromEntries(
      Object.entries(parsed).filter(([name]) => !managed.includes(name)),
    );
    if (Object.keys(updates).length === 0 || save.isPending) return;
    save.mutate(updates);
  };

  const message = errorText(secrets.error ?? save.error ?? remove.error);
  // Platform-managed keys are filtered out of the list, which is also what
  // withholds their Delete button — there is no row to hang one on.
  const names = (secrets.data ?? []).filter((name) => !PLATFORM_MANAGED_SECRETS.includes(name));

  return (
    // min-w-0 keeps the page from stretching the flex row sideways, exactly
    // as the Code pane does. The page scrolls itself; the shell does not.
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-cream">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-8">
        <header className="flex flex-col gap-1">
          <h1 className="m-0 font-serif text-[26px] leading-8 text-fg">Settings</h1>
          <p className="m-0 text-[13px] leading-5 text-muted">
            Project <span className="font-mono text-fg">{project}</span>
          </p>
        </header>

        <Card
          title="Secrets"
          blurb={
            slug ? (
              <>
                Third-party keys for the deployed agent, readable as{" "}
                <code className="font-mono">ctx.env</code> — one{" "}
                <code className="font-mono">KEY=value</code> per line.{" "}
                <code className="font-mono">ASSEMBLYAI_API_KEY</code> is set and managed for you at
                publish, so it is not listed here.
              </>
            ) : (
              "Publish the project first — secrets attach to the deployed agent."
            )
          }
        >
          {slug && (
            <>
              {names.length > 0 && (
                <ul className="m-0 flex list-none flex-col overflow-hidden rounded-md border border-line p-0">
                  {names.map((name) => (
                    <li
                      key={name}
                      className="flex items-center gap-3 border-b border-line bg-cream px-3 py-2 last:border-b-0"
                    >
                      <code className="min-w-0 flex-1 truncate font-mono text-xs">{name}</code>
                      <span className="font-mono text-[11px] text-subtle" aria-hidden>
                        ••••••••
                      </span>
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
                className="field h-28 resize-y py-2 font-mono text-xs"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setRejected([]);
                }}
                placeholder="OPENAI_API_KEY=..."
                spellCheck={false}
              />
              <button
                type="button"
                className="btn btn-primary self-start"
                onClick={onSave}
                disabled={save.isPending}
              >
                {save.isPending ? "Saving…" : "Save secrets"}
              </button>
            </>
          )}
          {rejected.length > 0 && (
            <p className="m-0 text-xs text-err">
              {rejected.join(", ")} {rejected.length > 1 ? "are" : "is"} managed for you and can't
              be set here.
            </p>
          )}
          {message && <p className="m-0 text-xs text-err">{message}</p>}
        </Card>

        {/* Unconditional, like the two below: a database is provisioned per
            environment as each one deploys, so it can be switched on before
            the project has ever been published. */}
        <DatabaseCard bearer={bearer} project={project} onNotifyChat={onNotifyChat} />

        {/* Unconditional — pulling a project locally needs no published slug. */}
        <Card
          title="Work locally"
          blurb={
            <>
              Pull this project's files with the <code className="font-mono">aai</code> CLI, edit
              them in your own editor, then <code className="font-mono">aai push</code> to sync them
              back (or <code className="font-mono">aai publish</code> to sync and ship to
              production).
            </>
          }
        >
          <CliCommands project={project} />
        </Card>

        <Card
          title="Danger zone"
          blurb="Deletes this project — its files and chat history. Already-published agents stay live."
        >
          <button
            type="button"
            className="btn self-start text-err hover:border-err"
            onClick={() => {
              if (window.confirm(`Delete the project "${project}"? This cannot be undone.`)) {
                onDeleteProject();
              }
            }}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Delete project"}
          </button>
        </Card>
      </div>
    </div>
  );
}
