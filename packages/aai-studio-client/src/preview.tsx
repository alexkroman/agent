// Copyright 2025 the AAI authors. MIT license.
// The Preview pane — it shows the PREVIEW deploy of the workspace, which is
// auto-deployed after every agent turn and editor save, so edits show up
// here without publishing. Publish is the only thing that touches the
// production slug. Before any preview exists, a quiet placeholder (falling
// back to the production agent for projects published before previews
// existed); once deployed, the preview agent embedded same-origin (iframe
// with microphone delegation) — but only once the platform really serves
// that page (see useAgentPageReady), so a preview still deploying shows the
// pane's own screen instead of the platform's raw 404 body.

import { useEffect, useState } from "react";
import { api } from "./api.ts";

/**
 * How often a slug the platform doesn't serve yet is re-probed. Polling
 * stops on the first success, so this only ticks while the pane has nothing
 * to frame anyway.
 */
const PROBE_RETRY_MS = 3000;

/**
 * Is the agent page this pane wants to frame actually there? `null` until
 * the first probe answers.
 *
 * A stamped `previewSlug` is not proof the platform serves it: the stamp
 * outlives the deploy behind it (an agent swept or deleted out from under
 * the workspace — the case `wakeProjectPreview` regenerates), and a
 * redeploy in flight takes seconds to land. Framing the URL through that
 * window renders the platform's raw 404 body — a bare
 * `{"error":"HTML not found"}` — as the whole pane, which reads as a broken
 * studio rather than a preview on its way. So probe first and keep the
 * pane's own screen up until the page exists.
 *
 * Success is LATCHED per slug: nothing re-probes a page that answered once,
 * because flipping back to the placeholder would unmount the iframe and
 * kill any voice session running inside it. A new preview deploy reaches
 * the frame through its `previewVersion` key instead.
 */
function useAgentPageReady(slug: string | undefined): boolean | null {
  // Carries the slug it is about, so a probe that settles after the framed
  // slug changed can't answer for the new one.
  const [result, setResult] = useState<{ slug: string; ready: boolean } | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = (): void => {
      void api.agentPageReady(slug).then((ready) => {
        if (cancelled) return;
        setResult({ slug, ready });
        // Ready → no timer armed, so the polling stops here for good.
        if (!ready) timer = setTimeout(probe, PROBE_RETRY_MS);
      });
    };
    probe();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [slug]);

  // `result?.slug === slug` alone would be TRUE for no result and no slug
  // (undefined both sides) — the empty-project render.
  return result !== null && result.slug === slug ? result.ready : null;
}

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
function PaneBanner(props: PreviewPaneProps & { framed: boolean }) {
  if (props.previewError) {
    return (
      <div className="flex shrink-0 flex-col gap-1 border-b border-line bg-red-50 px-4 py-2">
        <span className="text-[11px] text-err">
          The preview build failed — ask the agent in the chat to fix it.
          {props.framed ? " What's running below is the last good preview." : ""}
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

/** The pane's own screen, for when there is nothing to frame (yet). */
function PaneScreen(props: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-cream p-10">
      <span className="eyebrow self-center">Preview</span>
      <h2 className="m-0 text-center font-serif text-[28px] leading-[1.15] font-normal text-balance">
        {props.title}
      </h2>
      <p className="m-0 max-w-sm text-center text-[13px] leading-5 text-muted">{props.body}</p>
    </div>
  );
}

export function PreviewPane(props: PreviewPaneProps) {
  const { previewSlug, deployedSlug } = props;
  // Prefer the preview (the workspace's current state); production is only
  // a fallback for projects published before auto previews existed.
  const slug = previewSlug ?? deployedSlug;
  const ready = useAgentPageReady(slug);
  if (slug && ready) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PaneBanner {...props} framed={true} />
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
  if (slug) {
    // There is a slug but no page behind it yet — a preview deploy on the
    // way, or one being regenerated. The banners still apply (they describe
    // the deploy, not the frame); below them the pane's own screen, never
    // the platform's 404 body. `null` is the first probe still in flight:
    // an empty pane, so an already-deployed preview doesn't flash a
    // "starting" message for one round trip on every open.
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PaneBanner {...props} framed={false} />
        {ready === null ? (
          <div className="min-h-0 flex-1 bg-cream" />
        ) : (
          <PaneScreen
            title="Starting your preview"
            body="The preview agent is deploying. This pane loads it automatically as soon as it's up."
          />
        )}
      </div>
    );
  }
  return (
    <PaneScreen
      title="Nothing to preview yet"
      body="Describe your agent in the chat on the left — a live preview deploys automatically after the agent's first edit and runs right here."
    />
  );
}
