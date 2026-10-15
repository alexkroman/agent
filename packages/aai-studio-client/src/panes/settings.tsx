// Copyright 2026 the AAI authors. MIT license.
// The Settings pane — a full page beside the chat panel, selected from the
// top bar's pane switcher like the other panes. It used to be
// a floating 384px dropdown that scrolled itself; unrelated sections never fit
// that width, so it is laid out as a real page instead.
//
// The sections run in the order a project needs them: getting the code out
// (components/github-card.tsx) first, then the carrier webhook URLs
// (components/phone-card.tsx), and the delete-project button last. Secrets
// have a pane of their own (panes/secrets.tsx).
//
// Nothing here writes into the conversation: each card reports its own
// outcome beside the control that did it (see "No studio action writes into
// the transcript" in the package guide).

import { useQuery } from "@tanstack/react-query";
import { GithubCard, type GithubSyncState } from "../components/github-card.tsx";
import { PhoneCard } from "../components/phone-card.tsx";
import { Card } from "../components/settings-card.tsx";
import { PaneShell } from "../pane-shell.tsx";
import { sharedQueries } from "../query-keys.ts";

type SettingsPaneProps = {
  /** The open project's name — the target of the Delete project button. */
  project: string;
  /** Session bearer — the GitHub card's reads and its sync ride it. */
  bearer: string;
  /**
   * The workspace's GitHub stamps, for the card's "up to date / has edits"
   * line and its last-commit link. Undefined while the project read is in
   * flight, which the card renders as no line rather than as "never synced".
   *
   * A narrow slice rather than the whole `ProjectData`, so this pane does not
   * become the place future cards reach for arbitrary project state.
   */
  data: GithubSyncState | undefined;
  /**
   * The project's published slug, for the phone card's webhook URLs. Absent
   * until the first Publish — only that card gates on it; Delete project must
   * work before anything is published.
   */
  deployedSlug?: string | undefined;
  /** Delete the project (workspace + chat). The app navigates home after. */
  onDeleteProject: () => void;
  deleting: boolean;
};

export function SettingsPane({
  project,
  bearer,
  data,
  deployedSlug,
  onDeleteProject,
  deleting,
}: SettingsPaneProps) {
  // Shared cache key with the Secrets pane: the phone card reports whether
  // each carrier's signing secret is set, and a save there shows up here.
  const secrets = useQuery(sharedQueries.secrets(bearer, project));
  return (
    <PaneShell
      title="Settings"
      subtitle={
        <>
          Project <span className="font-mono text-fg">{project}</span>
        </>
      }
    >
      {/* First, because it is THE answer to "get this code out of the studio"
          — and it renders NOTHING when the platform has no GitHub App, so on a
          self-hosted deploy the pane is Delete project alone. */}
      <GithubCard bearer={bearer} project={project} data={data} />

      <PhoneCard
        deployedSlug={deployedSlug}
        secretNames={secrets.data?.vars ?? []}
        pendingSecrets={secrets.data?.pending ?? []}
      />

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
    </PaneShell>
  );
}
