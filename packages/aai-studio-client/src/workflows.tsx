// Copyright 2026 the AAI authors. MIT license.
// The Workflows pane — what durable work this project declares, and how its
// recent runs are doing.
//
// It was a card in Settings, which put the one live view of a RUNNING system
// behind a page about configuration. A run is not a setting: it is the only
// thing in this product that outlives every other surface the studio shows —
// the UI pane frames a page or a voice client, the transcript shows a
// conversation, and a run started an hour ago by a caller who has since hung
// up appears in neither — so it is worth a tab of its own, beside the API pane
// that documents how to start one.
//
// The card itself (`workflows-card.tsx`) is unchanged and still carries the
// reasoning about reading the agent's own brokered API, the preview fallback,
// and why the refresh is manual.

import { PaneShell } from "./pane-shell.tsx";
import { WorkflowsCard } from "./workflows-card.tsx";

type WorkflowsPaneProps = {
  /** The project's published slug, if it has one. */
  deployedSlug?: string | undefined;
  /** The auto-deployed preview's slug — what there is to read before a publish. */
  previewSlug?: string | undefined;
};

export function WorkflowsPane(props: WorkflowsPaneProps) {
  return (
    <PaneShell
      title="Workflows"
      subtitle="Durable runs this project started — they keep going after the call, the page, or the request that began them."
    >
      <WorkflowsCard deployedSlug={props.deployedSlug} previewSlug={props.previewSlug} />
    </PaneShell>
  );
}
