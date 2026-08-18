// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import { omitUndefined } from "@alexkroman1/aai/utils";
import clsx from "clsx";
import { type ReactNode, useId } from "react";
import { useTheme } from "../context.ts";
import type { UploadStatus } from "../use-workflow-form.ts";
import { INK_FAINT_PCT, inkTint } from "./_colors.ts";

/**
 * The track behind the fill, as a tint of the theme's own ink.
 *
 * Its own step rather than `INK_SURFACE_PCT`: that one is for a filled surface
 * behind text (a code span, a message bubble), where a 1.5px rule needs to read
 * as a groove against the page.
 */
const TRACK_TINT_PCT = 12;

/** Bytes per KB/MB/GB step, as a file manager counts them. */
const BYTE_STEP = 1024;
/** Unit labels, largest last — the index is how many times the size divides. */
const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * A size a person can read, because the number that matters is the SCALE.
 *
 * `12.4 MB of 48.0 MB` says how much is left in the terms someone chose the
 * file in; `13002343 of 50331648` says the same thing and answers nothing.
 */
function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= BYTE_STEP && unit < BYTE_UNITS.length - 1) {
    value /= BYTE_STEP;
    unit += 1;
  }
  // Whole bytes are whole; anything the loop divided gets one decimal, so a bar
  // that is visibly moving has a number that visibly moves with it.
  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

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
 *
 * @example
 * ```tsx
 * import { Form, SubmitButton, UploadProgressBar, useWorkflowSubmit, WorkflowFields } from "@alexkroman1/aai-ui";
 *
 * function TranscribeForm() {
 *   const { submit, upload, pending, error } = useWorkflowSubmit("transcribe");
 *   return (
 *     <Form onSubmit={(values) => submit(values)} error={error}>
 *       <WorkflowFields workflow="transcribe" />
 *       <UploadProgressBar upload={upload} />
 *       <SubmitButton pending={pending}>Transcribe</SubmitButton>
 *     </Form>
 *   );
 * }
 * ```
 *
 * @param upload - What `useWorkflowSubmit` reports. `undefined` renders nothing,
 *   so a page may pass its state straight through.
 * @param className - Replaces the default classes rather than extending them,
 *   so a custom chrome is not fighting a default it did not ask for.
 *
 * @public
 */
export function UploadProgressBar({
  upload,
  className,
}: {
  upload?: UploadStatus | undefined;
  className?: string | undefined;
}): ReactNode {
  const theme = useTheme();
  // Before the early return, because a hook may not be conditional. It costs an
  // id for a render that draws nothing, which is the cheaper of the two.
  const labelId = useId();
  if (!upload) return null;

  const { name, index, count, loaded, total, fraction } = upload;
  const percent = fraction === undefined ? undefined : Math.round(fraction * 100);

  return (
    <div className={clsx(className ?? "flex flex-col gap-1.5")}>
      <div className="flex items-baseline justify-between gap-4 text-xs">
        <span
          id={labelId}
          className="truncate"
          style={{ color: inkTint(theme.text, theme.surface, INK_FAINT_PCT) }}
        >
          {count > 1 ? `Uploading ${name} (${index} of ${count})` : `Uploading ${name}`}
        </span>
        <span
          className="shrink-0 tabular-nums"
          style={{ color: inkTint(theme.text, theme.surface, INK_FAINT_PCT) }}
        >
          {total === undefined
            ? formatBytes(loaded)
            : `${formatBytes(loaded)} of ${formatBytes(total)}`}
        </span>
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
            percent === undefined && "animate-pulse",
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
