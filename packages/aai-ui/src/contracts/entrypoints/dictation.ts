// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `dictation`.
 *
 * Speak into a text box: the `useDictation` hook records one clip and hands it
 * to a `transcribe` callback — `dictationTranscriber` for a server answering
 * the SDK's `handleDictationRequest`, which calls the dictation API under its
 * key — then hands the words back for `appendDictation` to add to a draft.
 *
 * Its own capability for the reason `push-to-talk` is: it is not a session at
 * all, so a change to it is not an epoch of every session.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  appendDictation,
  type DictationTranscriberOptions,
  dictationTranscriber,
  type UseDictationOptions,
  type UseDictationResult,
  useDictation,
} from "../../index.ts";
