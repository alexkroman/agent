// Copyright 2026 the AAI authors. MIT license.
/**
 * The agent page's favicon, as an inline `data:` URI.
 *
 * Its own module for two reasons. It is a 600-byte encoded blob rather than a
 * value anyone reads, so it would dominate `constants.ts` (which re-exports it,
 * exactly as it does `client-audio-constants.ts`) — and biome's `noSecrets` rule
 * reads percent-encoded SVG path data as high-entropy credentials, so the rule
 * is switched off for THIS FILE in `biome.json`. Scoping that to one file is the
 * point: an inline suppression comment would raise the escape-hatch baseline
 * (`pnpm check:hatches` counts them), and turning the rule off across
 * `constants.ts` would cover a file that has every reason to hold a real
 * credential name one day.
 */

/**
 * The agent page's favicon — the AssemblyAI mark, as a `data:` URI.
 *
 * **Inline rather than a file, and that is the whole point.** Both HTML shells
 * used to link `favicon.ico`, which no build produces and no server serves, so
 * every agent page — voice or static, dev or deployed — logged a 404 on load. A
 * missing icon is cosmetic; a 404 in the console of a page someone is debugging
 * is not, because it is one more thing to rule out.
 *
 * Shipping the file instead means putting it somewhere all four paths can serve
 * it: `aai dev`'s Vite root, the CLI's client build output, `clientDir` on a
 * self-hosted server, and the guest's static assets. A `data:` URI needs none of
 * them and costs no request at all. It is allowed by {@link AGENT_CSP}
 * (`img-src 'self' data:`).
 *
 * SVG rather than a rasterized PNG: it is crisp at every size, it stays
 * diffable, and a browser too old for SVG favicons falls back to its default
 * icon — which is exactly what every browser did before this, with a 404
 * attached. Percent-encoded (not base64) for the same reason, and single quotes
 * inside so the whole thing can sit in a double-quoted HTML attribute.
 *
 * The geometry is the two brand-blue paths of `AaiLogo`'s mark, centered in a
 * square viewBox (the wordmark itself is 141x24 — far too wide for a favicon).
 *
 * @internal
 */
export const AGENT_FAVICON =
  "data:image/svg+xml," +
  "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-2.125 -4 32 32'%3E" +
  "%3Cpath fill='%232545D3' d='M12.2496 0C10.4867 0 8.90488 1.08157 8.26713 2.72302L0 24h6.28017" +
  "L12.7874 7.25245h.0028c.1632-.4082.5628-.69661 1.0297-.69661.467 0 .8665.28841 1.0298.69661h.867" +
  "V3.85532h-1.6094L15.6053 0h-3.3557Z'/%3E" +
  "%3Cpath fill='%23566DE8' d='M8.2677 2.72302C8.87959 1.1483 10.3603.08886 12.0361.00533L12.034 0h.216" +
  "h2.4161h.831c1.7629 0 3.3447 1.08157 3.9825 2.72302L27.7468 24h-6.3876L13.3424 3.36747" +
  "C12.8835 2.35631 11.864 1.65296 10.6801 1.65296c-1.1868 0-2.2084.7068-2.6657 1.72197l.2533-.65191Z'/%3E" +
  "%3C/svg%3E";
