// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import type { UseDownloadUrlResult } from "../use-download-url.ts";

/**
 * A one-cue caption track for {@link AudioResult}: the words the clip speaks,
 * spanning its whole length.
 *
 * @public
 */
export type AudioResultCaptions = {
  /** The spoken text — the one cue. */
  text: string;
  /** The clip's length, which is where the cue ends. */
  durationMs: number;
  /** The track's `label`. Defaults to the player's `label`. */
  label?: string | undefined;
  /** The track's `srcLang`. Default `"en"`. */
  srcLang?: string | undefined;
};

/**
 * Props of {@link AudioResult}.
 *
 * @public
 */
export type AudioResultProps = {
  /** What {@link useDownloadUrl} returned for the run's audio upload. */
  download: UseDownloadUrlResult;
  /** The name the download link saves as — `"summary.wav"`, `"audit.mp3"`. */
  filename: string;
  /** The player's `aria-label`: what this audio IS — `"Summary read aloud"`. */
  label: string;
  /**
   * The heading over the player — typically the duration and size, which the
   * run's output carries. Omitted, there is no heading.
   */
  heading?: ReactNode | undefined;
  /**
   * The spoken text as a caption track. Omit it deliberately when the same
   * words are rendered in full beside the player (see the component doc);
   * pass it when they are not, or when a real track is what a page needs.
   */
  captions?: AudioResultCaptions | undefined;
  /** Additional CSS class names for the wrapping `<section>`, appended to its own. */
  className?: string | undefined;
  /** Rendered under the player — the spoken text, usually. */
  children?: ReactNode;
};

/**
 * The spoken text as a one-cue WebVTT track, inline.
 *
 * A data URL rather than another stored file: the words are already on the
 * page and the whole track is a few hundred bytes, so a second upload — and a
 * second `download` round trip to read it — would buy nothing.
 */
function captionsUrl(text: string, durationMs: number): string {
  // `hh:mm:ss.mmm`, which is the only timestamp shape WebVTT accepts.
  const end = new Date(durationMs).toISOString().slice(11, 23);
  const vtt = `WEBVTT\n\n00:00:00.000 --> ${end}\n${text}\n`;
  return `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`;
}

/**
 * The player for a file a RUN produced: a heading, the fetch's pending line,
 * its announced error, the `<audio>` with an optional caption track, the
 * download link, and whatever the page renders beneath — the spoken text.
 *
 * Two templates exist because of the audio round trip, and both had written
 * this block over {@link useDownloadUrl} identically: the same pending
 * sentence, the same `role="alert"` paragraph, the same `<audio controls>` over
 * the object URL, the same anchor with `download` set. The `download` attribute
 * works on an object URL because the bytes are already in the tab — it was the
 * `href` that could not carry the agent's bearer token, never the attribute —
 * and that is the whole reason both pages hand this a hook result rather than a
 * path.
 *
 * **A caption track is a judgement, not a default.** `spoken-summary-workflow` passes
 * `captions`: the summary was written before it was spoken, so one cue
 * spanning the clip is an honest transcript of it. `call-audit-workflow` deliberately
 * does not: the spoken text is rendered in full immediately below the player,
 * which is the same information a track would carry. Both are right, which is
 * why the prop is optional in both directions.
 *
 * @example
 * ```tsx
 * import { AudioResult, createWorkflowApi, useDownloadUrl } from "@alexkroman1/aai-ui";
 *
 * const api = createWorkflowApi();
 *
 * function Player({ id, spoken, ms }: { id: string; spoken: string; ms: number }) {
 *   const audio = useDownloadUrl(id, { api });
 *   return (
 *     <AudioResult
 *       download={audio}
 *       filename="summary.wav"
 *       label="Summary read aloud"
 *       heading="Read aloud"
 *       captions={{ text: spoken, durationMs: ms }}
 *     >
 *       <p className="text-sm opacity-70">{spoken}</p>
 *     </AudioResult>
 *   );
 * }
 * ```
 *
 * @param props - See {@link AudioResultProps}.
 *
 * @public
 */
export function AudioResult({
  download,
  filename,
  label,
  heading,
  captions,
  className,
  children,
}: AudioResultProps): ReactNode {
  return (
    <section className={clsx("flex flex-col gap-2", className)}>
      {heading !== undefined && heading !== null && (
        <h3 className="text-sm font-medium opacity-70">{heading}</h3>
      )}
      {download.pending && <p className="text-sm opacity-70">Fetching the audio…</p>}
      {download.error !== undefined && (
        // Announced, the same contract `<WorkflowRunError>` gives the run: the
        // reader waited on this, and a silent failure reads as a player that
        // never arrived.
        <p role="alert" className="text-red-600">
          Could not load the audio: {download.error}
        </p>
      )}
      {download.url !== undefined && (
        <>
          <audio aria-label={label} controls src={download.url} className="w-full">
            {captions && (
              <track
                kind="captions"
                srcLang={captions.srcLang ?? "en"}
                label={captions.label ?? label}
                default
                src={captionsUrl(captions.text, captions.durationMs)}
              />
            )}
          </audio>
          <a href={download.url} download={filename} className="text-sm underline">
            Download {filename}
          </a>
        </>
      )}
      {children}
    </section>
  );
}
