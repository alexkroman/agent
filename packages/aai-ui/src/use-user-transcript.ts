// Copyright 2026 the AAI authors. MIT license.
/**
 * `useUserTranscript` — what the caller is saying RIGHT NOW, read correctly.
 *
 * `SessionSnapshot.userTranscript` is `string | null`, and the two falsy values
 * mean different things:
 *
 * - `null` — nobody is speaking. There is no partial turn.
 * - `""` — speech HAS been detected and no words have come back yet. A live
 *   session sits here for a few hundred milliseconds at the start of every turn.
 *
 * Read as one falsy check, those collapse and the indicator never appears at the
 * start of a turn — which is the moment it is for. So every custom chrome writes
 * `transcript !== null && (transcript === "" ? "…" : transcript)`, three
 * templates did exactly that, and each one re-derived a protocol distinction
 * from the type rather than from anything that told them.
 *
 * This is the same distinction as two named booleans, so a component can say
 * what it means: render on `speaking`, show `text`, and use the SDK's own
 * placeholder when there is nothing to show yet.
 */

import { useMemo } from "react";
import { useSessionSelector } from "./context.ts";

/**
 * Placeholder for "listening, no words yet" — the `""` case above.
 *
 * A one-character ellipsis rather than three dots, because it is read by a
 * screen reader as an ellipsis and it does not reflow the row when the first
 * real word replaces it.
 *
 * On `@alexkroman1/aai-ui/internal`, not the root: no public signature names
 * it, and a `client.tsx` rendering its own transcript row compares against the
 * character. `UseUserTranscriptResult.text` therefore spells the value out
 * rather than linking here.
 *
 * @internal
 */
export const TRANSCRIBING_PLACEHOLDER = "…";

/** What {@link useUserTranscript} returns. */
export interface UseUserTranscriptResult {
  /**
   * True while the caller holds the turn — from speech detection to the final
   * transcript. This is the flag a live-transcript row renders on.
   */
  speaking: boolean;
  /**
   * The words so far, or a one-character ellipsis (`…`) while there are none.
   * Empty string when nobody is speaking.
   */
  text: string;
  /**
   * The raw partial: the words so far, `""` while there are none, and `null`
   * when nobody is speaking. For a chrome that wants to render its own
   * placeholder (or none).
   */
  partial: string | null;
}

/**
 * Subscribe to the caller's in-progress turn.
 *
 * Narrowly subscribed — a component using this re-renders at STT-partial rate,
 * which is exactly what it is for and exactly what a whole-page `useSession()`
 * should not do.
 *
 * @example
 * ```tsx
 * import { useUserTranscript } from "@alexkroman1/aai-ui";
 *
 * function LiveTranscript() {
 *   const { speaking, text } = useUserTranscript();
 *   if (!speaking) return null;
 *   return <div className="italic opacity-60">{text}</div>;
 * }
 * ```
 *
 * @public
 */
export function useUserTranscript(): UseUserTranscriptResult {
  const partial = useSessionSelector((snapshot) => snapshot.userTranscript);
  // Memoized on the one field it derives from: this re-runs at STT-partial
  // rate, and a fresh object each time defeats any `memo()`ed child or
  // `useMemo` a caller keys on the result.
  return useMemo(
    () => ({ speaking: partial !== null, text: displayText(partial), partial }),
    [partial],
  );
}

/** The three cases, spelled out: silent, detected-but-wordless, and words. */
function displayText(partial: string | null): string {
  if (partial === null) return "";
  return partial === "" ? TRANSCRIBING_PLACEHOLDER : partial;
}
