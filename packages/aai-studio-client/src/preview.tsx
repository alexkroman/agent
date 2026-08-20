// Copyright 2025 the AAI authors. MIT license.
// The Preview pane, labelled **UI** in the top bar — it shows the
// PREVIEW deploy of the workspace, auto-deployed after every agent turn and
// editor save, so edits show up here without publishing. Publish is the only
// thing that touches the production slug. Before any preview exists, a quiet
// placeholder (falling back to the production agent for projects published
// before previews existed); once deployed, the preview agent embedded
// same-origin (iframe with microphone delegation) — but only once the
// platform really serves that page (see useAgentPageReady), so a preview
// still deploying shows the pane's own screen instead of the platform's raw
// 404 body.

import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

/**
 * How often a slug the platform doesn't serve yet is re-probed. Polling
 * stops on the first success, so this only ticks while the pane has nothing
 * to frame anyway.
 */
export const PROBE_RETRY_MS = 3000;

/**
 * After this many failures the cadence drops to {@link PROBE_SLOW_RETRY_MS}.
 *
 * The fast cadence exists for ONE case — a deploy landing in the next few
 * seconds — so it only has to outlast that, and ~30s of it does. Past there
 * the pane is not waiting on a deploy, it is waiting on the wake below, and
 * 20 requests a minute buys nothing: the same 50-minute window that produced
 * 1,061 probes produces ~106 under this.
 *
 * Deliberately two speeds rather than an exponential backoff. Exponential
 * reaches a sane ceiling by way of delays that are WORSE than the fast
 * cadence exactly where it matters (a preview landing at 25s is noticed at
 * 45s), which trades the common case for the pathological one.
 */
export const PROBE_SLOW_AFTER = 10;

/** The cadence once a missing preview is clearly not a deploy in flight. */
export const PROBE_SLOW_RETRY_MS = 30_000;

/**
 * Consecutive failures before the pane reports the preview missing (see
 * `api.wakePreview`). Not the first failure: a stamped `previewSlug` means a
 * deploy SUCCEEDED at some point, so a 404 is already the abnormal answer,
 * but a couple of probes' grace costs ~9s and covers a transient blip
 * without asking the server to go looking.
 */
export const PROBE_FAILURES_BEFORE_WAKE = 3;

/** Fast while a deploy could plausibly be landing, slow once it clearly isn't. */
function probeRetryMs(failures: number): number {
  return failures < PROBE_SLOW_AFTER ? PROBE_RETRY_MS : PROBE_SLOW_RETRY_MS;
}

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
 *
 * Polling alone is not a recovery, which is the other half of this. The
 * server's own recovery for a swept preview (`wakeProjectPreview`) is hung
 * off opening the project, and a tab that was ALREADY open never does that
 * again — so this loop used to run against a slug nothing was going to
 * redeploy until the user happened to trigger a session. `onMissing` is the
 * report that closes it: sent once the failures pass
 * {@link PROBE_FAILURES_BEFORE_WAKE}, and ONCE, because it enqueues a durable
 * job whose queue owns the retries. A rejected report un-latches — the point
 * is to deliver the signal, not to have tried.
 */
