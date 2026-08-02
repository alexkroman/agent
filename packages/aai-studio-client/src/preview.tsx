// Copyright 2025 the AAI authors. MIT license.
// The Preview pane — it shows the PREVIEW deploy of the workspace, which is
// auto-deployed after every agent turn and editor save, so edits show up
// here without publishing. Publish is the only thing that touches the
// production slug. Before any preview exists, a quiet placeholder (falling
// back to the production agent for projects published before previews
// existed); once deployed, the preview agent embedded same-origin (iframe
// with microphone delegation).

type PreviewPaneProps = {
  /** Preview slug — auto-deployed on edits; what this pane embeds. */
  previewSlug?: string | undefined;
  /** Changes on every successful preview deploy — the iframe reload key. */
  previewVersion?: string | undefined;
  /** An edit hasn't reached the preview yet (deploy in flight or failed). */
  previewStale?: boolean | undefined;
  /** CLI output of the last failed preview deploy. */
  previewError?: string | undefined;
  /** Production slug — updated only by Publish; fallback for old projects. */
  deployedSlug?: string | undefined;
  /** Workspace has edits the PRODUCTION agent does not have yet. */
  unpublished?: boolean | undefined;
  /** Bumped after each publish so the production-fallback iframe reloads. */
  nonce: number;
  onPublish: () => void;
};

/**
 * The strip above the iframe, by priority: a failed preview build (with its
 * CLI output), a deploy on the way, or the publish nudge when production is
 * behind. One at a time — they answer the same question ("does what I see
 * match my edits?"), so stacking them would just contradict itself.
 */
function PaneBanner(props: PreviewPaneProps) {
  if (props.previewError) {
    return (
      <div className="flex shrink-0 flex-col gap-1 border-b border-line bg-red-50 px-4 py-2">
        <span className="text-[11px] text-err">
          The preview build failed — ask the agent in the chat to fix it. What's running below is
          the last good preview.
        </span>
        <pre className="m-0 max-h-24 overflow-auto rounded-md border border-line bg-cream p-2 font-mono text-[10px] whitespace-pre-wrap text-err">
          {props.previewError}
        </pre>
      </div>
    );
  }
  if (props.previewStale && props.previewSlug) {
    // Stale with a deploy on the way — the auto preview lands shortly and
    // the iframe below reloads on its own.
    return (
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-indigo-50 px-4 py-2">
        <span className="text-[11px] text-fg">Updating preview…</span>
      </div>
    );
  }
  if (props.unpublished) {
    return (
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-indigo-50 px-4 py-2">
        <span className="text-[11px] text-fg">
          This preview updates automatically as you edit. Hit Publish to ship it to your production
          agent.
        </span>
        <button type="button" className="btn btn-primary ml-auto" onClick={props.onPublish}>
          Publish
        </button>
      </div>
    );
  }
  return null;
}

export function PreviewPane(props: PreviewPaneProps) {
  const { previewSlug, deployedSlug } = props;
  // Prefer the preview (the workspace's current state); production is only
  // a fallback for projects published before auto previews existed.
  const slug = previewSlug ?? deployedSlug;
  if (slug) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PaneBanner {...props} />
        {/* Same-origin and unsandboxed on purpose: `sandbox` without
            allow-same-origin blocks getUserMedia, the pane's whole point.
            Only the user's own preview/production agent is ever framed here —
            see the key-storage threat notes in main.tsx. Keyed by the preview
            version so a fresh preview deploy reloads the frame exactly once. */}
        <iframe
          key={
            previewSlug ? `${previewSlug}-${props.previewVersion ?? ""}` : `${slug}-${props.nonce}`
          }
          src={`/${slug}/`}
          title="Preview agent"
          allow="microphone"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-cream p-10">
      <span className="eyebrow self-center">Preview</span>
      <h2 className="m-0 text-center font-serif text-[28px] leading-[1.15] font-normal text-balance">
        Nothing to preview yet
      </h2>
      <p className="m-0 max-w-sm text-center text-[13px] leading-5 text-muted">
        Describe your agent in the chat on the left — a live preview deploys automatically after the
        agent's first edit and runs right here.
      </p>
    </div>
  );
}
