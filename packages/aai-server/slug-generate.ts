// Copyright 2026 the AAI authors. MIT license.
/**
 * Server-generated slugs — the one generator behind every name the platform
 * mints, whether the CLI deploys without a slug (`POST /deploy`) or the
 * studio auto-creates a project from the first chat prompt. Clients never
 * generate names; they hit the server and get one back, so the format can
 * evolve in one place.
 *
 * Shape: `<base>-<suffix>` — a readable base (prompt-derived words, or
 * human-id's word triple when there is nothing to derive from) plus a short
 * random suffix, v0-style (`contact-form-x7k2mq`). The suffix is what makes
 * generated names practically collision-free, so a retry loop around
 * creation is a formality rather than a strategy.
 */

import { randomInt } from "node:crypto";
import { VALID_SLUG_RE } from "@alexkroman1/aai/utils";
import slugifyLib from "@sindresorhus/slugify";
import { humanId } from "human-id";

export const SLUG_SUFFIX_LENGTH = 6;

/** Matches the suffix a generated slug ends with (after the last `-`). */
export const SLUG_SUFFIX_RE = new RegExp(`-[a-z0-9]{${SLUG_SUFFIX_LENGTH}}$`);

/** Max length of the readable base, leaving room for `-<suffix>` within 64. */
const MAX_BASE_LENGTH = 64 - 1 - SLUG_SUFFIX_LENGTH;

/**
 * Cryptographically random lowercase-base36 suffix. Base36 rather than a
 * nanoid-style base62: the slug grammar (`VALID_SLUG_RE`) has no upper
 * case, so the wider alphabet would just be case-folded away.
 */
export function slugSuffix(): string {
  let out = "";
  for (let i = 0; i < SLUG_SUFFIX_LENGTH; i += 1) out += randomInt(36).toString(36);
  return out;
}

/**
 * Generate a slug from an optional readable base. The base must already be
 * slug-shaped-ish (lowercase words joined by `-`); anything unusable falls
 * back to human-id words so the result always satisfies `VALID_SLUG_RE`.
 */
export function generatedSlug(base?: string): string {
  const trimmed = (base ?? "").slice(0, MAX_BASE_LENGTH).replace(/-+$/, "");
  const usable = trimmed && VALID_SLUG_RE.test(`${trimmed}-x`) ? trimmed : humanWords();
  return `${usable}-${slugSuffix()}`;
}

function humanWords(): string {
  return humanId({ separator: "-", capitalize: false }).slice(0, MAX_BASE_LENGTH);
}

/**
 * Readable base from a human-given display name ("Dice Roller" →
 * `dice-roller`). This is what slugless CLI deploys seed `generatedSlug`
 * with: the agent already has a name in its config, so the URL should
 * carry it rather than random words. Same slugifier (transliterating, not
 * stripping) and `decamelize: false` posture as the studio's typed-name
 * normalization — the name is an identifier, not a symbol to prettify.
 */
export function slugBaseFromName(name: string): string {
  return slugifyLib(name, { decamelize: false }).slice(0, MAX_BASE_LENGTH);
}
