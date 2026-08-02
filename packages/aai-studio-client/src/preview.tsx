// Copyright 2025 the AAI authors. MIT license.
// The Live pane (design 1b) — it shows the *published* agent, which is why
// the tab says "Live" rather than "Preview": nothing here is a draft of the
// current editor state. Before anything is published, a quiet placeholder;
// after publishing, the live agent embedded same-origin (iframe with
// microphone delegation).

type PreviewPaneProps = {
  deployedSlug?: string | undefined;
  /** Workspace has edits the running agent does not have yet. */
  unpublished?: boolean | undefined;
  /** Bumped after each publish / agent deploy so the iframe reloads. */
  nonce: number;
  onPublish: () => void;
};

export function PreviewPane({ deployedSlug, unpublished, nonce, onPublish }: PreviewPaneProps) {
  if (deployedSlug) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* The frame shows the *published* agent, so edits appear to do
            nothing until Publish. Saying so beats looking broken. */}
        {unpublished && (
          <div className="flex shrink-0 items-center gap-3 border-b border-line bg-indigo-50 px-4 py-2">
            <span className="text-[11px] text-fg">
              You've changed the code since this was published — what's running here is the last
              published version.
            </span>
            <button type="button" className="btn btn-primary ml-auto" onClick={onPublish}>
              Publish
            </button>
          </div>
        )}
        {/* Same-origin and unsandboxed on purpose: `sandbox` without
            allow-same-origin blocks getUserMedia, the pane's whole point.
            Only the user's own published agent is ever framed here — see
            the key-storage threat notes in main.tsx. */}
        <iframe
          key={`${deployedSlug}-${nonce}`}
          src={`/${deployedSlug}/`}
          title="Live agent"
          allow="microphone"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-cream p-10">
      <span className="eyebrow self-center">Live</span>
      <h2 className="m-0 text-center font-serif text-[28px] leading-[1.15] font-normal text-balance">
        Nothing published yet
      </h2>
      <p className="m-0 max-w-sm text-center text-[13px] leading-5 text-muted">
        Describe your agent in the chat on the left, then hit Publish — the live agent runs right
        here.
      </p>
    </div>
  );
}
