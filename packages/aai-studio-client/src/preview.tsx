// Copyright 2025 the AAI authors. MIT license.
// Preview pane (design 1b): before anything is published, a guided
// three-step canvas with outlined stencil numerals whose active step tracks
// real progress; after publishing, the live agent embedded same-origin
// (iframe with microphone delegation).

import clsx from "clsx";

type StepCardProps = {
  numeral: string;
  title: string;
  caption: string;
  active: boolean;
};

function StepCard({ numeral, title, caption, active }: StepCardProps) {
  return (
    <div
      className={clsx(
        "flex w-[230px] flex-col gap-3 rounded-lg border bg-panel p-6",
        active ? "border-indigo-200" : "border-line",
      )}
    >
      <span className={clsx("stat-numeral text-[48px]", active ? "text-indigo" : "text-warm-300")}>
        {numeral}
      </span>
      <span className="font-serif text-[18px]">{title}</span>
      <p className="m-0 text-xs leading-[17px] text-muted">{caption}</p>
    </div>
  );
}

type PreviewPaneProps = {
  hasProject: boolean;
  deployedSlug?: string | undefined;
  /** Workspace has edits the running agent does not have yet. */
  unpublished?: boolean | undefined;
  /** Bumped after each publish / agent deploy so the iframe reloads. */
  nonce: number;
  onNewProject: () => void;
  onPublish: () => void;
};

export function PreviewPane({
  hasProject,
  deployedSlug,
  unpublished,
  nonce,
  onNewProject,
  onPublish,
}: PreviewPaneProps) {
  if (deployedSlug) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* The frame shows the *published* agent, so edits appear to do
            nothing until Publish. Saying so beats looking broken. */}
        {unpublished && (
          <div className="flex shrink-0 items-center gap-3 border-b border-line bg-indigo-50 px-4 py-2">
            <span className="text-[11px] text-fg">
              You've changed the code since this was published — the preview is still running the
              last published version.
            </span>
            <button type="button" className="btn btn-primary ml-auto" onClick={onPublish}>
              Publish
            </button>
          </div>
        )}
        <iframe
          key={`${deployedSlug}-${nonce}`}
          src={`/${deployedSlug}/`}
          title="Agent preview"
          allow="microphone"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      </div>
    );
  }
  // Steps: 1 until a project exists, then 2 (describe) until published.
  const activeStep = hasProject ? 2 : 1;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-11 bg-cream p-10">
      <div className="flex flex-col items-center gap-2.5">
        <span className="eyebrow self-center">Get started</span>
        <h2 className="m-0 text-center font-serif text-[28px] leading-[1.15] font-normal text-balance">
          Three steps to a live voice agent or workflow
        </h2>
      </div>
      <div className="flex gap-7">
        <StepCard
          numeral="1"
          title="Create a project"
          caption="Each project is one agent with its own key and history."
          active={activeStep === 1}
        />
        <StepCard
          numeral="2"
          title="Describe what you want"
          caption="Chat with the agent on the left. It writes and revises the build."
          active={activeStep === 2}
        />
        <StepCard
          numeral="3"
          title="Publish"
          caption="Push it live and try it in this pane."
          active={false}
        />
      </div>
      {!hasProject && (
        <button type="button" className="btn btn-primary h-10 px-5" onClick={onNewProject}>
          + New project
        </button>
      )}
    </div>
  );
}
