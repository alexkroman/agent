// Copyright 2026 the AAI authors. MIT license.
/**
 * The Content-Security-Policy every agent UI is served under.
 *
 * Its own module rather than a line in `constants.ts` for the reason the
 * client-audio budgets are: that file is a table of magic NUMBERS, this is one
 * header, and the argument behind a single directive here is longer than the
 * whole header. `constants.ts` re-exports it, so the import path is unchanged.
 *
 * @module agent-csp
 */

/**
 * Single source of truth — used by `secureHeaders` middleware and
 * per-response CSP headers across self-hosted and platform agent UIs.
 *
 * **`media-src` must spell out `blob:` and `data:`, and its absence is not a
 * tightening — it is a page that half works.** A workflow app cannot put an
 * upload's URL on an `<audio>`: the byte route takes the same `Authorization`
 * header every other route does and no `src` attribute can send one, so
 * `api.download(id)` reads the bytes and hands the element a `URL.createObjectURL`
 * blob (see `sdk/workflow-upload-client.ts`). With no `media-src`, media falls
 * back to `default-src 'self'` and a `blob:` URL is not `'self'` — even one this
 * document minted. `img-src` already had to name `data:` for the identical reason.
 *
 * What made it survive review is that it breaks only ONE of the two consumers of
 * the same URL: `<a href={objectUrl} download>` is a download rather than a
 * fetch, so it is checked by no fetch directive and keeps working. The report
 * reads as "the audio is broken", which sends you to the WAV header and the
 * stored MIME type, and both are fine — anything about the bytes would have
 * broken the link too.
 *
 * `data:` is here for the caption `<track>`, whose fetch destination CSP also
 * governs with `media-src` — `spoken-summary` serves a one-cue WebVTT inline
 * rather than paying a second upload for a few hundred bytes. Neither value
 * widens much: a `blob:` URL is same-origin by construction, and both are scoped
 * to media and text-track loads on a page that already permits `data:` images.
 *
 * @internal
 */
export const AGENT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval' blob:; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "connect-src 'self' wss: ws:; img-src 'self' data:; " +
  "media-src 'self' blob: data:; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "object-src 'none'; base-uri 'self'";
