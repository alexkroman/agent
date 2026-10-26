// Copyright 2026 the AAI authors. MIT license.
/**
 * One `ClientTheme` — either form — to the five resolved tokens.
 *
 * Its own module rather than a branch in `context.ts` (which is at the cap)
 * because the derivation is a decision worth a test of its own: the dark
 * neutrals are chosen to keep the components' derived tints (`_colors.ts`'s
 * `inkTint`, which walks from `text` toward the ground) above WCAG AA on a
 * dark surface, exactly as the light defaults do on a light one.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { ClientTheme, ClientThemePreset, ResolvedClientTheme } from "./types.ts";

// A neutral blank canvas: near-white ground, white cards, zinc borders and a
// near-black primary. Deliberately NOT the studio's cream/indigo palette, so an
// unthemed agent previewed inside the studio reads as the user's own app rather
// than more studio chrome. Overridable per client via `mountClient({ theme })`.
export const DEFAULT_THEME: ResolvedClientTheme = Object.freeze({
  bg: "#FAFAFA",
  primary: "#18181B",
  text: "#18181B",
  surface: "#FFFFFF",
  border: "#E4E4E7",
});

/**
 * The dark ground the preset form derives: the light defaults' zinc scale
 * read from the other end (zinc-950 ground, zinc-900 cards, zinc-800 borders,
 * near-white ink), so `inkTint` lands on the same steps mirrored.
 */
const DARK_NEUTRALS: Omit<ResolvedClientTheme, "primary"> = Object.freeze({
  bg: "#09090B",
  surface: "#18181B",
  text: "#FAFAFA",
  border: "#27272A",
});

/** Is this the preset form? Only it carries `mode`; `{ primary }` alone is both and resolves alike. */
function isPreset(theme: ClientTheme): theme is ClientThemePreset {
  return "mode" in theme && theme.mode !== undefined;
}

/**
 * The theme without its BLANK tokens, each one warned about.
 *
 * `primary: ""` used to be written verbatim as `--aai-primary: ;`, an empty
 * custom property, so every primary-coloured control went transparent with
 * nothing anywhere saying why. An empty string is not a colour and not "unset"
 * either, so it is dropped — the default fills the hole as for an `undefined`
 * token — and said once per resolve. Colour SYNTAX is not validated: the
 * browser's own parsing is the authority on what a colour is.
 */
function withoutBlankTokens<T extends Record<string, unknown>>(theme: T): T {
  const kept = { ...theme };
  for (const [token, value] of Object.entries(theme)) {
    if (value !== "") continue;
    console.warn(
      `[aai-ui] theme.${token} is "" and was ignored; the default is used. ` +
        "Pass a colour, or leave the token out.",
    );
    delete kept[token];
  }
  return kept;
}

/**
 * Every token filled in: the preset's neutrals under its accent, or the given
 * tokens over the defaults. `undefined` is the default theme itself. A token
 * given as `""` is ignored with a warning ({@link withoutBlankTokens}).
 */
export function resolveClientTheme(theme: ClientTheme | undefined): ResolvedClientTheme {
  if (theme === undefined) return DEFAULT_THEME;
  if (isPreset(theme)) {
    const neutrals = theme.mode === "dark" ? DARK_NEUTRALS : DEFAULT_THEME;
    const { primary } = withoutBlankTokens({ primary: theme.primary });
    // A blank accent falls back to the ground's INK, which on the light ground
    // is the default primary and on the dark one stays visible against it.
    return { ...neutrals, primary: primary ?? neutrals.text };
  }
  // `omitUndefined` rather than a bare spread: an explicit `undefined` token
  // (an options bag) is a hole the default fills, not a value.
  return { ...DEFAULT_THEME, ...omitUndefined(withoutBlankTokens(theme)) };
}