function useAgentPageReady(
  slug: string | undefined,
  onMissing?: () => Promise<unknown>,
): boolean | null {
  // Carries the slug it is about, so a probe that settles after the framed
  // slug changed can't answer for the new one.
  const [result, setResult] = useState<{ slug: string; ready: boolean } | null>(null);
  // Through a ref so a caller passing an inline arrow doesn't restart the
  // poll — and with it the failure count and the latch — on every render.
  const onMissingRef = useRef(onMissing);
  onMissingRef.current = onMissing;

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let reported = false;
    /** Latches on DELIVERY: a report that never arrived is sent again. */
    const report = (): void => {
      const send = onMissingRef.current;
      if (!send) return;
      reported = true;
      void send().catch(() => {
        reported = false;
      });
    };
    const probe = (): void => {
      void api.agentPageReady(slug).then((ready) => {
        if (cancelled) return;
        setResult({ slug, ready });
        // Ready → no timer armed, so the polling stops here for good.
        if (ready) return;
        failures += 1;
        if (failures >= PROBE_FAILURES_BEFORE_WAKE && !reported) report();
        timer = setTimeout(probe, probeRetryMs(failures));
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
  /**
   * The workspace has an agent to build. False on a project nobody has
   * edited yet, where `previewStale` is true only because "no preview" IS
   * stale — there is no build in flight to report.
   */
  hasAgent?: boolean | undefined;
  /** CLI output of the last failed preview deploy. */
  previewError?: string | undefined;
  /** Production slug — updated only by Publish; fallback for old projects. */
  deployedSlug?: string | undefined;
  /** Bumped after each publish so the production-fallback iframe reloads. */
  nonce: number;
  /**
   * Report that the platform is not serving the slug this pane wants to
   * frame, so the server regenerates it. Called at most once per missing
   * preview; a rejection is retried. Absent means no recovery is possible
   * (no project open), and the pane just keeps probing.
   */
  onPreviewMissing?: () => Promise<unknown>;
};

/**
 * The strip above the iframe: a failed preview build, with its CLI output.
 * That is the only thing worth a row here — it is the one state the pane
 * cannot show by itself, since the frame below still holds the last good
 * preview.
 *
 * There is deliberately no "this preview updates as you edit / hit Publish"
 * nudge. It rendered on every unpublished project, which is nearly all of
 * them nearly all the time, so it was permanent furniture stating what the
 * pane's own name already says — and the Publish control it pointed at is
 * two inches above it in the top bar.
 *
 * A build IN FLIGHT has no banner either: it takes over the whole pane
 * instead (see {@link PreviewPane}), so a row saying the same thing above it
 * would be redundant.
 */
function PaneBanner({
  previewError,
  framed,
}: {
  /** CLI output of the last failed preview deploy, if there was one. */
  previewError: string | undefined;
  /** Is the last good preview still framed below this row? */
  framed: boolean;
}) {
  if (!previewError) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-line bg-red-50 px-4 py-2">
      <span className="text-[11px] text-err">
        The preview build failed — ask the agent in the chat to fix it.
        {framed ? " What's running below is the last good preview." : ""}
      </span>
      <pre className="m-0 max-h-24 overflow-auto rounded-md border border-line bg-cream p-2 font-mono text-[10px] whitespace-pre-wrap text-err">
        {previewError}
      </pre>
    </div>
  );
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
  const ready = useAgentPageReady(slug, props.onPreviewMissing);
  // A build in flight owns the whole pane — the FIRST one and every rebuild
  // alike, which is why this is one flag and not a first-build special case.
  // It costs nothing to unmount the frame here: the landing deploy remounts
  // it anyway through the `previewVersion` key, so there is no voice session
  // that survives a rebuild either way. What it buys is that the pane never
  // shows a page that doesn't match the code while claiming, in a one-line
  // banner above it, that it doesn't.
  //
  // A FAILED build is not in flight — `previewStale` stays true after one
  // (the files still differ from the last good deploy), and parking the pane
  // on "Starting your preview" forever is the one state this must not
  // produce. That case keeps the last good preview framed under the error
  // banner, which is what the banner's own copy promises.
  const building = Boolean(props.previewStale) && Boolean(props.hasAgent) && !props.previewError;
  if (slug && ready && !building) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PaneBanner previewError={props.previewError} framed={true} />
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
  if (slug || building) {
    // Nothing to frame: a build on the way (the first one, with no slug yet,
    // or a rebuild over a preview that exists), or a slug whose page the
    // platform isn't serving — one being regenerated. The banners still
    // apply (they describe the deploy, not the frame); below them the pane's
    // own screen, never the platform's 404 body. `null` is the first probe
    // still in flight: an empty pane, so an already-deployed preview doesn't
    // flash a "starting" message for one round trip on every open. A build
    // in flight skips that grace — the screen is the answer either way, so
    // there is nothing to wait for the probe to rule out.
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PaneBanner previewError={props.previewError} framed={false} />
        {ready === null && !building ? (
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
