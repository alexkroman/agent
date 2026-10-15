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

import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { useEffect, useEffectEvent, useRef } from "react";
import { api } from "../api.ts";
import { DesktopIcon, ExternalIcon, PhoneIcon, ReloadIcon } from "../components/icons.tsx";
import { agentUrl } from "../platform-origin.ts";
import { queryKeys } from "../query-keys.ts";
import { SEG_GROUP, segItemClass } from "../segmented.ts";

/** The width the frame takes in the phone view — a common handset's CSS width. */
const PHONE_FRAME_WIDTH = 390;

/** How the UI pane frames the preview: the full canvas, or a handset-wide column. */
export type PreviewDevice = "desktop" | "phone";

/**
 * The browser chrome the top bar's canvas zone shows over the UI pane: the
 * preview's address, a reload, the desktop/phone toggle, and open-in-a-tab.
 *
 * The address is the PREVIEW agent's, never production's — production is the
 * Publish menu's link. It shows the PATH only: the platform host is the same
 * for every project and was truncated anyway, so it rides in the tooltip and
 * the open-in-a-tab link instead. Below 1180px the address itself goes,
 * leaving reload and open. With no preview yet there is nothing to reload or open,
 * so those controls disable rather than vanish, keeping the bar's shape.
 */
export function PreviewToolbar({
  previewSlug,
  device,
  onDeviceChange,
  onReload,
}: {
  previewSlug: string | undefined;
  device: PreviewDevice;
  onDeviceChange: (device: PreviewDevice) => void;
  onReload: () => void;
}) {
  const url = previewSlug ? agentUrl(previewSlug) : null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <div className="flex h-8 max-w-[22rem] flex-none items-center gap-1.5 rounded-lg border border-line bg-cream px-1 min-[1180px]:min-w-0 min-[1180px]:flex-1">
        <button
          type="button"
          className="icon-btn h-6 w-6"
          aria-label="Reload preview"
          title="Reload preview"
          onClick={onReload}
          disabled={url === null}
        >
          <ReloadIcon size={13} />
        </button>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted max-[1180px]:hidden"
          title={url ?? undefined}
        >
          {url ? new URL(url).pathname : "No preview yet"}
        </span>
        {url && (
          <a
            className="icon-btn h-6 w-6"
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open preview in a new tab"
            title="Open preview in a new tab"
          >
            <ExternalIcon size={13} />
          </a>
        )}
      </div>
      <div className={SEG_GROUP} role="group" aria-label="Preview size">
        {(
          [
            ["desktop", "Desktop view", <DesktopIcon key="d" size={14} />],
            ["phone", "Phone view", <PhoneIcon key="p" size={14} />],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={device === id}
            className={clsx("seg w-7 justify-center px-0", segItemClass(device === id))}
            onClick={() => onDeviceChange(id)}
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  );
}

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
  const queryKey = queryKeys.agentPageReady(slug);
  const probe = useQuery({
    queryKey,
    queryFn: slug ? () => api.agentPageReady(slug) : skipToken,
    // The latch: a page that answered once turns the query OFF, so neither
    // the interval nor an invalidation (app.tsx sweeps every query on a
    // bearer refresh) can re-probe it and unmount a live frame.
    enabled: (query) => query.state.data !== true,
    // Every answer — `false` included — is a successful fetch, so the
    // query's update count IS the failure count until the latch closes.
    refetchInterval: (query) =>
      query.state.data === true ? false : probeRetryMs(query.state.dataUpdateCount),
    refetchIntervalInBackground: true,
    // Only the interval re-probes; nothing else here should.
    staleTime: Number.POSITIVE_INFINITY,
    // Dropped as soon as the pane stops framing the slug, so coming back to
    // it starts the count (and the report latch) over, as a fresh probe.
    gcTime: 0,
  });
  const queryClient = useQueryClient();
  // Read off the cache because the observer's result does not carry it;
  // `dataUpdatedAt`, read below, is what re-renders this on every answer.
  const failures =
    probe.data === false ? (queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0) : 0;

  // The slug a report is in flight or delivered for. Latches on DELIVERY: a
  // report that never arrived is sent again on the next failure.
  const reportedFor = useRef<string | null>(null);
  const report = useEffectEvent((missing: string): void => {
    if (!onMissing) return;
    reportedFor.current = missing;
    void onMissing().catch(() => {
      if (reportedFor.current === missing) reportedFor.current = null;
    });
  });
  const answeredAt = probe.dataUpdatedAt;
  useEffect(() => {
    if (!slug || answeredAt === 0) return;
    if (failures < PROBE_FAILURES_BEFORE_WAKE) {
      // A fresh count for this slug (see `gcTime`) is a fresh latch too.
      if (reportedFor.current === slug) reportedFor.current = null;
      return;
    }
    if (reportedFor.current !== slug) report(slug);
  }, [slug, failures, answeredAt]);

  return slug ? (probe.data ?? null) : null;
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
  /**
   * Report that the platform is not serving the slug this pane wants to
   * frame, so the server regenerates it. Called at most once per missing
   * preview; a rejection is retried. Absent means no recovery is possible
   * (no project open), and the pane just keeps probing.
   */
  onPreviewMissing?: () => Promise<unknown>;
  /** Bumped by the toolbar's reload — part of the frame's key, so a bump remounts it. */
  reloadKey?: number | undefined;
  /** Full canvas, or a handset-wide column (see {@link PreviewToolbar}). */
  device?: PreviewDevice | undefined;
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
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-panel p-10">
      <span className="eyebrow self-center">Preview</span>
      <h2 className="m-0 text-center font-serif text-[28px] leading-[1.15] font-normal text-balance">
        {props.title}
      </h2>
      <p className="m-0 max-w-sm text-center text-[13px] leading-5 text-muted">{props.body}</p>
    </div>
  );
}

export function PreviewPane(props: PreviewPaneProps) {
  // The preview — the workspace's current state. Production is never framed.
  const slug = props.previewSlug;
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
            Only the user's own preview agent is ever framed here —
            see the key-storage threat notes in main.tsx. Keyed by the preview
            version so a fresh preview deploy reloads the frame exactly once. */}
        <div
          className={clsx(
            "flex min-h-0 flex-1",
            props.device === "phone" && "justify-center bg-cream px-4 py-5",
          )}
        >
          <iframe
            key={`${slug}-${props.previewVersion ?? ""}-${props.reloadKey ?? 0}`}
            src={`/${slug}/`}
            title="Preview agent"
            allow="microphone"
            style={props.device === "phone" ? { width: PHONE_FRAME_WIDTH } : undefined}
            className={clsx(
              "min-h-0 flex-1 border-0 bg-white",
              props.device === "phone"
                ? "max-w-full flex-none rounded-[22px] border border-line shadow-lg"
                : "w-full",
            )}
          />
        </div>
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
          <div className="min-h-0 flex-1 bg-panel" />
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
