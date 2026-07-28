// Copyright 2025 the AAI authors. MIT license.
// Preview pane (design 1b): before anything is published, a guided
// three-step canvas with outlined stencil numerals whose active step tracks
// real progress; after publishing, the live agent embedded same-origin
// (iframe with microphone delegation).

type StepCardProps = {
  numeral: string;
  title: string;
  caption: string;
  active: boolean;
};

function StepCard({ numeral, title, caption, active }: StepCardProps) {
  return (
    <div
      className={`flex w-[230px] flex-col gap-3 rounded-lg border bg-panel p-6 ${
        active ? "border-indigo-200" : "border-line"
      }`}
    >
      <span className={`stat-numeral text-[57px] ${active ? "text-indigo" : "text-warm-300"}`}>
        {numeral}
      </span>
      <span className="font-serif text-[21px]">{title}</span>
      <p className="m-0 text-xs leading-[20px] text-muted">{caption}</p>
    </div>
  );
}

type PreviewPaneProps = {
  hasProject: boolean;
  deployedSlug?: string | undefined;
  /** Bumped after each publish / agent deploy so the iframe reloads. */
  nonce: number;
  onNewProject: () => void;
};

export function PreviewPane({ hasProject, deployedSlug, nonce, onNewProject }: PreviewPaneProps) {
  if (deployedSlug) {
    return (
      <iframe
        key={`${deployedSlug}-${nonce}`}
        src={`/${deployedSlug}/`}
        title="Agent preview"
        allow="microphone"
        className="h-full w-full flex-1 border-0 bg-white"
      />
    );
  }
  // Steps: 1 until a project exists, then 2 (describe) until published.
  const activeStep = hasProject ? 2 : 1;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-11 bg-cream p-10">
      <div className="flex flex-col items-center gap-2.5">
        <span className="eyebrow self-center">Get started</span>
        <h2 className="m-0 text-center font-serif text-[33px] leading-[1.15] font-normal text-balance">
          Three steps to a live voice agent
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
          title="Describe your agent"
          caption="Chat with the agent on the left. It writes and revises the build."
          active={activeStep === 2}
        />
        <StepCard
          numeral="3"
          title="Publish"
          caption="Push it live and talk to your agent in this pane."
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
