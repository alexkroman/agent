// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:session` epoch 2.
 *
 * Epoch 2 added `useUserTranscript` — the caller's in-progress turn, with
 * `null` (silent) and `""` (speech detected, no words back yet) told apart, so
 * a custom chrome renders the indicator from the moment the caller starts
 * speaking rather than from the first word. Everything epoch 1 could express
 * still compiles (see `./v1.tsx`, retained for that reason); this file covers
 * only what is new.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  TRANSCRIBING_PLACEHOLDER,
  type UseUserTranscriptResult,
  useUserTranscript,
} from "../../../index.ts";

/** The row a custom chrome renders while the caller holds the turn. */
export function LiveTranscript() {
  const { speaking, text }: UseUserTranscriptResult = useUserTranscript();
  if (!speaking) return null;
  return <div className="italic opacity-60">{text}</div>;
}

/** The raw partial, for a chrome that supplies its own placeholder. */
export function RawTranscript() {
  const { partial } = useUserTranscript();
  const shown: string | null = partial;
  if (shown === null) return null;
  return <div>{shown === "" ? "listening…" : shown}</div>;
}

/** The placeholder is a named constant, so a spec can assert against it. */
export function placeholder(): string {
  return TRANSCRIBING_PLACEHOLDER;
}
