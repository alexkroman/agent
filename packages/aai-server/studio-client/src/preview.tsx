// Copyright 2025 the AAI authors. MIT license.
// Live preview — the deployed agent embedded same-origin, mic delegated so
// voice sessions work inside the frame.

type PreviewPaneProps = {
  deployedSlug?: string | undefined;
  /** Bumped after each publish / agent deploy so the iframe reloads. */
  nonce: number;
  onPublish: () => void;
};

export function PreviewPane({ deployedSlug, nonce, onPublish }: PreviewPaneProps) {
  if (!deployedSlug) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-ink">
        <p className="m-0 text-[15px] font-medium">Nothing published yet</p>
        <p className="m-0 max-w-sm text-center text-[13px] text-dim">
          Ask the agent to build something, then publish to see your voice agent live here.
        </p>
        <button type="button" className="btn btn-primary" onClick={onPublish}>
          Publish
        </button>
      </div>
    );
  }
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
