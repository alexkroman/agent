// Copyright 2026 the AAI authors. MIT license.
// The Settings pane — a full page beside the chat panel, selected from the
// top bar's pane switcher like the other panes. It used to be
// a floating 384px dropdown that scrolled itself; unrelated sections never fit
// that width, so it is laid out as a real page instead.
//
// The sections run in the order a project needs them: the CLI round-trip
// (cli-commands.tsx) first, and the delete-project button last. Two subjects have LEFT this pane for panes of
// their own, and both left for the same reason — a card is the wrong size for
// them. The carrier webhook URLs went to the API pane (docs.tsx): they
// document how something CALLS this agent. Secrets went to a pane of their own
// (secrets.tsx): one textarea of `KEY=value` lines was the whole UI for the
// piece of project configuration people come back to most.
//
// Every section here works from the moment a project exists — no publish, no
// build — and nothing writes into the conversation: each card reports its own
// outcome beside the control that did it (see "No studio action writes into
// the transcript" in the package guide).

import { CliCommands } from "./cli-commands.tsx";
import { GithubCard, type GithubSyncState } from "./github-card.tsx";
import { PaneShell } from "./pane-shell.tsx";
import { Card } from "./settings-card.tsx";

/**
 * No slug of any kind: every card left here works from the moment a project
 * exists, which is what "nothing on this pane gates on a deploy" now means
 * literally rather than nearly. The cards that needed a deployed agent — the
 * carrier webhook URLs and the workflow runs — are panes of their own, as
 * Secrets now is.
 */
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
  /** Delete the project (workspace + chat). The app navigates home after. */
  onDeleteProject: () => void;
  deleting: boolean;
};

export function SettingsPane({
  project,
  bearer,
  data,
  onDeleteProject,
  deleting,
}: SettingsPaneProps) {
  return (
    <PaneShell
      title="Settings"
      subtitle={
        <>
          Project <span className="font-mono text-fg">{project}</span>
        </>
      }
    >
      {/* Unconditional — pulling a project locally needs no published slug. */}
      <Card
        title="Work locally"
        blurb={
          <>
            Pull this project's files with the <code className="font-mono">aai</code> CLI, edit them
            in your own editor, then <code className="font-mono">aai push</code> to sync them back
            (or <code className="font-mono">aai publish</code> to sync and ship to production).
          </>
        }
      >
        <CliCommands project={project} />
      </Card>

      {/* Between the CLI round-trip and Delete project, because it is the
          other answer to "get this code out of the studio" — and it renders
          NOTHING when the platform has no GitHub App, so on a self-hosted
          deploy the pane looks exactly as it did. */}
      <GithubCard bearer={bearer} project={project} data={data} />

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
