// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

// `formatBytes` is the SDK's own narration formatter, not a second copy of it:
// a size a person can read (`12.4 MB of 48.0 MB`) is the same question a step's
// progress line asks, and it already guards the cases a bar can hand it — an
// unknown length arriving as `NaN`, a rounding that carries into the next unit.
import { formatBytes, omitUndefined } from "@alexkroman1/aai/utils";
import clsx from "clsx";
import { type ReactNode, useId } from "react";
import { useTheme } from "../context.ts";
import type { UploadStatus } from "../use-workflow-form.ts";
import { INK_FAINT_PCT, inkTint } from "./_colors.ts";
import { Button } from "./button.tsx";

/**
 * The track behind the fill, as a tint of the theme's own ink.
 *
 * Its own step rather than `INK_SURFACE_PCT`: that one is for a filled surface
 * behind text (a code span, a message bubble), where a 1.5px rule needs to read
 * as a groove against the page.
 */
const TRACK_TINT_PCT = 12;

/**
 * How far a form's files have got, rendered as a bar.
 *
 * The wait this covers is the one a run cannot describe: a workflow run does not
 * EXIST until its input is stored, so from the moment a form is submitted until
 * the last byte lands there is no run id, no status, and nothing for
 * `<WorkflowProgress>` to read — which for a 200 MB recording is minutes of a
 * page that looks stuck. `useWorkflowSubmit` reports the bytes as they go and
 * this is what draws them.
 *
 * Three things it decides, so a page does not:
 *
 * - **It renders nothing when there is nothing to describe.** `upload` is
 *   undefined before the first byte and again from the moment the last one
 *   lands, so `<UploadProgressBar upload={upload} />` is correct unguarded and a
 *   form with no files never shows a bar at all.
 * - **An unknown total is INDETERMINATE, not zero.** A body whose length the
 *   transport cannot state up front (see `UploadProgress.total`) has no honest
 *   width, and a bar pinned at 0% reads as an upload that is not moving.
 * - **The file is NAMED, and counted when there is more than one.** Files are
 *   sent one after another, so a single bar otherwise appears to restart from
 *   zero partway through with nothing to say why.
 * - **A paused upload SAYS SO, rather than being a bar that stopped.** Those look
 *   identical, which is the whole reason `UploadStatus.paused` exists, and the
 *   fill stops animating so the difference is visible without reading.
 *
 * The pause control appears only when a handler for it is passed. That is not
 * politeness about props: a button whose press does nothing is worse than no
 * button, and a page holding an `upload` it did not produce (a saved status, a
 * parent's state) has nothing to pause.
 *
 * @example
 * ```tsx no-check
 * import { Form, SubmitButton, UploadProgressBar, useWorkflowSubmit, WorkflowFields } from "@alexkroman1/aai-ui";
 * import type { transcribe } from "./agent.ts";
 *
 * function TranscribeForm() {
 *   const { submitForm, upload, pending, error } = useWorkflowSubmit<typeof transcribe>("transcribe");
 *   return (
 *     <Form onSubmit={submitForm} error={error}>
 *       <WorkflowFields workflow="transcribe" />
 *       <UploadProgressBar upload={upload} />
 *       <SubmitButton pending={pending}>Transcribe</SubmitButton>
 *     </Form>
 *   );
 * }
 * ```
 *
 * @param props - Progress-bar props.
 *
 * @public
 */
export function UploadProgressBar({
  upload,
  onPause,
  onResume,
  className,
}: {
  /**
   * What `useWorkflowSubmit` / `useWorkflowStream` report as `upload`.
   * `undefined` renders nothing, so a page may pass its state straight through
   * and never guard the element.
   */
  upload?: UploadStatus | undefined;
  /**
   * The hook's `pauseUpload`. **Pass it together with `onResume`** to get the
   * pause control; pass neither for a bar that only reports. One without the
   * other is a one-way door drawn as a toggle, so the control is hidden unless
   * both are present.
   */
  onPause?: (() => void) | undefined;
  /** The hook's `resumeUpload`. See `onPause` — the two travel together. */
  onResume?: (() => void) | undefined;
  /**
   * **Replaces** the default classes rather than extending them, so a custom
   * chrome is not fighting a default it did not ask for.
   */
  className?: string | undefined;
}): ReactNode {
  const theme = useTheme();
  // Before the early return, because a hook may not be conditional. It costs an
  // id for a render that draws nothing, which is the cheaper of the two.
  const labelId = useId();
  if (!upload) return null;

  const { name, index, count, loaded, total, fraction, paused } = upload;
  // BOTH handlers or neither: a bar that can be paused and not resumed is a
  // one-way door drawn as a toggle.
  const toggle = paused ? onResume : onPause;
  const control = onPause && onResume ? toggle : undefined;
  const percent = fraction === undefined ? undefined : Math.round(fraction * 100);
  // The name and the byte count are the same step — derived once.
  const faint = inkTint(theme.text, theme.surface, INK_FAINT_PCT);

  return (
    <div className={clsx(className ?? "flex flex-col gap-1.5")}>
      <div className="flex items-baseline justify-between gap-4 text-xs">
        <span id={labelId} className="truncate" style={{ color: faint }}>
          {/* The VERB carries the state, because it is the first thing read and
              the one word that distinguishes a paused upload from a stalled one. */}
          {`${paused ? "Paused" : "Uploading"} ${name}${count > 1 ? ` (${index} of ${count})` : ""}`}
        </span>
        <div className="flex shrink-0 items-baseline gap-3">
          <span className="tabular-nums" style={{ color: faint }}>
            {total === undefined
              ? formatBytes(loaded)
              : `${formatBytes(loaded)} of ${formatBytes(total)}`}
          </span>
          {control && (
            <Button
              type="button"
              variant="ghost"
              className="h-6 px-2 text-[0.625rem]"
              onClick={control}
            >
              {paused ? "Resume" : "Pause"}
            </Button>
          )}
        </div>
      </div>
      {/* The ARIA role rather than a `<progress>` element: the bar is two nested
          divs so a theme can colour the fill, and `<progress>`'s own fill is
          reachable only through vendor pseudo-elements that no `style` prop can
          address. `aria-valuenow` is omitted entirely for an unknown total,
          which is how a progressbar states that it is indeterminate. */}
      <div
        role="progressbar"
        // The VISIBLE label, referenced rather than restated: an `aria-label`
        // beside identical on-screen text is the same sentence twice to a
        // screen reader, and two copies of it to keep in step.
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        {...omitUndefined({ "aria-valuenow": percent })}
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: inkTint(theme.text, theme.surface, TRACK_TINT_PCT) }}
      >
        <div
          className={clsx(
            "h-full rounded-full transition-[width] duration-200 ease-out",
            // Nothing to size, so the whole track pulses instead: an
            // indeterminate upload is moving, and a 0%-wide bar denies it.
            // A PAUSED one is not moving, so it must not pulse either — the
            // animation is the only thing saying "still going" when there is no
            // width to watch.
            percent === undefined && !paused && "animate-pulse",
          )}
          style={{
            backgroundColor: theme.primary,
            width: percent === undefined ? "100%" : `${percent}%`,
          }}
        />
      </div>
    </div>
  );
}
